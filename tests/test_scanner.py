"""Tests for the nmap client and its helpers in scanner.py."""
from __future__ import annotations

import logging
import subprocess
import threading
from unittest.mock import patch

import nmap
import pytest

from custom_components.network_scanner import scanner
from custom_components.network_scanner.scanner import (
    NMAP_ARGS,
    NMAP_TIMEOUT,
    UNKNOWN_DEVICE,
    MacMappingError,
    NetworkScannerClient,
    NmapTimeoutError,
    NmapUnavailableError,
    ScanStoppedError,
    check_nmap,
    normalize_ip_range,
    normalize_mac,
    parse_mac_mappings,
    validate_ip_range,
)

from .common import (
    IP_RANGE,
    MAC_MAPPINGS,
    SWEEP_DEVICES,
    FakeNmap,
    FakeResolver,
    nmap_xml,
)


def make_client(mappings: str = MAC_MAPPINGS) -> NetworkScannerClient:
    return NetworkScannerClient(IP_RANGE, parse_mac_mappings(mappings))


# ---------------------------------------------------------------- IP ranges


def test_normalize_ip_range_collapses_whitespace() -> None:
    assert normalize_ip_range("  192.168.1.0/24\t 10.0.0.0/24\n") == "192.168.1.0/24 10.0.0.0/24"


@pytest.mark.parametrize(
    "ip_range",
    [
        "192.168.1.0/24",
        "192.168.1.1-254",
        "10.0.0.*",
        "192.168.1.1,5,9",
        "192.168.1.0/24 10.0.0.0/24",
        "printer.lan",
        "printer.lan/24",
        # MAX_TARGETS exactly: 65,536 addresses.
        "192.168.0.0/16",
        "10.0-255.0-255.1",
        "192.168.0.0/17 192.168.128.0/17",
    ],
)
def test_validate_ip_range_accepts_nmap_targets(ip_range: str) -> None:
    assert validate_ip_range(ip_range)


@pytest.mark.parametrize(
    "ip_range",
    [
        "",
        "   ",
        # Anything nmap would read as an option must be rejected.
        "-oN /tmp/out 192.168.1.0/24",
        "192.168.1.0/24 --script=http-title",
        "192.168.1.0/24;reboot",
        "$(reboot)",
        "'192.168.1.1'",
        # The sweep runs without -6 and only reads IPv4 addresses, so an IPv6
        # range would always come back empty.
        "fe80::1",
        "fd00::/120",
        "192.168.1.0/24 fd00::1",
        # Too big to sweep within NMAP_TIMEOUT: it would fail on every scan.
        "0.0.0.0/0",
        "10.0.0.0/8",
        "192.168.0.0/15",
        "10.*.*.*",
        "10.0-255.0-255.0-255",
        "192.168.0.0/16 10.0.0.1",
        "printer.lan/8",
        # Not a prefix length.
        "10.0.0.0/33",
        "10.0.0.0/",
    ],
)
def test_validate_ip_range_rejects_non_targets(ip_range: str) -> None:
    assert not validate_ip_range(ip_range)


# ---------------------------------------------------------------- MAC mappings


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff"),
        (" aa:bb:cc:dd:ee:ff ", "aa:bb:cc:dd:ee:ff"),
        ("aa-bb-cc-dd-ee-ff", "aa:bb:cc:dd:ee:ff"),
        ("aabb.ccdd.eeff", "aa:bb:cc:dd:ee:ff"),
        ("AABBCCDDEEFF", "aa:bb:cc:dd:ee:ff"),
        ("", ""),
        ("aa:bb:cc:dd:ee", ""),
        ("aa:bb:cc:dd:ee:ff:00", ""),
        ("gg:bb:cc:dd:ee:ff", ""),
        ("not a mac", ""),
    ],
)
def test_normalize_mac(raw: str, expected: str) -> None:
    assert normalize_mac(raw) == expected


def test_parse_mac_mappings() -> None:
    text = """
        # printers
        BC-14-14-F1-81-1B ; Brother Printer ; Brother Industries

        aa:bb:cc:dd:ee:ff;Living room TV
        001132000100;NAS;
    """
    assert parse_mac_mappings(text) == {
        "bc:14:14:f1:81:1b": ("Brother Printer", "Brother Industries"),
        "aa:bb:cc:dd:ee:ff": ("Living room TV", UNKNOWN_DEVICE),
        "00:11:32:00:01:00": ("NAS", UNKNOWN_DEVICE),
    }


@pytest.mark.parametrize(
    "line",
    ["not-a-mac;Printer", "aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff;;Brother"],
)
def test_parse_mac_mappings_skips_malformed_lines(
    line: str, caplog: pytest.LogCaptureFixture
) -> None:
    mapping = parse_mac_mappings(f"{line}\nbc:14:14:f1:81:1b;Printer")
    assert mapping == {"bc:14:14:f1:81:1b": ("Printer", UNKNOWN_DEVICE)}
    assert "Ignoring malformed MAC mapping line 1" in caplog.text


def test_parse_mac_mappings_strict_reports_line_number() -> None:
    text = "# header\n\nbc:14:14:f1:81:1b;Printer\nnot-a-mac;TV"
    with pytest.raises(MacMappingError) as err:
        parse_mac_mappings(text, strict=True)
    assert err.value.line_number == 4
    assert err.value.line == "not-a-mac;TV"


@pytest.mark.parametrize(
    "text",
    [
        # A fourth field used to be dropped without a word.
        "aa:bb:cc:dd:ee:ff;TV;Sony;Living room",
        # The same MAC written two ways: the last line used to win silently.
        "aa:bb:cc:dd:ee:ff;TV\nAA-BB-CC-DD-EE-FF;Printer",
    ],
)
def test_parse_mac_mappings_strict_rejects_lines_that_would_lose_data(text: str) -> None:
    with pytest.raises(MacMappingError) as err:
        parse_mac_mappings(text, strict=True)
    assert err.value.line_number == text.count("\n") + 1


def test_parse_mac_mappings_warns_about_lines_that_lose_data(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Setup parses leniently, so mappings saved before the strict checks still load."""
    text = "aa:bb:cc:dd:ee:ff;TV;Sony;Living room\nAA-BB-CC-DD-EE-FF;Printer"
    assert parse_mac_mappings(text) == {"aa:bb:cc:dd:ee:ff": ("Printer", UNKNOWN_DEVICE)}
    assert caplog.text.count("has extra fields or repeats a MAC") == 2


# ---------------------------------------------------------------- reverse DNS


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Router.LAN.", "router"),
        ("my_host-1.example.com", "my_host-1"),
        ("living room tv.local", "livingroomtv"),
        # A router-made PTR name that spells out the address is still a name.
        ("192-168-1-23.lan", "192-168-1-23"),
        # Addresses are not names (they used to become "192").
        ("192.168.1.23", None),
        ("fe80::1", None),
        ("23.1.168.192.in-addr.arpa.", None),
        ("...", None),
        ("", None),
        (None, None),
    ],
)
def test_short_label(name: str | None, expected: str | None) -> None:
    assert scanner._short_label(name) == expected


def test_resolve_hostnames(mock_reverse_dns: FakeResolver) -> None:
    result = scanner._resolve_hostnames(["192.168.1.1", "192.168.1.9", "192.168.1.77"])
    assert result == {
        "192.168.1.1": "router",
        "192.168.1.9": "living-room-tv",
        "192.168.1.77": None,
    }


def test_resolve_hostnames_empty_starts_no_threads() -> None:
    with patch.object(scanner, "ThreadPoolExecutor") as pool:
        assert scanner._resolve_hostnames([]) == {}
    pool.assert_not_called()


def test_resolve_hostnames_survives_unexpected_resolver_errors() -> None:
    with patch.object(scanner.socket, "gethostbyaddr", side_effect=UnicodeError("bad label")):
        assert scanner._resolve_hostnames(["192.168.1.1"]) == {"192.168.1.1": None}


def test_resolve_hostnames_abandons_slow_lookups(
    mock_reverse_dns: FakeResolver, caplog: pytest.LogCaptureFixture
) -> None:
    """A hung lookup is dropped at the batch deadline instead of stalling the scan."""
    release = threading.Event()

    def lookup(ip: str):
        if ip == "192.168.1.9":
            release.wait(timeout=5)
        return mock_reverse_dns.gethostbyaddr(ip)

    caplog.set_level(logging.DEBUG, logger=scanner.__name__)
    try:
        with (
            patch.object(scanner, "RDNS_BATCH_TIMEOUT", 0.2),
            patch.object(scanner.socket, "gethostbyaddr", side_effect=lookup),
        ):
            result = scanner._resolve_hostnames(["192.168.1.1", "192.168.1.9"])
    finally:
        release.set()

    assert result == {"192.168.1.1": "router"}
    assert "Reverse-DNS gave up on 1 of 2 hosts" in caplog.text


# ---------------------------------------------------------------- nmap


def test_check_nmap_returns_version() -> None:
    assert check_nmap() == "7.95"


def test_check_nmap_unavailable(mock_nmap: FakeNmap) -> None:
    mock_nmap.available = False
    with pytest.raises(NmapUnavailableError, match="not found"):
        check_nmap()


def test_client_requires_nmap(mock_nmap: FakeNmap) -> None:
    mock_nmap.available = False
    with pytest.raises(NmapUnavailableError):
        make_client()


def test_scan(mock_nmap: FakeNmap) -> None:
    assert make_client().scan() == SWEEP_DEVICES
    assert mock_nmap.scans == [
        {"args": ["nmap", "-oX", "-", IP_RANGE, *NMAP_ARGS.split()], "timeout": NMAP_TIMEOUT}
    ]


def test_scan_passes_each_target_as_one_argument(mock_nmap: FakeNmap) -> None:
    NetworkScannerClient("192.168.1.0/24  10.0.0.1-9", {}).scan()
    assert mock_nmap.scans[0]["args"][3:5] == ["192.168.1.0/24", "10.0.0.1-9"]


def test_scan_only_resolves_hosts_nmap_did_not_name(mock_reverse_dns: FakeResolver) -> None:
    make_client().scan()
    # 192.168.1.100 already has a PTR name in the nmap output.
    assert sorted(mock_reverse_dns.lookups) == [
        "192.168.1.1",
        "192.168.1.10",
        "192.168.1.23",
        "192.168.1.9",
    ]


def test_scan_when_the_resolver_echoes_addresses() -> None:
    """musl libc, used by Home Assistant's container image, answers a reverse
    lookup with no PTR record with the address itself. Every device used to
    get the hostname "192", which the card then showed as its name."""
    with patch.object(scanner.socket, "gethostbyaddr", side_effect=lambda ip: (ip, [], [ip])):
        devices = make_client().scan()
    # Only the name nmap reported survives.
    assert [d["hostname"] for d in devices] == [None, None, None, None, "nas"]


def test_scan_with_no_mappings() -> None:
    devices = make_client("").scan()
    assert {d["name"] for d in devices} == {UNKNOWN_DEVICE}


def test_scan_timeout_kills_and_reaps_nmap(mock_nmap: FakeNmap) -> None:
    """python-nmap killed a timed-out nmap without reaping it, leaving a zombie."""
    mock_nmap.error = subprocess.TimeoutExpired("nmap", NMAP_TIMEOUT)
    with pytest.raises(NmapTimeoutError, match="did not finish within 600 seconds"):
        make_client().scan()
    [process] = mock_nmap.processes
    assert process.killed
    assert process.reaped


def test_scan_errors_carry_nmap_stderr(mock_nmap: FakeNmap) -> None:
    """The coordinator turns scan errors into UpdateFailed, so they must not be swallowed."""
    mock_nmap.xml = ""
    mock_nmap.stderr = "Failed to open device eth9\nQUITTING!\n"
    with pytest.raises(nmap.PortScannerError, match="Failed to open device eth9"):
        make_client().scan()


def test_stop_kills_a_running_scan(mock_nmap: FakeNmap) -> None:
    """Unloading the entry must not leave its nmap sweeping for up to NMAP_TIMEOUT."""
    client = make_client()
    mock_nmap.gate = threading.Event()
    errors: list[BaseException] = []

    def run() -> None:
        try:
            client.scan()
        except BaseException as err:  # noqa: BLE001 - collected for the assert
            errors.append(err)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        for _ in range(500):
            if mock_nmap.scans:
                break
            thread.join(timeout=0.01)
        assert len(mock_nmap.scans) == 1, "scan never reached nmap"
        client.stop()
        thread.join(timeout=5)
    finally:
        mock_nmap.gate.set()
        thread.join(timeout=5)

    assert [type(err) for err in errors] == [ScanStoppedError]
    [process] = mock_nmap.processes
    assert process.killed
    assert process.reaped


def test_stopped_client_does_not_start_nmap(mock_nmap: FakeNmap) -> None:
    client = make_client()
    client.stop()
    with pytest.raises(ScanStoppedError):
        client.scan()
    assert mock_nmap.processes == []


def test_stop_while_nmap_is_starting(mock_nmap: FakeNmap) -> None:
    """stop() can land between Popen and the scanner recording the process."""
    client = make_client()

    def popen(args, **kwargs):
        client.stop()
        return mock_nmap.popen(args, **kwargs)

    with (
        patch.object(scanner, "Popen", side_effect=popen),
        pytest.raises(ScanStoppedError),
    ):
        client.scan()
    [process] = mock_nmap.processes
    assert process.killed
    assert mock_nmap.scans == []


def test_scan_skips_a_host_that_fails_to_parse() -> None:
    client = make_client()
    real = client._device_info_from_mac

    def device_info(mac: str) -> tuple[str, str]:
        if mac == "10:27:F5:00:00:01":
            raise ValueError("boom")
        return real(mac)

    with patch.object(client, "_device_info_from_mac", side_effect=device_info):
        devices = client.scan()
    assert [d["ip"] for d in devices] == [d["ip"] for d in SWEEP_DEVICES[1:]]


def test_scan_without_macs_warns_once(
    mock_nmap: FakeNmap, caplog: pytest.LogCaptureFixture
) -> None:
    """Unprivileged nmap sees hosts but no MACs; say why the list is empty, once."""
    mock_nmap.xml = nmap_xml({"ipv4": "192.168.1.1"}, {"ipv4": "192.168.1.2"})
    client = make_client()

    assert client.scan() == []
    assert client.scan() == []
    assert caplog.text.count("reported no MAC addresses") == 1
    assert "CAP_NET_RAW" in caplog.text


def test_scan_of_empty_network_does_not_warn(
    mock_nmap: FakeNmap, caplog: pytest.LogCaptureFixture
) -> None:
    mock_nmap.xml = nmap_xml()
    assert make_client().scan() == []
    assert "reported no MAC addresses" not in caplog.text


def test_concurrent_scans_are_serialized(mock_nmap: FakeNmap) -> None:
    """An interval refresh and a Scan now must not share the PortScanner at once."""
    client = make_client()
    mock_nmap.gate = threading.Event()
    first = threading.Thread(target=client.scan)
    second = threading.Thread(target=client.scan)

    first.start()
    try:
        for _ in range(500):
            if mock_nmap.scans:
                break
            first.join(timeout=0.01)
        assert len(mock_nmap.scans) == 1, "first scan never reached nmap"
        second.start()
        second.join(timeout=0.2)
        assert len(mock_nmap.scans) == 1, "second scan entered nmap while the first was running"
    finally:
        mock_nmap.gate.set()
        for thread in (first, second):
            if thread.ident is not None:
                thread.join(timeout=5)
    assert len(mock_nmap.scans) == 2
