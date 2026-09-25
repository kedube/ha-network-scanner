"""Network Scanner integration."""
from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    CONF_IP_RANGE,
    CONF_MAC_MAPPINGS,
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    LEGACY_MAC_MAPPING_PREFIX,
)
from .coordinator import NetworkScannerConfigEntry, NetworkScannerCoordinator
from .scanner import (
    NetworkScannerClient,
    NmapUnavailableError,
    normalize_ip_range,
    parse_mac_mappings,
)

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]

CARD_FILENAME = "network-scanner-card.js"
CARD_PATH = Path(__file__).parent / "frontend" / CARD_FILENAME
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

# The YAML block only pre-fills the config flow form. mac_mapping_N keys are
# dynamic, hence ALLOW_EXTRA; a bare `network_scanner:` line (None) is accepted
# so a stray key cannot prevent the integration from loading at all.
CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Any(
            None,
            vol.Schema({vol.Optional(CONF_IP_RANGE): cv.string}, extra=vol.ALLOW_EXTRA),
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def legacy_mac_mappings_text(source: Mapping[str, Any]) -> str:
    """Join numbered ``mac_mapping_N`` keys into one newline-separated string.

    Used for both configuration.yaml pre-fill and the version 1 -> 2 entry
    migration. Every present slot is collected, ordered by slot number; gaps
    are fine (an older loop stopped at the first missing key and silently
    dropped everything numbered above it).
    """

    def _slot_number(key: str) -> int:
        suffix = key[len(LEGACY_MAC_MAPPING_PREFIX) :]
        return int(suffix) if suffix.isdigit() else 0

    keys = sorted(
        (
            key
            for key, value in source.items()
            if key.startswith(LEGACY_MAC_MAPPING_PREFIX) and value
        ),
        key=_slot_number,
    )
    return "\n".join(str(source[key]).strip() for key in keys)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Store the optional YAML block so the config flow can pre-fill from it."""
    hass.data[DOMAIN] = config.get(DOMAIN) or {}
    await _async_register_card(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the dashboard card and load it on every frontend page.

    add_extra_js_url makes the frontend import the module on startup, so
    type: custom:network-scanner-card works without the user adding a
    dashboard resource by hand.

    The URL carries the integration version (?v=), which the card reads back
    to report which release it belongs to and to spot a page still running a
    card from before an upgrade. Each release therefore gets a new URL and
    browsers drop their cached copy. The content hash (&h=) does the same for
    card changes that arrive without a version bump, such as an install from
    a branch.

    A missing or unreadable card file is logged and skipped rather than
    failing setup: the scanner itself doesn't depend on it.
    """
    try:
        digest = await hass.async_add_executor_job(_file_digest, CARD_PATH)
    except OSError as err:
        _LOGGER.error("Network Scanner card not loaded, cannot read %s: %s", CARD_PATH, err)
        return

    integration = await async_get_integration(hass, DOMAIN)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(CARD_PATH), cache_headers=True)]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={integration.version}&h={digest}")


def _file_digest(path: Path) -> str:
    """Short content hash of a file, for cache-busting its URL. Blocking."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Migrate old config entries to the current layout.

    Version 1 stored ``ip_range`` plus up to N ``mac_mapping_N`` keys in
    ``data``. Version 2 keeps only ``ip_range`` in ``data`` and moves the
    mappings (as one multiline string) and the scan interval into ``options``
    so they can be edited without re-adding the integration.
    """
    if entry.version > 2:
        # Downgrade from a future version is not supported.
        return False

    if entry.version == 1:
        ip_range = str(entry.data.get(CONF_IP_RANGE, ""))
        options = {
            CONF_MAC_MAPPINGS: legacy_mac_mappings_text(entry.data),
            CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL,
            **entry.options,
        }

        # Version 1 flows never set a unique_id. Claim one now so the flow's
        # duplicate check covers old entries too, unless another entry already
        # holds it (the old flow allowed duplicates).
        unique_id = entry.unique_id
        if unique_id is None:
            candidate = normalize_ip_range(ip_range)
            taken = {
                other.unique_id
                for other in hass.config_entries.async_entries(DOMAIN)
                if other.entry_id != entry.entry_id
            }
            if candidate and candidate not in taken:
                unique_id = candidate

        # ip_range is deliberately NOT normalised here: the sensor's unique_id
        # is derived from it and must stay byte-identical for existing entities.
        hass.config_entries.async_update_entry(
            entry,
            data={CONF_IP_RANGE: ip_range},
            options=options,
            unique_id=unique_id,
            version=2,
            minor_version=1,
        )
        _LOGGER.info("Migrated Network Scanner entry %s to version 2", entry.title)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: NetworkScannerConfigEntry) -> bool:
    """Set up Network Scanner from a config entry."""
    ip_range: str = entry.data[CONF_IP_RANGE]
    mapping = parse_mac_mappings(entry.options.get(CONF_MAC_MAPPINGS, ""))
    scan_interval = int(entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL))

    # The client constructor spawns `nmap -V`, so it must run in the executor.
    try:
        client = await hass.async_add_executor_job(NetworkScannerClient, ip_range, mapping)
    except NmapUnavailableError as err:
        # Permanent until the host is fixed; no point retrying every minute.
        raise ConfigEntryError(f"nmap is not available: {err}") from err

    coordinator = NetworkScannerCoordinator(hass, entry, client, scan_interval)
    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Do NOT await the first refresh here: a cold nmap sweep takes far longer
    # than the platform-setup budget. A background task tied to the entry is
    # excluded from the startup wait and is cancelled on unload.
    entry.async_create_background_task(
        hass,
        coordinator.async_refresh(),
        name=f"{DOMAIN}_initial_refresh",
    )

    # Options changes (mappings, interval) take effect via a reload.
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: NetworkScannerConfigEntry) -> None:
    """Reload the entry when its options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: NetworkScannerConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
