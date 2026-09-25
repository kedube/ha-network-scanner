"""Tests for the config and options flows."""
from __future__ import annotations

import json
from typing import Any

import pytest
from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult, FlowResultType
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.network_scanner.const import (
    CONF_IP_RANGE,
    CONF_MAC_MAPPINGS,
    CONF_SCAN_INTERVAL,
    DEFAULT_IP_RANGE,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)

from .common import ENTITY_ID, INTEGRATION_DIR, IP_RANGE, MAC_MAPPINGS, FakeNmap


def suggested_values(result: FlowResult) -> dict[str, Any]:
    """The values a form pre-fills, keyed by field name."""
    return {
        str(key): key.description["suggested_value"]
        for key in result["data_schema"].schema
        if key.description and "suggested_value" in key.description
    }


async def start_user_flow(hass: HomeAssistant) -> FlowResult:
    return await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})


def user_input(**overrides: Any) -> dict[str, Any]:
    return {
        CONF_IP_RANGE: IP_RANGE,
        CONF_MAC_MAPPINGS: MAC_MAPPINGS,
        CONF_SCAN_INTERVAL: 15,
        **overrides,
    }


# ---------------------------------------------------------------- user step


async def test_form_defaults(hass: HomeAssistant) -> None:
    result = await start_user_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {}
    assert suggested_values(result) == {
        CONF_IP_RANGE: DEFAULT_IP_RANGE,
        CONF_MAC_MAPPINGS: "",
        CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL,
    }


async def test_form_prefilled_from_configuration_yaml(hass: HomeAssistant) -> None:
    assert await async_setup_component(
        hass,
        DOMAIN,
        {
            DOMAIN: {
                "ip_range": "10.0.0.0/24",
                "scan_interval": 5,
                "mac_mapping_2": "aa:bb:cc:dd:ee:02;TV",
                "mac_mapping_1": "aa:bb:cc:dd:ee:01;Printer;Brother",
            }
        },
    )
    result = await start_user_flow(hass)
    assert suggested_values(result) == {
        CONF_IP_RANGE: "10.0.0.0/24",
        CONF_MAC_MAPPINGS: "aa:bb:cc:dd:ee:01;Printer;Brother\naa:bb:cc:dd:ee:02;TV",
        CONF_SCAN_INTERVAL: 5,
    }


async def test_create_entry(hass: HomeAssistant) -> None:
    result = await start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        user_input(ip_range="  192.168.1.0/24   10.0.0.0/24 ", scan_interval=5.0),
    )
    await hass.async_block_till_done(wait_background_tasks=True)

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Network Scanner (192.168.1.0/24 10.0.0.0/24)"
    assert result["data"] == {CONF_IP_RANGE: "192.168.1.0/24 10.0.0.0/24"}
    assert result["options"] == {CONF_MAC_MAPPINGS: MAC_MAPPINGS, CONF_SCAN_INTERVAL: 5}
    assert type(result["options"][CONF_SCAN_INTERVAL]) is int
    assert result["result"].unique_id == "192.168.1.0/24 10.0.0.0/24"
    # Creating the entry sets it up and runs the first scan.
    assert hass.states.get(ENTITY_ID).state == "5"


@pytest.mark.parametrize(
    "ip_range", ["", "-oN /tmp/out 192.168.1.0/24", "192.168.1.0/24; reboot"]
)
async def test_invalid_ip_range(hass: HomeAssistant, mock_nmap: FakeNmap, ip_range: str) -> None:
    result = await start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], user_input(ip_range=ip_range)
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_IP_RANGE: "invalid_ip_range"}
    # The form comes back with what the user typed, and nmap was never started.
    assert suggested_values(result)[CONF_IP_RANGE] == ip_range
    assert mock_nmap.created == 0


async def test_invalid_mac_mappings(hass: HomeAssistant) -> None:
    result = await start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        user_input(mac_mappings="aa:bb:cc:dd:ee:ff;Printer\n# comment\nnot-a-mac;TV"),
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_MAC_MAPPINGS: "invalid_mac_mappings"}
    assert result["description_placeholders"] == {"line": "3"}


async def test_nmap_unavailable_then_fixed(hass: HomeAssistant, mock_nmap: FakeNmap) -> None:
    mock_nmap.available = False
    result = await start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], user_input())
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "nmap_unavailable"}

    mock_nmap.available = True
    result = await hass.config_entries.flow.async_configure(result["flow_id"], user_input())
    await hass.async_block_till_done(wait_background_tasks=True)
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_already_configured(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    mock_config_entry.add_to_hass(hass)
    result = await start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], user_input(ip_range=f"  {IP_RANGE} ")
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


# ---------------------------------------------------------------- options


async def test_options_flow_updates_mappings_and_rescans(
    hass: HomeAssistant, init_integration: MockConfigEntry, mock_nmap: FakeNmap
) -> None:
    result = await hass.config_entries.options.async_init(init_integration.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    assert suggested_values(result) == {CONF_MAC_MAPPINGS: MAC_MAPPINGS, CONF_SCAN_INTERVAL: 15}

    mappings = f"{MAC_MAPPINGS}\n10:27:f5:00:00:01;Router;TP-Link"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_MAC_MAPPINGS: mappings, CONF_SCAN_INTERVAL: 30}
    )
    await hass.async_block_till_done(wait_background_tasks=True)

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert init_integration.options == {CONF_MAC_MAPPINGS: mappings, CONF_SCAN_INTERVAL: 30}
    # The entry reloaded with the new mapping and scanned again.
    assert len(mock_nmap.scans) == 2
    router = hass.states.get(ENTITY_ID).attributes["devices"][0]
    assert (router["name"], router["type"]) == ("Router", "TP-Link")


async def test_options_flow_rejects_invalid_mappings(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    result = await hass.config_entries.options.async_init(init_integration.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_MAC_MAPPINGS: "garbage", CONF_SCAN_INTERVAL: 30}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_MAC_MAPPINGS: "invalid_mac_mappings"}
    assert result["description_placeholders"] == {"line": "1"}
    assert init_integration.options[CONF_SCAN_INTERVAL] == 15


async def test_options_flow_fills_missing_options_with_defaults(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN, version=2, unique_id=IP_RANGE, data={CONF_IP_RANGE: IP_RANGE}
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert suggested_values(result) == {
        CONF_MAC_MAPPINGS: "",
        CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL,
    }


# ---------------------------------------------------------------- translations


def test_translations_match_strings() -> None:
    """Custom integrations ship translations/en.json as-is; it must not drift from strings.json."""
    strings = json.loads((INTEGRATION_DIR / "strings.json").read_text())
    english = json.loads((INTEGRATION_DIR / "translations" / "en.json").read_text())
    assert english == strings
