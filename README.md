# Network Scanner for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories/)
[![GitHub release](https://img.shields.io/github/v/release/kedube/ha-network-scanner)](https://github.com/kedube/ha-network-scanner/releases)
[![CI](https://github.com/kedube/ha-network-scanner/actions/workflows/ci.yaml/badge.svg)](https://github.com/kedube/ha-network-scanner/actions/workflows/ci.yaml)
![Home Assistant 2025.1+](https://img.shields.io/badge/Home%20Assistant-2025.1%2B-41BDF5.svg)
[![License](https://img.shields.io/github/license/kedube/ha-network-scanner)](LICENSE)

See every device on your home network in Home Assistant. Network Scanner finds devices with [nmap](https://nmap.org/), gives them the names you choose, and shows them on a searchable dashboard card.

![The Network Scanner card listing twelve devices on a home network, with summary tiles for all, known, unknown and private-MAC devices](https://raw.githubusercontent.com/kedube/ha-network-scanner/main/images/network-scanner-card.png)

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Network Scanner card](#network-scanner-card)
- [The sensor](#the-sensor)
- [Examples](#examples)
- [Other ways to show the devices](#other-ways-to-show-the-devices)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Removing the integration](#removing-the-integration)
- [Contributing and support](#contributing-and-support)

## Features

- **Finds every device** on one or more IP ranges and reports its IP address, MAC address, manufacturer and hostname.
- **Your names for your devices:** map MAC addresses to names and descriptions, so "3C:2A:F4:…" shows up as "Office printer".
- **Dashboard card included** and loaded automatically: summary tiles, search, vendor filter, sorting, device details and a **Scan now** button. It follows your light, dark or custom theme and works on phones.
- **Spots strangers:** see at a glance which devices aren't in your mappings yet, and which use private (randomized) MAC addresses.
- **Set up in the UI,** with a configurable scan interval (every 15 minutes by default). Mappings and the interval can be changed at any time.
- **Automation friendly:** a sensor with the device count and the full device list, ready for templates, automations and history graphs.
- **Local only:** no cloud service and no account.

## Quick start

1. [Install it with HACS](#hacs-recommended) and restart Home Assistant.
2. [Add the integration](#configuration) and enter your network's IP range, such as `192.168.1.0/24`.
3. Edit a dashboard, choose **Add card**, and pick **Network Scanner**.

## Requirements

- Home Assistant 2025.1 or newer.
- [HACS](https://hacs.xyz/), for the recommended installation.
- The `nmap` program, installed where Home Assistant runs. To report MAC addresses (which the device list needs), nmap must run as root or with the `CAP_NET_RAW` capability. The setup form checks that nmap works before it creates the integration.
- Home Assistant must be on the network it scans. nmap can only read the MAC addresses of devices on the same local network (the same subnet or VLAN) as Home Assistant, and devices without one aren't listed. To scan a second subnet, Home Assistant needs a network interface on it.

## Installation

### HACS (recommended)

This repository is not in the HACS default store, so add it to HACS as a custom repository. The quickest way is this button, which opens it in HACS on your Home Assistant:

[![Open your Home Assistant instance and open this repository inside HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=kedube&repository=ha-network-scanner&category=integration)

Or add it by hand:

1. In Home Assistant, open **HACS**.
2. Open the menu (**⋮**, top right) and choose **Custom repositories**.
3. Enter `https://github.com/kedube/ha-network-scanner`, choose the type **Integration**, and select **Add**.
4. Search HACS for **Network Scanner**, open it and select **Download**.
5. Restart Home Assistant.
6. [Add the integration](#configuration).

Already have Network Scanner installed from another repository, such as the original `parvez/network_scanner`? Both use the `network_scanner` domain, so only one can be installed at a time. Remove the old one in HACS first, but keep its entry under **Settings > Devices & services**. After you download this one and restart, the existing entry is upgraded automatically (see [Upgrading from 1.x](#upgrading-from-1x)).

### Updating

HACS offers each new release as an update and shows its release notes. Install the update, restart Home Assistant, and then refresh your browser so dashboards load the new version of the card. If you forget, the card reminds you (see [Card version](#card-version)).

### Manual installation

1. Download the source code of the [latest release](https://github.com/kedube/ha-network-scanner/releases/latest).
2. Copy its `custom_components/network_scanner` folder into the `custom_components` folder of your Home Assistant configuration directory, creating that folder if needed.
3. Restart Home Assistant.

Manual installs don't get update notifications. Repeat these steps to update.

## Configuration

[![Open your Home Assistant instance and start setting up Network Scanner.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=network_scanner)

1. Go to **Settings > Devices & services**.
2. Select **+ Add Integration** and search for **Network Scanner**.
3. Fill in the form:
   - **IP range**: one or more nmap targets separated by spaces, such as `192.168.1.0/24`, `192.168.1.1-254`, or `10.100.1.0/24 10.1.1.0/24` for several subnets.
   - **MAC address mappings** (optional): names for your devices, one per line (see below).
   - **Scan interval**: minutes between scans (default 15).

The mappings and the scan interval can be changed later with the integration's **Configure** button. The IP range identifies the entry and can't be changed after it's created, and the same range can't be added twice.

### MAC address mappings

Each line gives one device a name, in the form `MAC;name;description`:

```plaintext
bc:14:14:f1:81:1b;Office printer;Brother HL-L2350DW
b1:81:11:31:a1:b1;My iPhone;Apple
# The description is optional
aa:bb:cc:dd:ee:ff;Living room TV
```

- The **name** replaces "Unknown Device" everywhere the device appears.
- The **description** is optional free text, such as the model or manufacturer (the form calls it *manufacturer*). The card shows it under the name, and the sensor stores it as the device's `type`.
- MAC addresses can be written with colons or dashes, in upper or lower case. Lines starting with `#` are ignored.

The easiest way to find a MAC address is the card: open an unknown device and copy the ready-made mapping line it offers.

### More than one network

There are two ways to scan several ranges:

- **One combined list:** put all the ranges in one entry, separated by spaces.
- **A list per range:** add the integration once for each range. Each entry gets its own sensor: `sensor.network_scanner`, `sensor.network_scanner_2`, and so on. Use the card's `entity` option to choose which one a card shows.

Either way, Home Assistant must be on each of those networks (see [Requirements](#requirements)).

### Pre-filling the form from configuration.yaml

A `network_scanner:` block in `configuration.yaml` is used only to pre-fill the **Add Integration** form. It does not create the entry by itself.

```yaml
network_scanner:
  ip_range: "10.100.1.0/24 10.1.1.0/24"
  scan_interval: 15
  mac_mapping_1: "bc:14:14:f1:81:1b;Office printer;Brother HL-L2350DW"
  mac_mapping_2: "b1:81:11:31:a1:b1;My iPhone;Apple"
```

### Upgrading from 1.x

Existing entries are migrated automatically on first start: the numbered `mac_mapping_N` values are folded into the single multiline mappings field, which you can then edit under **Configure**. Entity IDs and history are preserved.

## Network Scanner card

The integration includes a dashboard card and loads it automatically, so there is nothing extra to install and no dashboard resource to add. After installing or updating the integration, restart Home Assistant and refresh your browser. Then edit a dashboard, choose **Add card** and search for **Network Scanner**, or add it in YAML:

```yaml
type: custom:network-scanner-card
entity: sensor.network_scanner
```

<p align="center">
  <img src="https://raw.githubusercontent.com/kedube/ha-network-scanner/main/images/network-scanner-card-mobile.png" width="360" alt="The card on a phone in dark mode, filtered to unknown devices, with one device opened to show its details and a ready-made mapping line">
</p>

What the card shows:

- **Summary tiles** for all devices, known devices (named in your MAC mappings), unknown devices, and devices using a private (randomized) MAC address. Select a tile to show only that group.
- **Search** across name, description, IP, MAC (with or without colons), vendor and hostname, plus a **vendor filter**.
- **Sorting** by any column: select a column header, or use the sort menu when the card is narrow.
- **Device details**: select a device to see every field, copy its IP or MAC, or open its web interface. Unknown devices also get a ready-made mapping line to paste into the integration's **Configure** dialog.
- **Layout**: a table when the card is wide enough for the chosen columns, and a compact list otherwise (for example on phones or in a single dashboard column).
- **Theming**: colors come from your Home Assistant theme, so the card follows light mode, dark mode and custom themes.
- A **Scan now** button in the header, and the time of the last scan.

All options are available in the visual editor:

| Option | Default | Description |
|--------|---------|-------------|
| `entity` | first Network Scanner sensor | The Network Scanner sensor to display. |
| `title` | the sensor's name | Card title. |
| `columns` | `[ip, mac, vendor]` | Table columns shown after the device name. Any of `ip`, `mac`, `vendor`, `hostname`, `type` (the description). |
| `sort_by` | `ip` | Initial sort: `name`, `ip`, `mac`, `vendor`, `hostname` or `type`. |
| `sort_order` | `asc` | `asc` or `desc`. |
| `layout` | `auto` | `auto`, `table` or `list`. |
| `max_height` | none | Height after which the device list scrolls, such as `480px`. |
| `show_stats` | `true` | Show the summary tiles. |
| `show_toolbar` | `true` | Show search, vendor filter and sort controls. |
| `show_scan_button` | `true` | Show the **Scan now** button. |

For example, a compact card for a phone dashboard, sorted by name:

```yaml
type: custom:network-scanner-card
entity: sensor.network_scanner
title: Home network
sort_by: name
layout: list
max_height: 480px
```

### Card version

The card has no version of its own: it always comes from the integration release you have installed, so there is nothing to update or match up separately.

- Its address includes the integration's version (for example `/network_scanner/network-scanner-card.js?v=2.3`), so every update gives it a new address and browsers can't keep using a cached older card.
- To see which version a page loaded, open the browser's developer console and look for `NETWORK-SCANNER-CARD v2.3`. The integration's own version is on its device page under **Settings > Devices & services > Network Scanner**.
- If a page was left open during an update, the card shows a notice that it's from a different release, with a **Refresh** button that loads the matching one.

## The sensor

Each integration entry creates one sensor, `sensor.network_scanner` for the first. Its state is the number of devices found by the last scan: `unknown` until the first scan finishes, and `unavailable` while scans are failing.

| Attribute | Contents |
|-----------|----------|
| `devices` | Every device found by the last scan, in IP address order (fields below). |
| `ip_range` | The range this sensor scans. |
| `last_scan` | When the last successful scan finished, as an ISO 8601 timestamp. |

Each device in `devices` has these fields:

| Field | Contents |
|-------|----------|
| `ip` | IPv4 address. |
| `mac` | MAC address, in upper case with colons, such as `BC:14:14:F1:81:1B`. |
| `name` | The name from your MAC mappings, or `Unknown Device`. |
| `type` | The description from your MAC mappings, or `Unknown Device`. |
| `vendor` | The manufacturer, looked up by nmap from the MAC address, or `Unknown`. It is always `Unknown` for devices with a private MAC address. |
| `hostname` | The device's short hostname from reverse DNS, or `null` if it has none. |

The device count is kept in history and long-term statistics, so a history or statistics graph shows how many devices were online over time. The device list and `last_scan` are left out of the database to keep it small; templates and cards always read their current values.

## Examples

### Scan on demand

The card's **Scan now** button runs this action, and you can use it in your own automations and scripts:

```yaml
action: homeassistant.update_entity
target:
  entity_id: sensor.network_scanner
```

### Count the devices you haven't named

A [template sensor](https://www.home-assistant.io/integrations/template/) that counts devices not in your MAC mappings:

```yaml
template:
  - sensor:
      - name: Unknown network devices
        unique_id: network_scanner_unknown_devices
        state: >
          {{ state_attr('sensor.network_scanner', 'devices') | default([], true)
             | selectattr('name', 'eq', 'Unknown Device') | list | count }}
```

### Get notified when an unknown device shows up

Using the template sensor above, this automation posts a notification listing the unknown devices whenever there are more of them than before. A phone that isn't in your mappings counts again each time it rejoins, so add the devices you recognize to your mappings.

```yaml
automation:
  - alias: Tell me about unknown devices on the network
    triggers:
      - trigger: state
        entity_id: sensor.unknown_network_devices
    conditions:
      - condition: template
        value_template: >
          {{ trigger.from_state is not none
             and trigger.to_state.state | int(0) > trigger.from_state.state | int(0) }}
    actions:
      - action: persistent_notification.create
        data:
          title: New device on the network
          message: |
            {% for device in state_attr('sensor.network_scanner', 'devices')
                 if device.name == 'Unknown Device' -%}
            - {{ device.ip }} ({{ device.mac }}){% if device.hostname %}, {{ device.hostname }}{% endif %}
            {% endfor %}
```

## Other ways to show the devices

The [Network Scanner card](#network-scanner-card) is the easiest way to show the devices, but any card that can read the `devices` attribute works.

### Markdown card

```yaml
type: markdown
content: >
  ## Devices

  | IP Address | MAC Address | Custom Name | Custom Description | Hostname | Vendor |
  |------------|-------------|-------------|--------------------|----------|--------|

  {% for device in state_attr('sensor.network_scanner', 'devices') %}
  | {{ device.ip }} | {{ device.mac }} | {{ device.name }} | {{ device.type }} | {{ device.hostname }} | {{ device.vendor }} |
  {% endfor %}
```

![A Markdown card showing the devices as a table](https://github.com/parvez/network_scanner/assets/126749/64309b93-a8cd-43b6-93ab-58d55a4aac32)

### Flex Table card

Thanks to [@gridlockjoe](https://github.com/gridlockjoe), you can also use the [Flex Table card](https://github.com/custom-cards/flex-table-card):

```yaml
type: custom:flex-table-card
title: Devices
entities:
  include: sensor.network_scanner
sort_by: x.ip+
columns:
  - name: IP Address
    data: devices
    modify: x.ip
  - name: MAC Address
    data: devices
    modify: x.mac
  - name: Custom Name
    data: devices
    modify: x.name
  - name: Custom Description
    data: devices
    modify: x.type
  - name: Hostname
    data: devices
    modify: x.hostname
  - name: Vendor
    data: devices
    modify: x.vendor
```

![A Flex Table card showing the devices as a sortable table](https://github.com/parvez/network_scanner/assets/126749/b55f58ee-2f89-415f-b09b-fc457e52a074)

## How it works

On every scan (every 15 minutes unless you change it), Network Scanner:

1. Runs an nmap ping sweep (`nmap -sn`) over your IP range. This only checks which addresses are in use; it doesn't scan ports. On the local network nmap asks with ARP, so it also finds devices that ignore pings, as long as they're awake.
2. Records the IP address and MAC address of each device that answered, and the manufacturer that nmap looks up from the MAC address.
3. Names each device from your MAC mappings, and looks up hostnames with reverse DNS, all devices at once.
4. Updates the sensor, which updates the card.

Scans are bounded, so a problem on the network can't stall them: nmap gets at most 10 minutes and the hostname lookups 10 seconds. The first scan runs in the background after Home Assistant starts, so it doesn't slow startup.

Everything runs on your Home Assistant host. Hostname lookups go to the DNS server Home Assistant uses; nothing else leaves your network.

## Troubleshooting

**Adding the integration says nmap could not be found.** Install nmap where Home Assistant runs, then try again.

**The sensor reports 0 devices although devices are online.** nmap is probably running without root or the `CAP_NET_RAW` capability, so it can't read MAC addresses. A warning is logged once per start when this happens.

**A subnet shows no devices.** Home Assistant must have a network interface on each network it scans, because nmap can't see MAC addresses across a router (see [Requirements](#requirements)).

**Devices show a vendor ("TP-Link device") or "Unknown device" instead of a name, and no hostname.** Those devices have no name in your DNS server (no reverse DNS record), so there is nothing to show. Give them names with [MAC address mappings](#mac-address-mappings). Versions before 2.2.1 showed "192" instead; update to fix that.

**A phone or laptop keeps appearing as a new unknown device.** It uses a private (randomized) MAC address, which can change, so a mapping for the old address no longer matches. The card counts these devices under **Private MAC**. For devices you own, turn off the private or randomized address for your home network in their Wi-Fi settings, then map the device's real MAC address.

**The card isn't in the card picker, or a dashboard says "Custom element doesn't exist: network-scanner-card".** Restart Home Assistant after installing or updating, then refresh the browser. If it's still missing, check the browser's developer console for the `NETWORK-SCANNER-CARD` line, and the Home Assistant log for "Network Scanner card not loaded".

**The card says "Scanner unavailable".** The last scan failed. The Home Assistant log says why.

**Still stuck?** Turn on debug logging: in **Settings > Devices & services**, open **Network Scanner**, and choose **Enable debug logging** from the menu. Or add this to `configuration.yaml`:

```yaml
logger:
  logs:
    custom_components.network_scanner: debug
```

Then run a scan and check the log. Include it when you [report a problem](https://github.com/kedube/ha-network-scanner/issues).

## Removing the integration

1. Remove any Network Scanner cards from your dashboards.
2. In **Settings > Devices & services**, open **Network Scanner** and delete each of its entries.
3. In **HACS**, open **Network Scanner** and choose **Remove** from its menu.
4. Restart Home Assistant.

## Contributing and support

- Found a bug or have an idea? [Open an issue](https://github.com/kedube/ha-network-scanner/issues).
- Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers running the tests, what CI checks, and how releases work.

Releases are automatic: once every check passes on a push to `main` that changes the integration, a new version is tagged and published. The version number and the release notes are worked out from the commit messages.

## Credits and license

Network Scanner was created by [@parvez](https://github.com/parvez/network_scanner). Thanks to everyone who has contributed to it since.

Released under the [MIT License](LICENSE).
