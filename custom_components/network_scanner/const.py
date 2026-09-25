"""Constants for the Network Scanner integration."""
from __future__ import annotations

DOMAIN = "network_scanner"

# Config entry data (immutable after creation)
CONF_IP_RANGE = "ip_range"

# Config entry options (editable via the options flow)
CONF_MAC_MAPPINGS = "mac_mappings"
CONF_SCAN_INTERVAL = "scan_interval"

DEFAULT_IP_RANGE = "192.168.1.0/24"
DEFAULT_SCAN_INTERVAL = 15  # minutes
MIN_SCAN_INTERVAL = 1
MAX_SCAN_INTERVAL = 24 * 60

# Legacy (config entry version 1 and configuration.yaml) numbered keys.
LEGACY_MAC_MAPPING_PREFIX = "mac_mapping_"

ATTR_DEVICES = "devices"
ATTR_IP_RANGE = "ip_range"
ATTR_LAST_SCAN = "last_scan"
