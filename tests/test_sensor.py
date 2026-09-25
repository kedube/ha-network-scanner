"""Tests for the Network Scanner sensor."""
from __future__ import annotations

from datetime import datetime, timedelta

import nmap
from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.sensor import SensorStateClass
from homeassistant.const import ATTR_ENTITY_ID, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.network_scanner.const import CONF_SCAN_INTERVAL, DOMAIN

from .common import (
    ENTITY_ID,
    INTEGRATION_VERSION,
    IP_RANGE,
    SWEEP_DEVICES,
    FakeNmap,
    nmap_xml,
)


async def advance_time(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, delta: timedelta
) -> None:
    """Move the clock and let any scan it triggers finish.

    Interval refreshes run as background tasks, so they need the extra wait.
    """
    freezer.tick(delta)
    async_fire_time_changed(hass)
    await hass.async_block_till_done(wait_background_tasks=True)


async def test_state_and_attributes(hass: HomeAssistant, init_integration: MockConfigEntry) -> None:
    state = hass.states.get(ENTITY_ID)
    assert state.state == "5"
    assert state.attributes["devices"] == SWEEP_DEVICES
    assert state.attributes["ip_range"] == IP_RANGE
    last_scan = datetime.fromisoformat(state.attributes["last_scan"])
    assert last_scan.tzinfo is not None
    assert abs(dt_util.utcnow() - last_scan) < timedelta(minutes=1)
    assert state.attributes["unit_of_measurement"] == "Devices"
    assert state.attributes["state_class"] == SensorStateClass.MEASUREMENT
    assert state.attributes["icon"] == "mdi:lan"
    assert state.attributes["friendly_name"] == "Network Scanner"


async def test_registry_entries(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    entity_registry: er.EntityRegistry,
    device_registry: dr.DeviceRegistry,
) -> None:
    entity = entity_registry.async_get(ENTITY_ID)
    # Kept from 1.x so existing installs keep their entity.
    assert entity.unique_id == f"network_scanner_{IP_RANGE}"

    device = device_registry.async_get(entity.device_id)
    assert device.identifiers == {(DOMAIN, init_integration.entry_id)}
    assert device.name == f"Network Scanner ({IP_RANGE})"
    assert device.manufacturer == "nmap"
    assert device.entry_type is dr.DeviceEntryType.SERVICE
    # The dashboard card compares its own version against this.
    assert device.sw_version == INTEGRATION_VERSION


async def test_empty_network(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry, mock_nmap: FakeNmap
) -> None:
    mock_nmap.xml = nmap_xml()
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)

    state = hass.states.get(ENTITY_ID)
    assert state.state == "0"
    assert state.attributes["devices"] == []


async def test_failed_scan_marks_sensor_unavailable_until_next_success(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    mock_nmap: FakeNmap,
    freezer: FrozenDateTimeFactory,
) -> None:
    good_scan = hass.states.get(ENTITY_ID).attributes["last_scan"]

    mock_nmap.error = nmap.PortScannerTimeout("Timeout from nmap process")
    await advance_time(hass, freezer, timedelta(minutes=15))
    assert hass.states.get(ENTITY_ID).state == STATE_UNAVAILABLE

    mock_nmap.error = None
    await advance_time(hass, freezer, timedelta(minutes=15))
    state = hass.states.get(ENTITY_ID)
    assert state.state == "5"
    # last_scan only moves on success.
    assert state.attributes["last_scan"] > good_scan


async def test_scans_on_configured_interval(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_nmap: FakeNmap,
) -> None:
    mock_config_entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(
        mock_config_entry, options={**mock_config_entry.options, CONF_SCAN_INTERVAL: 5}
    )
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert len(mock_nmap.scans) == 1

    await advance_time(hass, freezer, timedelta(minutes=4))
    assert len(mock_nmap.scans) == 1

    await advance_time(hass, freezer, timedelta(minutes=1))
    assert len(mock_nmap.scans) == 2


async def test_update_entity_scans_now(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    mock_nmap: FakeNmap,
    freezer: FrozenDateTimeFactory,
) -> None:
    """The card's Scan now button calls homeassistant.update_entity."""
    assert await async_setup_component(hass, "homeassistant", {})
    first_scan = hass.states.get(ENTITY_ID).attributes["last_scan"]
    freezer.tick(timedelta(seconds=30))

    await hass.services.async_call(
        "homeassistant", "update_entity", {ATTR_ENTITY_ID: ENTITY_ID}, blocking=True
    )

    assert len(mock_nmap.scans) == 2
    # The device list is unchanged, but the new last_scan still produces a
    # state change, which is how the card learns a scan happened.
    assert hass.states.get(ENTITY_ID).attributes["last_scan"] > first_scan
