"""Test doubles and expected data shared by the Network Scanner tests."""
from __future__ import annotations

import json
import socket
import threading
from pathlib import Path
from typing import Any

import nmap

FIXTURES = Path(__file__).parent / "fixtures"
INTEGRATION_DIR = Path(__file__).parents[1] / "custom_components" / "network_scanner"

# Set by the release job on every release; the card URL and the device's
# sw_version must both carry it.
INTEGRATION_VERSION = json.loads((INTEGRATION_DIR / "manifest.json").read_text())["version"]

IP_RANGE = "192.168.1.0/24"
MAC_MAPPINGS = "bc:14:14:f1:81:1b;Brother Printer;Brother"
ENTITY_ID = "sensor.network_scanner"

REVERSE_DNS = {
    "192.168.1.1": "router.lan.",
    "192.168.1.9": "Living-Room-TV.home.arpa",
}

# What the integration reports for fixtures/nmap_ping_sweep.xml, given
# MAC_MAPPINGS and REVERSE_DNS: numeric IP order, the scanning host (no MAC)
# dropped, the printer named from the mapping even though nmap reports MACs in
# upper case, and hostnames from nmap's PTR record or else reverse DNS. The
# dashboard card tests render this same list, so the card is always tested
# against what the integration really emits.
SWEEP_DEVICES = json.loads((FIXTURES / "sweep_devices.json").read_text())


def nmap_xml(*hosts: dict[str, str]) -> str:
    """Minimal `nmap -oX` output for hosts given as {"ipv4": ..., "mac": ..., "vendor": ...}."""
    body = []
    for host in hosts:
        addresses = [f'<address addr="{host["ipv4"]}" addrtype="ipv4"/>']
        if "mac" in host:
            vendor = f' vendor="{host["vendor"]}"' if "vendor" in host else ""
            addresses.append(f'<address addr="{host["mac"]}" addrtype="mac"{vendor}/>')
        body.append(
            '<host><status state="up" reason="syn-ack" reason_ttl="0"/>'
            f"{''.join(addresses)}<hostnames></hostnames></host>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><nmaprun scanner="nmap" args="nmap">'
        f"{''.join(body)}"
        '<runstats><finished time="0" timestr="" elapsed="0.1" exit="success"/>'
        f'<hosts up="{len(hosts)}" down="0" total="{len(hosts)}"/></runstats></nmaprun>'
    )


class FakeNmap:
    """Stands in for the nmap binary behind every PortScanner the integration creates."""

    def __init__(self) -> None:
        self.xml = (FIXTURES / "nmap_ping_sweep.xml").read_text()
        self.available = True
        self.error: Exception | None = None
        # When set, scan() blocks until the test sets the event.
        self.gate: threading.Event | None = None
        self.created = 0
        self.scans: list[dict[str, Any]] = []

    def port_scanner(self) -> FakePortScanner:
        """Replacement for the nmap.PortScanner constructor."""
        if not self.available:
            raise nmap.PortScannerError("nmap program was not found in path")
        self.created += 1
        return FakePortScanner(self)


class FakePortScanner(nmap.PortScanner):
    """python-nmap's PortScanner, parsing canned XML instead of running nmap.

    Only the subprocess is faked: scan() hands the XML to python-nmap's own
    analyse_nmap_xml_scan, so host, MAC, vendor and hostname extraction is the
    real library code.
    """

    def __init__(self, fake: FakeNmap) -> None:
        self._fake = fake
        self._scan_result = {}
        self._nmap_last_output = ""
        self._nmap_version_number = 7
        self._nmap_subversion_number = 95

    def scan(self, hosts="127.0.0.1", ports=None, arguments="-sV", sudo=False, timeout=0):
        """Record the call, then parse the canned output (or raise the canned error)."""
        fake = self._fake
        fake.scans.append({"hosts": hosts, "arguments": arguments, "timeout": timeout})
        if fake.gate is not None and not fake.gate.wait(timeout=5):
            raise TimeoutError("the test never released the scan gate")
        if fake.error is not None:
            raise fake.error
        return self.analyse_nmap_xml_scan(nmap_xml_output=fake.xml)


class FakeResolver:
    """Reverse DNS answered from a dict; unknown addresses fail like a real resolver."""

    def __init__(self, names: dict[str, str]) -> None:
        self.names = dict(names)
        self.lookups: list[str] = []

    def gethostbyaddr(self, ip: str) -> tuple[str, list[str], list[str]]:
        """Replacement for socket.gethostbyaddr."""
        self.lookups.append(ip)
        try:
            return self.names[ip], [], [ip]
        except KeyError:
            raise socket.herror(1, "Unknown host") from None
