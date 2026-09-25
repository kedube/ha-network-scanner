"""Network Scanner sensor entity, backed by a DataUpdateCoordinator."""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.loader import async_get_integration

from .const import ATTR_DEVICES, ATTR_IP_RANGE, ATTR_LAST_SCAN, CONF_IP_RANGE, DOMAIN
from .coordinator import NetworkScannerConfigEntry, NetworkScannerCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetworkScannerConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Network Scanner sensor from a config entry."""
    integration = await async_get_integration(hass, DOMAIN)
    async_add_entities([NetworkScannerSensor(entry, str(integration.version))])


class NetworkScannerSensor(CoordinatorEntity[NetworkScannerCoordinator], SensorEntity):
    """Device count for one scanned range, with the device list as an attribute.

    The scan itself is owned by the coordinator. This entity is a read-only
    view: no async_update, no blocking work.
    """

    # Name is intentionally not device-prefixed (has_entity_name stays False)
    # so a fresh install still gets `sensor.network_scanner`, which the README
    # dashboard examples rely on.
    _attr_name = "Network Scanner"
    _attr_icon = "mdi:lan"
    _attr_native_unit_of_measurement = "Devices"
    _attr_state_class = SensorStateClass.MEASUREMENT

    # The device list changes on most scans (a hostname resolves, a phone
    # comes and goes). Keeping it out of the recorder avoids writing the whole
    # blob to the database every 15 minutes; dashboards read live state anyway.
    # last_scan changes on every scan, so recording it would store a fresh
    # attributes row each time even when nothing else changed.
    _unrecorded_attributes = frozenset({ATTR_DEVICES, ATTR_LAST_SCAN})

    def __init__(self, entry: NetworkScannerConfigEntry, version: str) -> None:
        super().__init__(entry.runtime_data)
        ip_range: str = entry.data[CONF_IP_RANGE]
        self._ip_range = ip_range
        # This unique_id format predates entry version 2. Changing it would
        # orphan existing entity registry entries, so keep it as-is.
        self._attr_unique_id = f"network_scanner_{ip_range}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=f"Network Scanner ({ip_range})",
            manufacturer="nmap",
            model="Ping sweep",
            entry_type=DeviceEntryType.SERVICE,
            # Shown on the device page, and how the dashboard card checks it
            # matches the integration that is running.
            sw_version=version,
        )

    @property
    def native_value(self) -> int | None:
        """Number of devices found in the most recent scan."""
        if self.coordinator.data is None:
            return None
        return len(self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the full device list as an attribute.

        ip_range and last_scan are there for the dashboard card. The frontend
        is never told about state writes that change nothing, so without
        last_scan the card could only show when the device list last changed,
        not when the network was last scanned.
        """
        last_scan = self.coordinator.last_update_success_time
        return {
            ATTR_DEVICES: self.coordinator.data or [],
            ATTR_IP_RANGE: self._ip_range,
            ATTR_LAST_SCAN: last_scan.isoformat() if last_scan else None,
        }
