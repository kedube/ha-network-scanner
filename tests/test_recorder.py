"""Tests for what the recorder stores for the sensor."""
from __future__ import annotations

import pytest
from homeassistant.components.recorder import Recorder, get_instance, history
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import (
    async_wait_recording_done,
)

from .common import ENTITY_ID, IP_RANGE


@pytest.fixture
def mock_recorder_before_hass(async_test_recorder: None) -> None:
    """Set up the recorder fixtures before hass, as the test plugin requires."""


async def test_large_and_volatile_attributes_are_not_recorded(
    recorder_mock: Recorder, hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """The device list is big and last_scan changes every scan; neither belongs in history."""
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    await async_wait_recording_done(hass)

    live = hass.states.get(ENTITY_ID)
    assert {"devices", "last_scan"} <= live.attributes.keys()

    states = await get_instance(hass).async_add_executor_job(
        history.get_last_state_changes, hass, 1, ENTITY_ID
    )
    (recorded,) = states[ENTITY_ID]
    assert recorded.state == "5"
    assert "devices" not in recorded.attributes
    assert "last_scan" not in recorded.attributes
    assert recorded.attributes["ip_range"] == IP_RANGE
