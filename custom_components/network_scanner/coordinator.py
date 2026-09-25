"""DataUpdateCoordinator for the Network Scanner integration."""
from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import (
    TimestampDataUpdateCoordinator,
    UpdateFailed,
)

from .const import DOMAIN
from .scanner import DeviceInfo, NetworkScannerClient

_LOGGER = logging.getLogger(__name__)

type NetworkScannerConfigEntry = ConfigEntry[NetworkScannerCoordinator]


class NetworkScannerCoordinator(TimestampDataUpdateCoordinator[list[DeviceInfo]]):
    """Runs the blocking nmap scan in the executor on a fixed interval.

    The Timestamp variant records when the last successful scan finished,
    which the sensor exposes as last_scan for the dashboard card.
    """

    config_entry: NetworkScannerConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry: NetworkScannerConfigEntry,
        client: NetworkScannerClient,
        scan_interval_minutes: int,
    ) -> None:
        # config_entry is mandatory: omitting it stopped working in HA 2025.11
        # and the ContextVar fallback that used to cover for it is gone in 2026.8.
        super().__init__(
            hass,
            _LOGGER,
            config_entry=config_entry,
            name=f"{DOMAIN}_{client.ip_range}",
            update_interval=timedelta(minutes=scan_interval_minutes),
        )
        self.client = client

    async def _async_update_data(self) -> list[DeviceInfo]:
        """Run the blocking nmap scan off the event loop."""
        try:
            return await self.hass.async_add_executor_job(self.client.scan)
        except Exception as err:
            raise UpdateFailed(
                f"Network scan of {self.client.ip_range} failed: {err}"
            ) from err
