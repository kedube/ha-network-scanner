"""Config and options flows for the Network Scanner integration."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
)

from . import legacy_mac_mappings_text
from .const import (
    CONF_IP_RANGE,
    CONF_MAC_MAPPINGS,
    CONF_SCAN_INTERVAL,
    DEFAULT_IP_RANGE,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
)
from .scanner import (
    MacMappingError,
    NmapUnavailableError,
    check_nmap,
    normalize_ip_range,
    parse_mac_mappings,
    validate_ip_range,
)

_LOGGER = logging.getLogger(__name__)

_MAC_MAPPINGS_SELECTOR = TextSelector(TextSelectorConfig(multiline=True))
_SCAN_INTERVAL_SELECTOR = NumberSelector(
    NumberSelectorConfig(
        min=MIN_SCAN_INTERVAL,
        max=MAX_SCAN_INTERVAL,
        step=1,
        mode=NumberSelectorMode.BOX,
        unit_of_measurement="min",
    )
)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_IP_RANGE): TextSelector(),
        vol.Optional(CONF_MAC_MAPPINGS, default=""): _MAC_MAPPINGS_SELECTOR,
        vol.Required(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): _SCAN_INTERVAL_SELECTOR,
    }
)

OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_MAC_MAPPINGS, default=""): _MAC_MAPPINGS_SELECTOR,
        vol.Required(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): _SCAN_INTERVAL_SELECTOR,
    }
)


def _validate_options(
    user_input: dict[str, Any], errors: dict[str, str], placeholders: dict[str, str]
) -> dict[str, Any]:
    """Validate the option fields shared by both flows; return cleaned values."""
    mappings_text = str(user_input.get(CONF_MAC_MAPPINGS) or "")
    try:
        parse_mac_mappings(mappings_text, strict=True)
    except MacMappingError as err:
        errors[CONF_MAC_MAPPINGS] = "invalid_mac_mappings"
        placeholders["line"] = str(err.line_number)
    return {
        CONF_MAC_MAPPINGS: mappings_text,
        CONF_SCAN_INTERVAL: int(user_input.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)),
    }


class NetworkScannerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Network Scanner."""

    VERSION = 2
    MINOR_VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> NetworkScannerOptionsFlow:
        """Return the options flow handler."""
        return NetworkScannerOptionsFlow()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Collect the IP range, optional MAC mappings and the scan interval."""
        errors: dict[str, str] = {}
        placeholders: dict[str, str] = {}

        if user_input is not None:
            ip_range = normalize_ip_range(str(user_input.get(CONF_IP_RANGE, "")))
            if not validate_ip_range(ip_range):
                errors[CONF_IP_RANGE] = "invalid_ip_range"
            options = _validate_options(user_input, errors, placeholders)

            if not errors:
                await self.async_set_unique_id(ip_range)
                self._abort_if_unique_id_configured()
                try:
                    await self.hass.async_add_executor_job(check_nmap)
                except NmapUnavailableError as err:
                    _LOGGER.error("nmap is not available: %s", err)
                    errors["base"] = "nmap_unavailable"

            if not errors:
                return self.async_create_entry(
                    title=f"Network Scanner ({ip_range})",
                    data={CONF_IP_RANGE: ip_range},
                    options=options,
                )
            suggested: dict[str, Any] = dict(user_input)
        else:
            # Pre-fill from configuration.yaml when present. Namespaced under
            # hass.data[DOMAIN] by async_setup; may be absent or empty.
            yaml_config: dict[str, Any] = self.hass.data.get(DOMAIN) or {}
            suggested = {
                CONF_IP_RANGE: yaml_config.get(CONF_IP_RANGE, DEFAULT_IP_RANGE),
                CONF_MAC_MAPPINGS: legacy_mac_mappings_text(yaml_config),
                CONF_SCAN_INTERVAL: yaml_config.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
            }

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(STEP_USER_SCHEMA, suggested),
            errors=errors,
            description_placeholders=placeholders,
        )


class NetworkScannerOptionsFlow(OptionsFlow):
    """Edit MAC mappings and the scan interval without re-adding the entry."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show and save the options form."""
        errors: dict[str, str] = {}
        placeholders: dict[str, str] = {}

        if user_input is not None:
            options = _validate_options(user_input, errors, placeholders)
            if not errors:
                return self.async_create_entry(data=options)
            suggested: dict[str, Any] = dict(user_input)
        else:
            suggested = {
                CONF_MAC_MAPPINGS: "",
                CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL,
                **self.config_entry.options,
            }

        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(OPTIONS_SCHEMA, suggested),
            errors=errors,
            description_placeholders=placeholders,
        )
