"""Tests for setup, unload, migration and card registration in __init__.py."""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from unittest.mock import patch

import pytest
from homeassistant.components.frontend import UrlManager
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.network_scanner import (
    CARD_PATH,
    CARD_URL,
    _file_digest,
    legacy_mac_mappings_text,
)
from custom_components.network_scanner.const import (
    CONF_IP_RANGE,
    CONF_MAC_MAPPINGS,
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)

from .common import ENTITY_ID, INTEGRATION_VERSION, IP_RANGE, FakeNmap

# ---------------------------------------------------------------- setup


async def test_setup_and_unload(hass: HomeAssistant, init_integration: MockConfigEntry) -> None:
    assert init_integration.state is ConfigEntryState.LOADED
    assert hass.states.get(ENTITY_ID).state == "5"

    assert await hass.config_entries.async_unload(init_integration.entry_id)
    await hass.async_block_till_done()
    assert init_integration.state is ConfigEntryState.NOT_LOADED


async def test_setup_fails_without_nmap(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, mock_nmap: FakeNmap
) -> None:
    mock_nmap.available = False
    mock_config_entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(mock_config_entry.entry_id)
    # A permanent error: Home Assistant won't keep retrying a missing binary.
    assert mock_config_entry.state is ConfigEntryState.SETUP_ERROR
    assert hass.states.get(ENTITY_ID) is None


async def test_first_scan_does_not_block_setup(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, mock_nmap: FakeNmap
) -> None:
    """A cold scan can outlast Home Assistant's setup timeout, so it runs in the background."""
    mock_nmap.gate = threading.Event()
    mock_config_entry.add_to_hass(hass)
    try:
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()
        assert mock_config_entry.state is ConfigEntryState.LOADED
        assert hass.states.get(ENTITY_ID).state == "unknown"
    finally:
        mock_nmap.gate.set()
    await hass.async_block_till_done(wait_background_tasks=True)
    assert hass.states.get(ENTITY_ID).state == "5"


# ---------------------------------------------------------------- configuration.yaml


@pytest.mark.parametrize(
    ("config", "stored"),
    [
        ({}, {}),
        ({DOMAIN: None}, {}),
        ({DOMAIN: {"ip_range": "10.0.0.0/24", "future_key": 1}}, {"ip_range": "10.0.0.0/24", "future_key": 1}),
    ],
)
async def test_yaml_block_is_accepted_and_stored(
    hass: HomeAssistant, config: dict, stored: dict
) -> None:
    """The YAML block only pre-fills the config flow, so no key in it may stop the integration loading."""
    assert await async_setup_component(hass, DOMAIN, config)
    assert hass.data[DOMAIN] == stored
    assert hass.config_entries.async_entries(DOMAIN) == []


def test_legacy_mac_mappings_text() -> None:
    source = {
        "ip_range": IP_RANGE,
        "mac_mapping_10": " aa:bb:cc:dd:ee:10;Ten ",
        "mac_mapping_2": "aa:bb:cc:dd:ee:02;Two",
        "mac_mapping_1": "aa:bb:cc:dd:ee:01;One",
        "mac_mapping_4": "",
    }
    # Numeric slot order, gaps and blanks skipped, whitespace trimmed.
    assert legacy_mac_mappings_text(source) == (
        "aa:bb:cc:dd:ee:01;One\naa:bb:cc:dd:ee:02;Two\naa:bb:cc:dd:ee:10;Ten"
    )


# ---------------------------------------------------------------- migration


def version_1_entry(ip_range: str = IP_RANGE, **mappings: str) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN, version=1, data={CONF_IP_RANGE: ip_range, **mappings}
    )


async def test_migrate_version_1(hass: HomeAssistant, entity_registry: er.EntityRegistry) -> None:
    ip_range = "192.168.1.0/24  10.0.0.0/24"
    entry = version_1_entry(
        ip_range,
        mac_mapping_1="bc:14:14:f1:81:1b;Brother Printer;Brother",
        mac_mapping_3="10:27:f5:00:00:01;Router;TP-Link",
    )
    entry.add_to_hass(hass)
    # The sensor as a 1.x install registered it.
    entity_registry.async_get_or_create(
        "sensor", DOMAIN, f"network_scanner_{ip_range}", config_entry=entry,
        suggested_object_id="network_scanner",
    )

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert entry.state is ConfigEntryState.LOADED
    assert (entry.version, entry.minor_version) == (2, 1)
    # ip_range is kept byte-for-byte: the sensor's unique_id is derived from it.
    assert entry.data == {CONF_IP_RANGE: ip_range}
    assert entry.options == {
        CONF_MAC_MAPPINGS: (
            "bc:14:14:f1:81:1b;Brother Printer;Brother\n10:27:f5:00:00:01;Router;TP-Link"
        ),
        CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL,
    }
    assert entry.unique_id == "192.168.1.0/24 10.0.0.0/24"
    # Same entity, same entity_id, so history and dashboards carry over.
    assert entity_registry.async_get_entity_id("sensor", DOMAIN, f"network_scanner_{ip_range}") == ENTITY_ID
    assert hass.states.get(ENTITY_ID).state == "5"


async def test_migrate_version_1_keeps_existing_options(hass: HomeAssistant) -> None:
    entry = version_1_entry(mac_mapping_1="aa:bb:cc:dd:ee:01;One")
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(entry, options={CONF_SCAN_INTERVAL: 5})

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.options == {CONF_MAC_MAPPINGS: "aa:bb:cc:dd:ee:01;One", CONF_SCAN_INTERVAL: 5}


async def test_migrate_version_1_duplicate_range(hass: HomeAssistant) -> None:
    """1.x allowed the same range twice; only one entry can claim the unique_id."""
    first = version_1_entry()
    second = version_1_entry()
    first.add_to_hass(hass)
    second.add_to_hass(hass)

    assert await hass.config_entries.async_setup(first.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert first.version == second.version == 2
    assert {first.unique_id, second.unique_id} == {IP_RANGE, None}


async def test_migrate_from_future_version_fails(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, version=3, data={CONF_IP_RANGE: IP_RANGE})
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state is ConfigEntryState.MIGRATION_ERROR


# ---------------------------------------------------------------- dashboard card


async def test_card_is_served_and_auto_loaded(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    mock_frontend: UrlManager,
) -> None:
    assert await async_setup_component(hass, DOMAIN, {})

    digest = hashlib.sha256(CARD_PATH.read_bytes()).hexdigest()[:12]
    # ?v= is the integration version the card reports and checks itself against.
    url = f"{CARD_URL}?v={INTEGRATION_VERSION}&h={digest}"
    assert mock_frontend.urls == frozenset({url})

    client = await hass_client()
    response = await client.get(url)
    assert response.status == 200
    assert "javascript" in response.content_type
    assert "max-age" in response.headers["Cache-Control"]
    assert await response.text() == CARD_PATH.read_text()


async def test_missing_card_does_not_break_setup(
    hass: HomeAssistant,
    mock_frontend: UrlManager,
    mock_config_entry: MockConfigEntry,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with patch("custom_components.network_scanner.CARD_PATH", Path("/nonexistent/card.js")):
        mock_config_entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done(wait_background_tasks=True)

    assert "Network Scanner card not loaded" in caplog.text
    assert mock_frontend.urls == frozenset()
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert hass.states.get(ENTITY_ID).state == "5"


def test_card_url_changes_with_content(tmp_path: Path) -> None:
    """Browsers cache the card for a long time; a new version must get a new URL."""
    card = tmp_path / "card.js"
    card.write_text("v1")
    first = _file_digest(card)
    assert _file_digest(card) == first
    card.write_text("v2")
    assert _file_digest(card) != first
    assert len(first) == 12
