"""Shared fixtures for the Network Scanner tests.

Nothing here needs the nmap binary or a network: nmap.PortScanner is replaced
by FakeNmap, and reverse DNS is answered from a dict.
"""
from __future__ import annotations

import threading
from collections.abc import AsyncGenerator, Generator
from unittest.mock import patch

import nmap
import pytest
from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, UrlManager
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

# Imported at collection time on purpose: it puts this repo's custom_components
# package in sys.modules before Home Assistant's loader can import the test
# plugin's own testing_config/custom_components in its place.
from custom_components.network_scanner.const import (
    CONF_IP_RANGE,
    CONF_MAC_MAPPINGS,
    CONF_SCAN_INTERVAL,
    DOMAIN,
)

from .common import IP_RANGE, MAC_MAPPINGS, REVERSE_DNS, FakeNmap, FakeResolver


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Let Home Assistant load integrations from custom_components."""


@pytest.fixture(autouse=True)
def mock_nmap() -> Generator[FakeNmap]:
    """Replace the nmap binary for every test, so none can run a real scan."""
    fake = FakeNmap()
    with patch.object(nmap, "PortScanner", side_effect=fake.port_scanner):
        yield fake


@pytest.fixture(autouse=True)
def mock_reverse_dns() -> Generator[FakeResolver]:
    """Answer reverse DNS locally.

    The test plugin blocks sockets but not the libc resolver, so without this
    a scan would send real PTR queries for the fixture addresses.
    """
    resolver = FakeResolver(REVERSE_DNS)
    with patch(
        "custom_components.network_scanner.scanner.socket.gethostbyaddr",
        side_effect=resolver.gethostbyaddr,
    ):
        yield resolver


@pytest.fixture(autouse=True)
def join_reverse_dns_threads() -> Generator[None]:
    """Wait for the scanner's reverse-DNS worker threads after each test.

    The scanner shuts its pool down without waiting, by design, and the test
    plugin fails any test that leaves threads behind.
    """
    yield
    for thread in threading.enumerate():
        if thread.name.startswith("network_scanner_rdns"):
            thread.join(timeout=5)


@pytest.fixture(autouse=True)
async def mock_frontend(hass: HomeAssistant) -> UrlManager:
    """Real http, plus a stand-in for the frontend's extra-module registry.

    The frontend component needs the home-assistant-frontend package, which
    the test plugin doesn't install. The integration only touches the frontend
    through add_extra_js_url, which adds to this registry.
    """
    assert await async_setup_component(hass, "http", {})
    hass.config.components.add("frontend")
    urls = UrlManager(lambda *_: None, [])
    hass.data[DATA_EXTRA_MODULE_URL] = urls
    return urls


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A current (version 2) entry for the fixture network."""
    return MockConfigEntry(
        domain=DOMAIN,
        title=f"Network Scanner ({IP_RANGE})",
        version=2,
        minor_version=1,
        unique_id=IP_RANGE,
        data={CONF_IP_RANGE: IP_RANGE},
        options={CONF_MAC_MAPPINGS: MAC_MAPPINGS, CONF_SCAN_INTERVAL: 15},
    )


@pytest.fixture
async def init_integration(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, freezer: FrozenDateTimeFactory
) -> AsyncGenerator[MockConfigEntry]:
    """Set up the integration and wait for its first scan, which runs in the background.

    Time is frozen first on purpose. Freezing it later moves the event loop's
    clock forward to wall-clock time, which makes the coordinator's next
    refresh look overdue and run an extra scan.
    """
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    yield mock_config_entry
