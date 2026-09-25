"""Pure nmap scanning logic, isolated from Home Assistant internals.

This module must not import anything from homeassistant, and must not touch
the event loop. All calls into it run inside the executor via the coordinator.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, TypedDict

import nmap

_LOGGER = logging.getLogger(__name__)

# nmap args:
#   -sn                : ping scan only, no port scan
#   -n                 : skip DNS (we do our own reverse-DNS, in parallel, only
#                        for hosts that actually answered)
#   -T4                : aggressive timing template
#   --min-parallelism  : probe many hosts at once
#   --min-rate         : floor on probes/sec, so a quiet subnet finishes fast
#   --max-retries 1    : don't linger on unresponsive hosts
#
# Note: --host-timeout is deliberately absent. With -sn there is no port scan,
# so an unreachable host is decided in milliseconds and the ceiling almost never
# binds; when it does bind it drops slow-but-live hosts, which combined with
# --max-retries 1 made the device count flap between scans.
NMAP_ARGS = "-sn -n -T4 --min-parallelism 128 --min-rate 500 --max-retries 1"

# Hard ceiling on a single nmap run. A hung nmap process would otherwise pin an
# executor thread forever and the coordinator would never update again.
NMAP_TIMEOUT = 600  # seconds

# Reverse-DNS is done concurrently across discovered hosts. Note that
# socket.setdefaulttimeout() does NOT bound gethostbyaddr(): it only applies to
# socket objects, while name resolution goes through the libc resolver whose
# timeout comes from resolv.conf. The only reliable bound is to wait on the
# pool for a fixed time and abandon whatever has not finished.
RDNS_MAX_WORKERS = 32
RDNS_BATCH_TIMEOUT = 10.0  # seconds, for the whole batch

_MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")

# One nmap target token: CIDR (10.0.0.0/24), octet ranges (10.0.0.1-254),
# wildcards (10.0.0.*), plain IPv4/IPv6, or a hostname. python-nmap passes the
# string through shlex.split, so anything outside this set, or anything that
# starts with "-" and would be read as an nmap flag, is rejected up front.
_IP_RANGE_TOKEN_RE = re.compile(r"^[A-Za-z0-9.:*/,_][A-Za-z0-9.:*/,_-]*$")

UNKNOWN_DEVICE = "Unknown Device"
UNKNOWN_VENDOR = "Unknown"


class DeviceInfo(TypedDict):
    """One discovered device."""

    ip: str
    mac: str
    name: str
    type: str
    vendor: str
    hostname: str | None


MacMapping = dict[str, tuple[str, str]]


class NmapUnavailableError(Exception):
    """The nmap binary could not be found or executed."""


class MacMappingError(ValueError):
    """A MAC mapping line could not be parsed."""

    def __init__(self, line_number: int, line: str) -> None:
        super().__init__(f"Invalid MAC mapping on line {line_number}: {line!r}")
        self.line_number = line_number
        self.line = line


def normalize_ip_range(ip_range: str) -> str:
    """Collapse whitespace so equivalent ranges compare equal."""
    return " ".join(ip_range.split())


def validate_ip_range(ip_range: str) -> bool:
    """Return True if every whitespace-separated target looks like an nmap target."""
    tokens = ip_range.split()
    return bool(tokens) and all(_IP_RANGE_TOKEN_RE.match(token) for token in tokens)


def normalize_mac(mac: str) -> str:
    """Return a MAC in lowercase colon-separated form, or '' if not a MAC."""
    cleaned = mac.strip().lower().replace("-", ":").replace(".", "")
    if ":" not in cleaned and len(cleaned) == 12:
        cleaned = ":".join(cleaned[i : i + 2] for i in range(0, 12, 2))
    return cleaned if _MAC_RE.match(cleaned) else ""


def parse_mac_mappings(text: str, *, strict: bool = False) -> MacMapping:
    """Parse ``mac;name[;manufacturer]`` lines into a lookup dict.

    Blank lines and lines starting with ``#`` are ignored. When ``strict`` is
    set, a malformed line raises MacMappingError instead of being skipped.
    """
    mapping: MacMapping = {}
    for line_number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split(";")]
        mac = normalize_mac(parts[0]) if parts else ""
        if not mac or len(parts) < 2 or not parts[1]:
            if strict:
                raise MacMappingError(line_number, raw)
            _LOGGER.warning("Ignoring malformed MAC mapping line %d: %r", line_number, raw)
            continue
        manufacturer = parts[2] if len(parts) > 2 and parts[2] else UNKNOWN_DEVICE
        mapping[mac] = (parts[1], manufacturer)
    return mapping


def check_nmap() -> str:
    """Verify the nmap binary is usable and return its version string.

    Blocking: spawns ``nmap -V``. Run in the executor.
    """
    try:
        scanner = nmap.PortScanner()
    except nmap.PortScannerError as err:
        raise NmapUnavailableError(str(err)) from err
    return ".".join(str(part) for part in scanner.nmap_version())


def _is_address(name: str) -> bool:
    """True for an IP address, or the reverse-lookup (.arpa) name of one."""
    if name.lower().endswith((".in-addr.arpa", ".ip6.arpa")):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def _short_label(name: str | None) -> str | None:
    """Return lowercase host label before first dot, cleaned, or None.

    An address is not a name. When a reverse lookup finds no PTR record,
    some resolvers return the address itself instead of failing - musl libc
    does, and Home Assistant's container image uses it - and "192.168.1.23"
    must not become the hostname "192".
    """
    if not name:
        return None
    name = name.strip().rstrip(".")
    if _is_address(name):
        return None
    short = name.split(".", 1)[0].lower()
    short = re.sub(r"[^a-z0-9_-]", "", short)
    return short or None


def _fast_rdns(ip: str) -> str | None:
    """Reverse-DNS one IP; returns a cleaned short label or None. Never raises."""
    try:
        host, _, _ = socket.gethostbyaddr(ip)
    except Exception:  # noqa: BLE001 - resolver errors are expected
        return None
    return _short_label(host)


def _resolve_hostnames(ips: list[str]) -> dict[str, str | None]:
    """Reverse-DNS a batch of IPs concurrently, bounded by RDNS_BATCH_TIMEOUT.

    Lookups still running when the deadline passes are abandoned; their
    threads finish on their own in the background and are not joined.
    """
    if not ips:
        return {}

    pool = ThreadPoolExecutor(
        max_workers=min(RDNS_MAX_WORKERS, len(ips)),
        thread_name_prefix="network_scanner_rdns",
    )
    try:
        futures = {ip: pool.submit(_fast_rdns, ip) for ip in ips}
        done, pending = wait(futures.values(), timeout=RDNS_BATCH_TIMEOUT)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    if pending:
        _LOGGER.debug(
            "Reverse-DNS gave up on %d of %d hosts after %.0fs",
            len(pending),
            len(ips),
            RDNS_BATCH_TIMEOUT,
        )
    return {ip: future.result() for ip, future in futures.items() if future in done}


def _sort_key(device: DeviceInfo) -> tuple[int, int]:
    addr = ipaddress.ip_address(device["ip"])
    return (addr.version, int(addr))


class NetworkScannerClient:
    """Blocking nmap client. One instance per config entry."""

    def __init__(self, ip_range: str, mac_mapping: MacMapping) -> None:
        self.ip_range = ip_range
        self.mac_mapping = mac_mapping
        self._lock = threading.Lock()
        self._warned_no_mac = False
        try:
            self.nm = nmap.PortScanner()
        except nmap.PortScannerError as err:
            raise NmapUnavailableError(str(err)) from err
        _LOGGER.debug("Network Scanner client initialized for %s", ip_range)

    def _device_info_from_mac(self, mac: str) -> tuple[str, str]:
        return self.mac_mapping.get(mac.lower(), (UNKNOWN_DEVICE, UNKNOWN_DEVICE))

    def scan(self) -> list[DeviceInfo]:
        """Run an nmap ping scan and return the list of discovered devices.

        Blocking. Must be called from the executor, never from the event loop.
        The lock serialises scans that the coordinator's interval refresh and
        a user-triggered refresh could otherwise run at the same time on the
        shared PortScanner instance.
        """
        with self._lock:
            return self._scan_locked()

    def _scan_locked(self) -> list[DeviceInfo]:
        # Any nmap failure propagates; the coordinator turns it into
        # UpdateFailed and logs it once, so there is no logging here.
        self.nm.scan(hosts=self.ip_range, arguments=NMAP_ARGS, timeout=NMAP_TIMEOUT)

        hosts_up = self.nm.all_hosts()
        devices: list[DeviceInfo] = []

        for host in hosts_up:
            try:
                result: dict[str, Any] = self.nm[host]
                addrs = result.get("addresses", {})
                ip = addrs.get("ipv4")
                mac = addrs.get("mac")
                if not ip or not mac:
                    continue

                # PortScannerHostDict.hostname() already returns the first
                # (or user-supplied) entry from "hostnames"; usually empty
                # because of -n.
                name, device_type = self._device_info_from_mac(mac)
                devices.append(
                    {
                        "ip": ip,
                        "mac": mac,
                        "name": name,
                        "type": device_type,
                        "vendor": result.get("vendor", {}).get(mac, UNKNOWN_VENDOR),
                        "hostname": _short_label(result.hostname()),
                    }
                )
            except Exception as err:  # noqa: BLE001 - one bad host must not kill the scan
                _LOGGER.debug("Error parsing host %s: %s", host, err)

        if hosts_up and not devices and not self._warned_no_mac:
            self._warned_no_mac = True
            _LOGGER.warning(
                "nmap found %d host(s) up in %s but reported no MAC addresses, so "
                "no devices were listed. nmap needs root or CAP_NET_RAW to read "
                "MAC addresses; check how Home Assistant is running nmap",
                len(hosts_up),
                self.ip_range,
            )

        # Fill in the hostnames nmap could not supply (-n suppresses its own
        # lookups) with one concurrent reverse-DNS pass over just those hosts.
        unresolved = [d["ip"] for d in devices if not d["hostname"]]
        if unresolved:
            resolved = _resolve_hostnames(unresolved)
            for device in devices:
                if not device["hostname"]:
                    device["hostname"] = resolved.get(device["ip"])

        devices.sort(key=_sort_key)
        return devices
