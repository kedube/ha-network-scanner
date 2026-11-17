"""Test doubles and expected data shared by the Network Scanner tests."""
from __future__ import annotations

import asyncio
import json
import socket
import threading
from collections.abc import Callable
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
    """Stands in for the nmap binary: `nmap -V` behind every PortScanner, and the sweep.

    The sweep's output goes through python-nmap's real XML parser, so host,
    MAC, vendor and hostname extraction is the real library code.
    """

    def __init__(self) -> None:
        self.xml = (FIXTURES / "nmap_ping_sweep.xml").read_text()
        self.stderr = ""
        self.available = True
        # Raised by the sweep instead of returning output, e.g. TimeoutExpired.
        self.error: Exception | None = None
        # When set, the sweep blocks until the test sets the event, or until
        # the process is killed.
        self.gate: threading.Event | None = None
        self.created = 0
        # One {"args", "timeout"} per sweep that started running.
        self.scans: list[dict[str, Any]] = []
        self.processes: list[FakeProcess] = []

    def port_scanner(self) -> FakePortScanner:
        """Replacement for the nmap.PortScanner constructor."""
        if not self.available:
            raise nmap.PortScannerError("nmap program was not found in path")
        self.created += 1
        return FakePortScanner()

    def popen(self, args: list[str], **kwargs: Any) -> FakeProcess:
        """Replacement for the Popen the scanner starts the sweep with."""
        process = FakeProcess(self, list(args))
        self.processes.append(process)
        return process


class FakePortScanner(nmap.PortScanner):
    """python-nmap's PortScanner, as if `nmap -V` had found nmap 7.95 on the PATH."""

    def __init__(self) -> None:
        self._scan_result = {}
        self._nmap_last_output = ""
        self._nmap_path = "nmap"
        self._nmap_version_number = 7
        self._nmap_subversion_number = 95


class FakeProcess:
    """A running `nmap -oX - ...` sweep that prints FakeNmap.xml."""

    def __init__(self, fake: FakeNmap, args: list[str]) -> None:
        self._fake = fake
        self.args = args
        self.killed = False
        self.reaped = False

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        """Return the canned output, or raise the canned error."""
        if self.killed:
            # Killed before it ran, or the scanner reaping it after kill().
            self.reaped = True
            return b"", b""
        fake = self._fake
        fake.scans.append({"args": self.args, "timeout": timeout})
        if fake.gate is not None:
            for _ in range(500):
                if fake.gate.is_set() or self.killed:
                    break
                fake.gate.wait(0.01)
            else:
                raise TimeoutError("the test never released the scan gate")
        if self.killed:
            self.reaped = True
            return b"", b""
        if fake.error is not None:
            raise fake.error
        return fake.xml.encode(), fake.stderr.encode()

    def kill(self) -> None:
        self.killed = True


async def wait_for(condition: Callable[[], bool], seconds: float = 5) -> None:
    """Let executor threads run until the condition holds."""
    for _ in range(int(seconds / 0.01)):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


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
