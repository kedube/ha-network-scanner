/*
 * Network Scanner card for Home Assistant dashboards.
 *
 * Served and auto-loaded by the network_scanner integration (see __init__.py),
 * so there is no dashboard resource to add by hand. Deliberately a plain custom
 * element with no dependencies and no build step - the integration ships this
 * file as-is. Every color comes from Home Assistant theme variables, which is
 * what makes light mode, dark mode and custom themes follow the user's theme
 * instead of being hard-coded here.
 */

const CARD_TAG = "network-scanner-card";
const EDITOR_TAG = "network-scanner-card-editor";
const DOMAIN = "network_scanner";

// The integration serves this file as network-scanner-card.js?v=<its version>
// (see __init__.py), so this is the integration release the card shipped with.
// "unknown" when the file was loaded some other way, such as a dashboard
// resource added by hand without ?v=.
const CARD_VERSION = new URL(import.meta.url).searchParams.get("v") || "unknown";

// scanner.py fills both `name` and `type` with this when a MAC has no mapping,
// and nmap reports UNKNOWN_VENDOR when the OUI is not in its database.
const UNMAPPED = "Unknown Device";
const UNKNOWN_VENDOR = "Unknown";

// Vendor-filter value for devices with no vendor; not a string nmap can return.
const NO_VENDOR = "__none__";

const COLUMN_LABELS = {
  name: "Device",
  ip: "IP address",
  mac: "MAC address",
  vendor: "Vendor",
  hostname: "Hostname",
  type: "Description",
};
const OPTIONAL_COLUMNS = ["ip", "mac", "vendor", "hostname", "type"];
const SORT_KEYS = ["name", ...OPTIONAL_COLUMNS];

// [grid track, narrowest useful width in px] per column. When the configured
// columns stop fitting side by side, the card switches to its list layout.
const COLUMN_TRACKS = {
  name: ["minmax(180px, 2fr)", 180],
  ip: ["minmax(120px, 0.8fr)", 120],
  mac: ["minmax(140px, 0.9fr)", 140],
  vendor: ["minmax(96px, 1.2fr)", 96],
  hostname: ["minmax(96px, 1fr)", 96],
  type: ["minmax(96px, 1fr)", 96],
};
const COLUMN_GAP = 12;
const ROW_PADDING = 32;
const CHEVRON_TRACK = 20;
// Extra room required before switching back to the table, so a card sitting
// right at the threshold doesn't flip layouts as page scrollbars come and go.
const LAYOUT_HYSTERESIS = 24;
// Below this width the summary tiles go 2x2 and the search box takes a full row.
const COMPACT_WIDTH = 460;

const DEFAULTS = {
  columns: ["ip", "mac", "vendor"],
  sort_by: "ip",
  sort_order: "asc",
  layout: "auto",
  show_stats: true,
  show_toolbar: true,
  show_scan_button: true,
};

const STATUS_FILTERS = [
  {
    id: "all",
    label: "Devices",
    icon: "mdi:lan-connect",
    hint: "Every device found by the last scan",
    test: () => true,
  },
  {
    id: "known",
    label: "Known",
    icon: "mdi:tag-check-outline",
    hint: "Named in your MAC mapping",
    test: (d) => d.mapped,
  },
  {
    id: "unknown",
    label: "Unknown",
    icon: "mdi:help-circle-outline",
    hint: "Not in your MAC mapping yet",
    test: (d) => !d.mapped,
  },
  {
    id: "private",
    label: "Private MAC",
    icon: "mdi:incognito",
    hint: "Randomized MAC address, typical of phones, tablets and laptops",
    test: (d) => d.privateMac,
  },
];

// Best-effort device icon, matched in order against the mapped name,
// description, hostname and vendor. A miss just falls back to DEFAULT_ICON.
const DEVICE_ICONS = [
  ["mdi:printer", /printer|laserjet|officejet|deskjet|\b(brother|epson|canon|lexmark|kyocera|xerox|ricoh)\b/],
  ["mdi:cctv", /camera|doorbell|\bcam\b|\b(hikvision|dahua|reolink|amcrest|wyze|arlo|foscam|ring)\b/],
  [
    "mdi:router-wireless",
    /router|gateway|access[ -]?point|\b(mesh|ubiquiti|unifi|netgear|tp-?link|mikrotik|eero|orbi|deco|openwrt|pfsense|opnsense|firewall|aruba|linksys|zyxel|draytek|fritz)\b/,
  ],
  ["mdi:speaker", /speaker|soundbar|\b(sonos|echo|alexa|homepod|bose|denon|marantz)\b|nest[ -]?(mini|audio)|google[ -]?home/],
  ["mdi:television", /\btv\b|television|\b(roku|chromecast|bravia|vizio|webos|tizen|hisense)\b|fire[ -]?tv|apple[ -]?tv/],
  ["mdi:controller", /\b(nintendo|playstation|xbox|ps[345])\b|steam[ -]?deck|\bconsole\b/],
  ["mdi:tablet", /\b(ipad|tablet|kindle)\b/],
  ["mdi:laptop", /laptop|macbook|notebook|thinkpad|chromebook/],
  ["mdi:cellphone", /phone|android|\b(pixel|galaxy)\b/],
  ["mdi:watch", /\bwatch\b|fitbit|garmin/],
  ["mdi:server", /server|\bnas\b|\b(synology|qnap|unraid|truenas|proxmox|esxi)\b|raspberry|home[ -]?assistant|\bhassio\b/],
  ["mdi:desktop-tower-monitor", /desktop|workstation|\bpc\b|\bimac\b|mac[ -]?(mini|studio|pro)\b/],
  [
    "mdi:chip",
    /espressif|esphome|\besp(32|8266)?\b|\b(shelly|tuya|sonoff|tasmota|zigbee|hue|signify|lifx|nanoleaf|wiz|kasa|meross|ecobee|tado|netatmo|plug|bulb|thermostat|sensor)\b|smart[ -]?plug/,
  ],
];
const DEFAULT_ICON = "mdi:devices";

// ---------------------------------------------------------------- helpers

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const VENDOR_SUFFIX =
  /[\s,]+(inc|incorporated|ltd|limited|llc|co|corp|corporation|company|gmbh|ag|sa|s\.a|bv|b\.v|pte|plc|ind|technologies|technology|electronics|trading|international|industries|holdings|group)\.?$/i;

/** "TP-LINK TECHNOLOGIES CO.,LTD." -> "TP-LINK", for "<vendor> device" labels. */
function shortVendor(vendor) {
  let short = vendor.split(",")[0].trim();
  while (VENDOR_SUFFIX.test(short)) short = short.replace(VENDOR_SUFFIX, "").trim();
  return short || vendor;
}

/** Dotted IPv4 as a single number so 10.0.0.9 sorts before 10.0.0.10. */
function ipToNumber(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return Number.MAX_SAFE_INTEGER;
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

function normalizeDevice(raw) {
  const clean = (value, placeholder) => {
    const text = String(value ?? "").trim();
    return text && text !== placeholder ? text : "";
  };
  const ip = clean(raw?.ip);
  const mac = clean(raw?.mac).toUpperCase();
  const name = clean(raw?.name, UNMAPPED);
  const type = clean(raw?.type, UNMAPPED);
  const vendor = clean(raw?.vendor, UNKNOWN_VENDOR);
  const hostname = clean(raw?.hostname);

  let label = name;
  let labelSource = "name";
  if (!label && hostname) [label, labelSource] = [hostname, "hostname"];
  if (!label && vendor) [label, labelSource] = [`${shortVendor(vendor)} device`, "vendor"];
  if (!label) [label, labelSource] = ["Unknown device", "none"];

  // Bit 1 of the first octet marks a locally administered address - what
  // phones and laptops use for per-network "private" (randomized) MACs.
  const firstOctet = parseInt(mac.slice(0, 2), 16);
  const privateMac = Number.isFinite(firstOctet) && (firstOctet & 0x02) === 0x02;

  const hints = [name, type, hostname, vendor].join(" ").toLowerCase();
  const icon = DEVICE_ICONS.find(([, pattern]) => pattern.test(hints))?.[0] ?? DEFAULT_ICON;

  const key = mac || ip;
  return {
    key,
    domId: `nsc-${key.replace(/[^a-z0-9]/gi, "")}`,
    ip,
    ipNum: ipToNumber(ip),
    mac,
    name,
    type,
    vendor,
    hostname,
    label,
    labelSource,
    mapped: Boolean(name),
    privateMac,
    icon,
    haystack: [label, name, type, vendor, hostname, ip, mac, mac.replace(/:/g, "")].join(" ").toLowerCase(),
  };
}

function queryTokens(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Escaped text with every search-token match wrapped in <mark>. */
function highlight(text, tokens) {
  const source = String(text ?? "");
  if (!tokens.length || !source) return esc(source);
  const lower = source.toLowerCase();
  const ranges = [];
  for (const token of tokens) {
    for (let i = lower.indexOf(token); i !== -1; i = lower.indexOf(token, i + token.length)) {
      ranges.push([i, i + token.length]);
    }
  }
  if (!ranges.length) return esc(source);
  ranges.sort((a, b) => a[0] - b[0]);
  let html = "";
  let pos = 0;
  for (const [start, end] of ranges) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    html += `${esc(source.slice(pos, from))}<mark>${esc(source.slice(from, end))}</mark>`;
    pos = end;
  }
  return html + esc(source.slice(pos));
}

function relativeTime(date) {
  const seconds = Math.min(0, (date.getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds > -45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (seconds > -3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (seconds > -86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

function isScannerState(state) {
  const devices = state?.attributes?.devices;
  return Array.isArray(devices) && (devices.length === 0 || ("ip" in devices[0] && "mac" in devices[0]));
}

/** The integration version Home Assistant is running: the sw_version of the sensor's device. */
function runningIntegrationVersion(hass, entityId) {
  const deviceId = hass?.entities?.[entityId]?.device_id;
  return deviceId ? hass.devices?.[deviceId]?.sw_version || undefined : undefined;
}

function findScannerEntity(hass) {
  if (!hass?.states) return undefined;
  const sensors = Object.keys(hass.states).filter((id) => id.startsWith("sensor."));
  return (
    sensors.find((id) => hass.entities?.[id]?.platform === DOMAIN) ??
    sensors.find((id) => isScannerState(hass.states[id]))
  );
}

async function copyText(text, root) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard only exists on secure origins, and Home Assistant
    // is very often opened over plain http on the LAN. Fall back to the
    // selection-based copy the HA frontend itself uses.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    root.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- styles

const STYLES = `
  :host {
    display: block;
    --nsc-accent: var(--primary-color, #03a9f4);
    --nsc-text: var(--primary-text-color, #212121);
    --nsc-muted: var(--secondary-text-color, #727272);
    --nsc-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
    --nsc-surface: var(--ha-card-background, var(--card-background-color, #fff));
    --nsc-error: var(--error-color, #db4437);
    /* Tints are mixed from the theme's own text/accent colors over a
       transparent base, so they read correctly on light and dark cards alike. */
    --nsc-fill: color-mix(in srgb, var(--nsc-text) 5%, transparent);
    --nsc-fill-strong: color-mix(in srgb, var(--nsc-text) 9%, transparent);
    --nsc-accent-fill: color-mix(in srgb, var(--nsc-accent) 14%, transparent);
    --nsc-accent-fill-strong: color-mix(in srgb, var(--nsc-accent) 22%, transparent);
    --nsc-mono: var(--code-font-family, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  }
  [hidden] { display: none !important; }
  ha-card { overflow: hidden; }
  button { font: inherit; }

  .card { color: var(--nsc-text); }
  .card:not([data-mode="ready"]) :is(.stats, .toolbar, .list-head, .foot) { display: none; }

  /* header */
  .head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 12px; }
  .head-badge {
    flex: none; width: 40px; height: 40px; border-radius: 12px;
    display: grid; place-items: center;
    background: var(--nsc-accent-fill); color: var(--nsc-accent); --mdc-icon-size: 22px;
  }
  .head-text { flex: 1; min-width: 0; }
  .title { margin: 0; font-size: 16px; font-weight: 500; line-height: 22px; }
  .subtitle { font-size: 13px; line-height: 18px; color: var(--nsc-muted); }
  .title, .subtitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subtitle .busy { color: var(--nsc-accent); }
  .subtitle .error { color: var(--nsc-error); }

  .icon-btn {
    all: unset; box-sizing: border-box; flex: none; cursor: pointer;
    width: 36px; height: 36px; border-radius: 50%;
    display: inline-grid; place-items: center;
    color: var(--nsc-muted); --mdc-icon-size: 20px;
    transition: background-color 0.15s, color 0.15s;
  }
  .icon-btn:hover { background: var(--nsc-fill-strong); color: var(--nsc-text); }
  .icon-btn.sm { width: 28px; height: 28px; --mdc-icon-size: 16px; }
  .icon-btn.copied, .btn.copied { color: var(--success-color, #43a047); }
  .scan[aria-busy="true"] { color: var(--nsc-accent); cursor: progress; }
  .scan[aria-busy="true"] ha-icon { animation: nsc-spin 1.1s linear infinite; }

  :is(.icon-btn, .tile, .th, .btn, .link):focus-visible,
  :is(.search, .select):focus-within {
    outline: 2px solid var(--nsc-accent); outline-offset: 1px;
  }

  /* summary tiles */
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 0 16px 12px; }
  .compact .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile {
    all: unset; box-sizing: border-box; cursor: pointer; min-width: 0;
    display: flex; flex-direction: column; gap: 2px; padding: 10px 12px;
    border-radius: 12px; border: 1px solid transparent; background: var(--nsc-fill);
    transition: background-color 0.15s, border-color 0.15s;
  }
  .tile:hover { background: var(--nsc-fill-strong); }
  .tile[aria-pressed="true"] {
    background: var(--nsc-accent-fill);
    border-color: color-mix(in srgb, var(--nsc-accent) 50%, transparent);
  }
  .tile-top {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    font-size: 12px; line-height: 16px; color: var(--nsc-muted); --mdc-icon-size: 16px;
  }
  .tile-top span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile[aria-pressed="true"] .tile-top ha-icon { color: var(--nsc-accent); }
  .tile-value { font-size: 22px; font-weight: 500; line-height: 28px; }

  /* toolbar */
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; }
  .search, .select {
    box-sizing: border-box; height: 40px; border-radius: 20px;
    background: var(--nsc-fill); color: var(--nsc-muted);
  }
  .search {
    flex: 1 1 220px; min-width: 0; display: flex; align-items: center; gap: 8px;
    padding: 0 4px 0 12px; --mdc-icon-size: 20px;
  }
  .compact .search { flex-basis: 100%; }
  .search input {
    all: unset; flex: 1; min-width: 0; height: 100%;
    font-size: 14px; color: var(--nsc-text);
  }
  .search input::placeholder { color: var(--nsc-muted); opacity: 1; }
  .search input::-webkit-search-cancel-button { display: none; }
  .select { position: relative; display: flex; align-items: center; min-width: 0; }
  .select select {
    appearance: none; -webkit-appearance: none; border: 0; outline: none; margin: 0;
    height: 100%; width: 100%; max-width: 220px; padding: 0 34px 0 14px;
    border-radius: inherit; background: transparent; cursor: pointer;
    font: inherit; font-size: 14px; color: var(--nsc-text);
    text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
  }
  .select ha-icon {
    position: absolute; right: 10px; pointer-events: none; --mdc-icon-size: 18px;
  }
  .compact .vendor-select { flex: 1 1 auto; }
  .compact .vendor-select select { max-width: none; }
  .sort-group { display: none; align-items: center; gap: 2px; min-width: 0; }
  .narrow .sort-group { display: flex; }

  /* device list */
  .list-wrap { border-top: 1px solid var(--nsc-divider); overflow-x: auto; }
  .scroll .list-wrap { max-height: var(--nsc-max-height); overflow-y: auto; overscroll-behavior: contain; }
  .card:not(.narrow) :is(.list-head, .list) { min-width: var(--nsc-table-min); }
  .list-head {
    display: grid; grid-template-columns: var(--nsc-cols); column-gap: ${COLUMN_GAP}px; align-items: center;
    padding: 0 16px; min-height: 40px;
    border-bottom: 1px solid var(--nsc-divider); background: var(--nsc-surface);
  }
  .scroll .list-head { position: sticky; top: 0; z-index: 1; }
  .th {
    all: unset; cursor: pointer; justify-self: start; min-width: 0;
    display: inline-flex; align-items: center; gap: 4px;
    margin-left: -6px; padding: 4px 6px; border-radius: 6px;
    font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap;
    color: var(--nsc-muted); --mdc-icon-size: 14px;
  }
  .th[data-sort="name"] { margin-left: 42px; }
  .th:hover { color: var(--nsc-text); }
  .th ha-icon { opacity: 0; transition: opacity 0.15s; }
  .th:hover ha-icon { opacity: 0.5; }
  .th.active { color: var(--nsc-text); }
  .th.active ha-icon { opacity: 1; color: var(--nsc-accent); }

  .list { list-style: none; margin: 0; padding: 0 0 8px; }
  .device + .device { border-top: 1px solid var(--nsc-divider); }
  .device.open { background: color-mix(in srgb, var(--nsc-accent) 4%, transparent); }
  .row {
    all: unset; box-sizing: border-box; width: 100%; cursor: pointer;
    display: grid; grid-template-columns: var(--nsc-cols); column-gap: ${COLUMN_GAP}px; align-items: center;
    min-height: 60px; padding: 10px 16px;
    transition: background-color 0.12s;
  }
  .narrow .row { grid-template-columns: 36px minmax(0, 1fr) auto ${CHEVRON_TRACK}px; }
  .row:hover { background: var(--nsc-fill); }
  .row:focus-visible { outline: 2px solid var(--nsc-accent); outline-offset: -2px; }
  .name-cell { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .avatar {
    flex: none; width: 36px; height: 36px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--nsc-accent-fill); color: var(--nsc-accent); --mdc-icon-size: 20px;
  }
  .unmapped .avatar { background: var(--nsc-fill-strong); color: var(--nsc-muted); }
  .ident { display: flex; flex-direction: column; min-width: 0; }
  .primary { font-size: 14px; font-weight: 500; line-height: 20px; }
  .secondary { font-size: 12.5px; line-height: 18px; color: var(--nsc-muted); }
  .primary, .secondary, .cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cell { min-width: 0; font-size: 14px; }
  .trail { font-size: 13px; }
  .mono { font-family: var(--nsc-mono); font-size: 13px; font-variant-numeric: tabular-nums; }
  .secondary .mono { font-size: 12px; }
  .muted { color: var(--nsc-muted); }
  .chevron { color: var(--nsc-muted); --mdc-icon-size: 20px; transition: transform 0.2s; }
  .open .chevron { transform: rotate(180deg); }
  mark {
    color: inherit; border-radius: 3px;
    background: color-mix(in srgb, var(--nsc-accent) 28%, transparent);
  }

  /* expanded details */
  .details { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 2px 16px 16px 64px; }
  .narrow .details { padding-left: 16px; }
  .details.reveal { animation: nsc-reveal 0.18s ease-out; }
  .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 24px; margin: 0; }
  .fact { min-width: 0; }
  .fact dt { font-size: 12px; line-height: 16px; color: var(--nsc-muted); }
  .fact dd {
    margin: 0; min-height: 28px; display: flex; align-items: center; gap: 2px;
    font-size: 14px; overflow-wrap: anywhere;
  }
  .note {
    display: flex; align-items: flex-start; gap: 10px; margin: 0; padding: 10px 12px;
    border-radius: 10px; background: var(--nsc-fill);
    font-size: 13px; line-height: 1.45; color: var(--nsc-muted); --mdc-icon-size: 18px;
  }
  .note ha-icon { flex: none; margin-top: 1px; color: var(--nsc-accent); }
  .note-body { min-width: 0; flex: 1; }
  .snippet {
    display: flex; align-items: center; gap: 4px; margin-top: 8px; padding: 2px 2px 2px 10px;
    border-radius: 8px; border: 1px solid var(--nsc-divider); background: var(--nsc-surface);
  }
  .snippet code {
    flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
    font-family: var(--nsc-mono); font-size: 12.5px; color: var(--nsc-text);
  }
  .update { align-items: center; margin: 0 16px 12px; }
  .update .btn { flex: none; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn {
    all: unset; box-sizing: border-box; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px;
    border-radius: 17px; background: var(--nsc-accent-fill);
    font-size: 13.5px; font-weight: 500; color: var(--nsc-accent); --mdc-icon-size: 16px;
    transition: background-color 0.15s;
  }
  .btn:hover { background: var(--nsc-accent-fill-strong); }

  /* empty and error states */
  .empty {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 32px 24px 36px; text-align: center; color: var(--nsc-muted);
  }
  .empty-icon {
    width: 56px; height: 56px; margin-bottom: 6px; border-radius: 50%;
    display: grid; place-items: center; background: var(--nsc-fill); --mdc-icon-size: 28px;
  }
  .empty-title { font-size: 15px; font-weight: 500; color: var(--nsc-text); }
  .empty-text { max-width: 340px; font-size: 13px; line-height: 1.45; }
  .empty .btn { margin-top: 10px; }
  .empty.pending .empty-icon { background: var(--nsc-accent-fill); color: var(--nsc-accent); }
  .empty.pending .empty-icon ha-icon { animation: nsc-spin 2s linear infinite; }
  .empty.error .empty-icon { background: color-mix(in srgb, var(--nsc-error) 14%, transparent); color: var(--nsc-error); }

  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 16px; border-top: 1px solid var(--nsc-divider);
    font-size: 13px; color: var(--nsc-muted);
  }
  .foot strong { font-weight: 500; color: var(--nsc-text); }
  .link { all: unset; cursor: pointer; border-radius: 4px; font-weight: 500; color: var(--nsc-accent); }

  @keyframes nsc-spin { to { transform: rotate(360deg); } }
  @keyframes nsc-reveal { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;

// ---------------------------------------------------------------- card

class NetworkScannerCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass) {
    const entity = findScannerEntity(hass);
    return entity ? { entity } : {};
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = [];
    this._byKey = new Map();
    this._counts = {};
    this._vendorSignature = "";
    this._expanded = new Set();
    this._query = "";
    this._status = "all";
    this._vendor = "";
    this._scanning = false;
    this._narrow = true;
    this._width = 0;
    this._renderQueued = false;

    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("input", (ev) => this._onInput(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("keydown", (ev) => this._onKeyDown(ev));
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    const columns = config.columns ?? DEFAULTS.columns;
    if (!Array.isArray(columns)) throw new Error("columns must be a list");
    for (const column of columns) {
      if (!OPTIONAL_COLUMNS.includes(column)) {
        throw new Error(`Unknown column "${column}". Use any of: ${OPTIONAL_COLUMNS.join(", ")}`);
      }
    }
    const sortBy = config.sort_by ?? DEFAULTS.sort_by;
    if (!SORT_KEYS.includes(sortBy)) {
      throw new Error(`Unknown sort_by "${sortBy}". Use one of: ${SORT_KEYS.join(", ")}`);
    }
    const sortOrder = config.sort_order ?? DEFAULTS.sort_order;
    if (!["asc", "desc"].includes(sortOrder)) throw new Error('sort_order must be "asc" or "desc"');
    const layout = config.layout ?? DEFAULTS.layout;
    if (!["auto", "table", "list"].includes(layout)) throw new Error('layout must be "auto", "table" or "list"');

    this._config = { ...DEFAULTS, ...config, columns: [...new Set(columns)] };
    this._sortBy = sortBy;
    this._sortDir = sortOrder;

    const tableColumns = ["name", ...this._config.columns];
    this._tableMinWidth =
      tableColumns.reduce((sum, column) => sum + COLUMN_TRACKS[column][1], 0) +
      COLUMN_GAP * tableColumns.length +
      CHEVRON_TRACK +
      ROW_PADDING;
    this._narrow = layout === "list" || (layout === "auto" && this._width < this._tableMinWidth);

    this._renderShell();
    this._stale = true;
    this._refresh();
  }

  set hass(hass) {
    const darkMode = hass?.themes?.darkMode;
    if (darkMode !== undefined && darkMode !== this._hass?.themes?.darkMode) {
      // Native controls (select popups, scrollbars) follow color-scheme, not
      // the theme variables, so tell the browser which way the theme leans.
      this.style.colorScheme = darkMode ? "dark" : "light";
    }
    this._hass = hass;
    this._refresh();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._resizeObserver ??= new ResizeObserver((entries) => this._applyWidth(entries[0].contentRect.width));
    this._resizeObserver.observe(this);
    // Keep "Scanned 3 minutes ago" honest between state updates.
    this._clock = window.setInterval(() => this._renderHeader(), 30_000);
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    window.clearInterval(this._clock);
  }

  getCardSize() {
    const c = this._config ?? DEFAULTS;
    return 2 + (c.show_stats ? 2 : 0) + (c.show_toolbar ? 1 : 0) + Math.min(this._devices.length || 3, 10);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  // ------------------------------------------------------------ data

  get _entityId() {
    return this._config?.entity || this._autoEntity;
  }

  _refresh() {
    if (!this._config || !this._hass) return;
    if (!this._config.entity && !this._hass.states[this._autoEntity]) {
      this._autoEntity = findScannerEntity(this._hass);
    }
    // Before the early return below: an upgrade changes the device registry,
    // not necessarily the sensor's state.
    this._syncVersionNotice();
    const stateObj = this._entityId ? this._hass.states[this._entityId] : undefined;
    // hass is replaced on every state change anywhere in Home Assistant; only
    // this entity's state object changing means there is anything to redraw.
    // _stale covers a fresh shell, which must render even if the entity is
    // still missing (undefined === undefined).
    if (!this._stale && stateObj === this._stateObj) return;
    this._stale = false;
    this._stateObj = stateObj;
    this._processDevices();
    this._update();
  }

  _processDevices() {
    const raw = this._stateObj?.attributes?.devices;
    this._devices = Array.isArray(raw) ? raw.map(normalizeDevice) : [];
    this._byKey = new Map(this._devices.map((d) => [d.key, d]));

    this._counts = Object.fromEntries(
      STATUS_FILTERS.map((f) => [f.id, this._devices.filter((d) => f.test(d)).length])
    );

    const vendors = new Map();
    for (const d of this._devices) {
      const vendor = d.vendor || NO_VENDOR;
      vendors.set(vendor, (vendors.get(vendor) ?? 0) + 1);
    }
    this._vendors = [...vendors].sort(
      ([a, na], [b, nb]) => (a === NO_VENDOR) - (b === NO_VENDOR) || nb - na || collator.compare(a, b)
    );
    if (this._vendor && !vendors.has(this._vendor)) this._vendor = "";
  }

  _visibleDevices(tokens) {
    const status = STATUS_FILTERS.find((f) => f.id === this._status) ?? STATUS_FILTERS[0];
    const vendor = this._vendor;
    const matches = this._devices.filter(
      (d) =>
        status.test(d) &&
        (!vendor || (vendor === NO_VENDOR ? !d.vendor : d.vendor === vendor)) &&
        tokens.every((t) => d.haystack.includes(t))
    );

    const key = this._sortBy;
    const dir = this._sortDir === "desc" ? -1 : 1;
    const value = (d) => (key === "name" ? d.label : d[key]);
    return matches.sort((a, b) => {
      if (key !== "ip") {
        // Blank values stay at the bottom whichever way the column is sorted.
        const [va, vb] = [value(a), value(b)];
        if (!va !== !vb) return va ? -1 : 1;
        const order = collator.compare(va, vb);
        if (order) return dir * order;
      } else if (a.ipNum !== b.ipNum) {
        return dir * (a.ipNum < b.ipNum ? -1 : 1);
      }
      return a.ipNum - b.ipNum || collator.compare(a.key, b.key);
    });
  }

  /**
   * Point out a card from a different release than the running integration.
   *
   * The card's URL changes with every release, so a fresh page load always
   * gets the matching card. A page left open across an upgrade and restart
   * keeps running the old one until it is reloaded.
   */
  _syncVersionNotice() {
    const notice = this._el?.update;
    if (!notice) return;
    const running = runningIntegrationVersion(this._hass, this._entityId);
    const mismatch = Boolean(running) && CARD_VERSION !== "unknown" && running !== CARD_VERSION;
    notice.hidden = !mismatch;
    if (!mismatch || notice.dataset.running === running) return;
    notice.dataset.running = running;
    notice.innerHTML = `
      <ha-icon icon="mdi:update"></ha-icon>
      <span class="note-body">
        Network Scanner is running version ${esc(running)}, but this page loaded the card from
        version ${esc(CARD_VERSION)}. Refresh the page to load the matching card.
      </span>
      <button type="button" class="btn" data-action="reload">Refresh</button>`;
  }

  get _isFiltered() {
    return Boolean(this._query.trim() || this._status !== "all" || this._vendor);
  }

  // ------------------------------------------------------------ rendering

  _renderShell() {
    const c = this._config;
    const sortOptions = SORT_KEYS.map(
      (key) => `<option value="${key}">${key === "name" ? "Name" : COLUMN_LABELS[key]}</option>`
    ).join("");

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="card" data-mode="loading">
          <div class="head">
            <div class="head-badge"><ha-icon icon="mdi:lan"></ha-icon></div>
            <div class="head-text">
              <h2 class="title"></h2>
              <div class="subtitle"></div>
            </div>
            ${
              c.show_scan_button
                ? `<button type="button" class="icon-btn scan" data-action="scan" title="Scan now"
                     aria-label="Scan the network now"><ha-icon icon="mdi:radar"></ha-icon></button>`
                : ""
            }
          </div>
          <div class="note update" role="status" hidden></div>
          ${c.show_stats ? `<div class="stats" role="group" aria-label="Filter by status"></div>` : ""}
          ${
            c.show_toolbar
              ? `<div class="toolbar">
                  <div class="search">
                    <ha-icon icon="mdi:magnify"></ha-icon>
                    <input type="search" placeholder="Search name, IP, MAC, vendor…"
                      aria-label="Search devices" autocomplete="off" spellcheck="false">
                    <button type="button" class="icon-btn sm" data-action="clear-search"
                      aria-label="Clear search" hidden><ha-icon icon="mdi:close"></ha-icon></button>
                  </div>
                  <div class="select vendor-select">
                    <select aria-label="Filter by vendor" data-role="vendor"></select>
                    <ha-icon icon="mdi:chevron-down"></ha-icon>
                  </div>
                  <div class="sort-group">
                    <div class="select">
                      <select aria-label="Sort by" data-role="sort">${sortOptions}</select>
                      <ha-icon icon="mdi:chevron-down"></ha-icon>
                    </div>
                    <button type="button" class="icon-btn" data-action="sort-dir"><ha-icon></ha-icon></button>
                  </div>
                </div>`
              : ""
          }
          <div class="list-wrap">
            <div class="list-head"></div>
            <ul class="list" aria-label="Devices"></ul>
            <div class="empty" hidden></div>
          </div>
          <div class="foot" hidden></div>
        </div>
      </ha-card>`;

    const $ = (selector) => this.shadowRoot.querySelector(selector);
    this._el = {
      card: $(".card"),
      title: $(".title"),
      subtitle: $(".subtitle"),
      scan: $(".scan"),
      update: $(".update"),
      stats: $(".stats"),
      search: $(".search input"),
      clearSearch: $('[data-action="clear-search"]'),
      vendor: $('[data-role="vendor"]'),
      sort: $('[data-role="sort"]'),
      sortDir: $('[data-action="sort-dir"]'),
      head: $(".list-head"),
      list: $(".list"),
      empty: $(".empty"),
      foot: $(".foot"),
    };
    this._vendorSignature = "";

    const { card } = this._el;
    card.style.setProperty(
      "--nsc-cols",
      [...["name", ...c.columns].map((column) => COLUMN_TRACKS[column][0]), `${CHEVRON_TRACK}px`].join(" ")
    );
    card.style.setProperty("--nsc-table-min", `${this._tableMinWidth}px`);
    const maxHeight = typeof c.max_height === "number" ? `${c.max_height}px` : c.max_height;
    card.classList.toggle("scroll", Boolean(maxHeight));
    if (maxHeight) card.style.setProperty("--nsc-max-height", maxHeight);
    card.classList.toggle("narrow", this._narrow);
    card.classList.toggle("compact", this._width > 0 && this._width < COMPACT_WIDTH);

    if (this._el.search) this._el.search.value = this._query;
    this._syncSortControls();
  }

  _applyWidth(width) {
    if (!width || !this._el) return;
    this._width = width;
    this._el.card.classList.toggle("compact", width < COMPACT_WIDTH);
    const { layout } = this._config;
    const needed = this._tableMinWidth + (this._narrow ? LAYOUT_HYSTERESIS : 0);
    const narrow = layout === "list" || (layout === "auto" && width < needed);
    if (narrow === this._narrow) return;
    this._narrow = narrow;
    this._el.card.classList.toggle("narrow", narrow);
    this._renderList();
  }

  _mode() {
    const st = this._stateObj;
    if (!st) return "missing";
    if (st.state === "unavailable") return "unavailable";
    if (st.state === "unknown" && !this._devices.length) return "pending";
    return "ready";
  }

  _update() {
    if (!this._el) return;
    this._el.card.dataset.mode = this._mode();
    this._renderHeader();
    this._renderStats();
    this._renderVendorOptions();
    this._renderList();
  }

  /** Coalesce bursts of input (typing, rapid clicks) into one list render per frame. */
  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._renderStats();
      this._renderList();
    });
  }

  _renderHeader() {
    if (!this._el) return;
    const st = this._stateObj;
    const { title, subtitle, scan } = this._el;
    title.textContent = this._config.title || st?.attributes?.friendly_name || "Network Scanner";

    let html = "";
    if (this._scanning) {
      html = `<span class="busy">Scanning the network…</span>`;
    } else if (!st) {
      html = "Not configured";
    } else if (st.state === "unavailable") {
      html = `<span class="error">Scanner unavailable</span>`;
    } else if (st.state === "unknown") {
      html = "Waiting for the first scan";
    } else {
      const parts = [];
      if (st.attributes.ip_range) parts.push(`<span class="mono">${esc(st.attributes.ip_range)}</span>`);
      // last_scan is written by the integration on every scan; last_updated
      // only moves when the device list changes, so label the fallback honestly.
      const scanned = st.attributes.last_scan ?? st.last_updated;
      const when = scanned ? new Date(scanned) : null;
      if (when && !Number.isNaN(when.getTime())) {
        const locale = this._hass?.locale?.language ?? this._hass?.language;
        const verb = st.attributes.last_scan ? "Scanned" : "Updated";
        parts.push(
          `<time datetime="${esc(when.toISOString())}" title="${esc(when.toLocaleString(locale))}">` +
            `${verb} ${relativeTime(when)}</time>`
        );
      }
      html = parts.join(" · ");
    }
    subtitle.innerHTML = html;

    if (scan) {
      scan.hidden = !st;
      scan.setAttribute("aria-busy", String(this._scanning));
      scan.title = this._scanning ? "Scanning…" : "Scan now";
    }
  }

  _renderStats() {
    const { stats } = this._el;
    if (!stats) return;
    const locale = this._hass?.locale?.language ?? this._hass?.language;
    stats.innerHTML = STATUS_FILTERS.map((f) => {
      const pressed = this._status === f.id;
      return `
        <button type="button" class="tile" data-action="status" data-status="${f.id}"
          aria-pressed="${pressed}" title="${esc(f.hint)}">
          <span class="tile-top"><span>${f.label}</span><ha-icon icon="${f.icon}"></ha-icon></span>
          <span class="tile-value">${(this._counts[f.id] ?? 0).toLocaleString(locale)}</span>
        </button>`;
    }).join("");
  }

  _renderVendorOptions() {
    const select = this._el.vendor;
    if (!select) return;
    // Only rebuild when the vendor set changes - rebuilding closes the native
    // dropdown if it happens to be open when a scan result lands.
    const signature = JSON.stringify(this._vendors);
    if (signature !== this._vendorSignature) {
      this._vendorSignature = signature;
      select.innerHTML =
        `<option value="">All vendors</option>` +
        this._vendors
          .map(
            ([vendor, count]) =>
              `<option value="${esc(vendor)}">${
                vendor === NO_VENDOR ? "Unknown vendor" : esc(vendor)
              } (${count})</option>`
          )
          .join("");
    }
    select.value = this._vendor;
  }

  _syncSortControls() {
    const { sort, sortDir } = this._el;
    if (sort) sort.value = this._sortBy;
    if (sortDir) {
      const asc = this._sortDir === "asc";
      sortDir.querySelector("ha-icon").setAttribute("icon", asc ? "mdi:sort-ascending" : "mdi:sort-descending");
      sortDir.setAttribute("aria-label", asc ? "Sorted ascending, switch to descending" : "Sorted descending, switch to ascending");
      sortDir.title = asc ? "Ascending" : "Descending";
    }
  }

  _renderHead() {
    const { head } = this._el;
    head.hidden = this._narrow;
    if (this._narrow) return;
    head.innerHTML =
      ["name", ...this._config.columns]
        .map((column) => {
          const active = this._sortBy === column;
          const desc = active && this._sortDir === "desc";
          const state = active ? `, sorted ${desc ? "descending" : "ascending"}` : "";
          return `
            <button type="button" class="th${active ? " active" : ""}" data-action="sort" data-sort="${column}"
              aria-label="Sort by ${COLUMN_LABELS[column]}${state}">
              <span>${COLUMN_LABELS[column]}</span>
              <ha-icon icon="${desc ? "mdi:arrow-down" : "mdi:arrow-up"}"></ha-icon>
            </button>`;
        })
        .join("") + `<span></span>`;
  }

  _renderList() {
    if (!this._el) return;
    const { list, empty, foot, head } = this._el;
    const mode = this._el.card.dataset.mode;
    if (mode === "loading") return;

    if (mode !== "ready") {
      list.innerHTML = "";
      head.hidden = true;
      foot.hidden = true;
      empty.hidden = false;
      empty.className = `empty ${mode === "pending" ? "pending" : "error"}`;
      empty.innerHTML = this._emptyHtml(mode);
      return;
    }

    const tokens = queryTokens(this._query);
    const visible = this._visibleDevices(tokens);

    // Keep keyboard focus on the same device across a re-render.
    const focused = this.shadowRoot.activeElement;
    const focusedKey = focused?.classList.contains("row") ? focused.closest(".device")?.dataset.key : undefined;

    this._renderHead();
    list.innerHTML = visible.map((d) => this._rowHtml(d, tokens)).join("");
    if (!visible.length) head.hidden = true;

    empty.hidden = visible.length > 0;
    if (!visible.length) {
      empty.className = "empty";
      empty.innerHTML = this._emptyHtml(this._devices.length ? "no-match" : "no-devices");
    }

    const filtered = this._isFiltered && visible.length > 0;
    foot.hidden = !filtered;
    if (filtered) {
      foot.innerHTML = `
        <span>Showing <strong>${visible.length}</strong> of ${this._devices.length} devices</span>
        <button type="button" class="link" data-action="clear-filters">Clear filters</button>`;
    }

    if (focusedKey) {
      [...list.children].find((li) => li.dataset.key === focusedKey)?.querySelector(".row")?.focus();
    }
  }

  /** Secondary line under a device name: whatever the visible columns don't already show. */
  _secondaryHtml(d, shown, tokens) {
    const parts = [];
    // Descriptions often repeat the vendor ("MacBook Pro", "Apple", "Apple"),
    // so skip anything the row already says.
    const seen = new Set([d.label, ...[...shown].map((column) => d[column])].filter(Boolean).map((v) => v.toLowerCase()));
    const add = (text, mono = false) => {
      if (!text || seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      parts.push(mono ? `<span class="mono">${highlight(text, tokens)}</span>` : highlight(text, tokens));
    };
    add(d.type);
    if (d.labelSource !== "vendor") add(d.vendor);
    if (!d.vendor && d.privateMac && !shown.has("vendor")) add("Private MAC");
    add(d.hostname, true);
    // In the list layout the MAC is otherwise hidden; it beats an empty line.
    if (!parts.length && this._narrow) add(d.mac, true);
    return parts.slice(0, 2).join(" · ");
  }

  _rowHtml(d, tokens) {
    const open = this._expanded.has(d.key);
    const shown = new Set(this._narrow ? [] : this._config.columns);
    const secondary = this._secondaryHtml(d, shown, tokens);
    const avatar = `<span class="avatar"><ha-icon icon="${d.icon}"></ha-icon></span>`;
    const ident = `
      <span class="ident">
        <span class="primary" title="${esc(d.label)}">${highlight(d.label, tokens)}</span>
        ${secondary ? `<span class="secondary">${secondary}</span>` : ""}
      </span>`;

    let cells;
    if (this._narrow) {
      cells = `${avatar}${ident}<span class="trail mono">${highlight(d.ip, tokens)}</span>`;
    } else {
      cells =
        `<span class="name-cell">${avatar}${ident}</span>` +
        this._config.columns.map((column) => this._cellHtml(d, column, tokens)).join("");
    }

    return `
      <li class="device${open ? " open" : ""}${d.mapped ? "" : " unmapped"}" data-key="${esc(d.key)}">
        <button type="button" class="row" data-action="toggle" aria-expanded="${open}" aria-controls="${d.domId}">
          ${cells}
          <ha-icon class="chevron" icon="mdi:chevron-down"></ha-icon>
        </button>
        ${open ? this._detailsHtml(d, false) : ""}
      </li>`;
  }

  _cellHtml(d, column, tokens) {
    const value = d[column];
    if (!value) {
      const blank = column === "vendor" && d.privateMac ? "Private address" : "—";
      return `<span class="cell muted">${blank}</span>`;
    }
    const mono = ["ip", "mac", "hostname"].includes(column) ? " mono" : "";
    return `<span class="cell${mono}" title="${esc(value)}">${highlight(value, tokens)}</span>`;
  }

  _detailsHtml(d, reveal) {
    const copyButton = (value, what) => `
      <button type="button" class="icon-btn sm" data-action="copy" data-value="${esc(value)}"
        aria-label="Copy ${what}" title="Copy"><ha-icon icon="mdi:content-copy"></ha-icon></button>`;
    const fact = (label, html, copy) =>
      `<div class="fact"><dt>${label}</dt><dd>${html}${copy ? copyButton(copy, label) : ""}</dd></div>`;
    const blank = (text) => `<span class="muted">${text}</span>`;

    const notes = [];
    if (d.privateMac) {
      notes.push(`
        <p class="note"><ha-icon icon="mdi:incognito"></ha-icon><span class="note-body">
          This device uses a private (randomized) MAC address, as phones, tablets and laptops
          do by default. Its vendor can't be looked up, and the address can change over time.
        </span></p>`);
    }
    if (!d.mapped && d.mac) {
      const suggestedName = d.hostname || (d.vendor ? `${shortVendor(d.vendor)} device` : "New device");
      const line = [d.mac.toLowerCase(), suggestedName, d.vendor || "Unknown"]
        .map((part) => part.replace(/[;\n]/g, " "))
        .join(";");
      notes.push(`
        <div class="note"><ha-icon icon="mdi:tag-plus-outline"></ha-icon><div class="note-body">
          Not in your MAC mapping. Add this line to the integration's MAC mappings to give it a name:
          <div class="snippet"><code>${esc(line)}</code>${copyButton(line, "mapping line")}</div>
        </div></div>`);
    }

    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip);
    return `
      <div class="details${reveal ? " reveal" : ""}" id="${d.domId}" role="region" aria-label="${esc(d.label)} details">
        <dl class="facts">
          ${fact("Name", d.name ? esc(d.name) : blank("Not in MAC mapping"))}
          ${fact("Description", d.type ? esc(d.type) : blank("None"))}
          ${fact("IP address", `<span class="mono">${esc(d.ip)}</span>`, d.ip)}
          ${fact("MAC address", `<span class="mono">${esc(d.mac)}</span>`, d.mac)}
          ${fact("Hostname", d.hostname ? `<span class="mono">${esc(d.hostname)}</span>` : blank("No reverse DNS"))}
          ${fact("Vendor", d.vendor ? esc(d.vendor) : blank(d.privateMac ? "Hidden by private MAC" : "Unknown"))}
        </dl>
        ${notes.join("")}
        ${
          isIpv4
            ? `<div class="actions">
                <a class="btn" href="http://${esc(d.ip)}" target="_blank" rel="noopener noreferrer">
                  <ha-icon icon="mdi:open-in-new"></ha-icon>Open web interface</a>
              </div>`
            : ""
        }
      </div>`;
  }

  _emptyHtml(kind) {
    const range = this._stateObj?.attributes?.ip_range;
    const retry = this._config.show_scan_button
      ? `<button type="button" class="btn" data-action="scan"><ha-icon icon="mdi:radar"></ha-icon>Scan now</button>`
      : "";
    const states = {
      missing: [
        "mdi:lan-disconnect",
        "No scanner sensor found",
        this._config.entity
          ? `<span class="mono">${esc(this._config.entity)}</span> doesn't exist. Check the card's entity setting.`
          : "Set up the Network Scanner integration, or pick its sensor in the card settings.",
        "",
      ],
      unavailable: [
        "mdi:alert-circle-outline",
        "Scanner unavailable",
        "The last network scan failed. Check the Home Assistant logs for details.",
        retry,
      ],
      pending: [
        "mdi:radar",
        "Scanning your network…",
        "The first scan can take a minute. Devices appear here as soon as it finishes.",
        "",
      ],
      "no-devices": [
        "mdi:access-point-network-off",
        "No devices found",
        range ? `Nothing answered in <span class="mono">${esc(range)}</span>.` : "Nothing answered the last scan.",
        retry,
      ],
      "no-match": [
        "mdi:magnify-close",
        "No matching devices",
        "Try a different search, or clear the filters to see every device.",
        `<button type="button" class="btn" data-action="clear-filters">Clear filters</button>`,
      ],
    };
    const [icon, title, text, action] = states[kind];
    return `
      <div class="empty-icon"><ha-icon icon="${icon}"></ha-icon></div>
      <div class="empty-title">${title}</div>
      <div class="empty-text">${text}</div>
      ${action}`;
  }

  // ------------------------------------------------------------ events

  _onClick(ev) {
    const target = ev.target.closest("[data-action]");
    // The search box is drawn larger than its input; clicks on the padding or
    // the magnifier should still land in the field.
    if (!target && ev.target.closest(".search") && ev.target !== this._el.search) this._el.search.focus();
    if (!target) return;
    switch (target.dataset.action) {
      case "scan":
        this._scan();
        break;
      case "reload":
        window.location.reload();
        break;
      case "status":
        this._status = target.dataset.status === this._status ? "all" : target.dataset.status;
        this._queueRender();
        break;
      case "sort":
        if (this._sortBy === target.dataset.sort) {
          this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
        } else {
          this._sortBy = target.dataset.sort;
          this._sortDir = "asc";
        }
        this._syncSortControls();
        this._queueRender();
        break;
      case "sort-dir":
        this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
        this._syncSortControls();
        this._queueRender();
        break;
      case "toggle":
        this._toggle(target.closest(".device"));
        break;
      case "copy":
        this._copy(target.dataset.value, target);
        break;
      case "clear-search":
        this._setQuery("");
        this._el.search?.focus();
        break;
      case "clear-filters":
        this._status = "all";
        this._vendor = "";
        if (this._el.vendor) this._el.vendor.value = "";
        this._setQuery("");
        break;
    }
  }

  _onInput(ev) {
    if (ev.target === this._el?.search) this._setQuery(ev.target.value);
  }

  _onChange(ev) {
    const role = ev.target.dataset?.role;
    if (role === "vendor") {
      this._vendor = ev.target.value;
      this._queueRender();
    } else if (role === "sort") {
      this._sortBy = ev.target.value;
      this._queueRender();
    }
  }

  _onKeyDown(ev) {
    if (ev.key === "Escape" && ev.target === this._el?.search && this._query) {
      ev.stopPropagation();
      this._setQuery("");
    }
  }

  _setQuery(query) {
    this._query = query;
    const { search, clearSearch } = this._el;
    if (search && search.value !== query) search.value = query;
    if (clearSearch) clearSearch.hidden = !query;
    this._queueRender();
  }

  /** Expand or collapse one device in place, so other open rows don't re-animate. */
  _toggle(li) {
    const device = this._byKey.get(li?.dataset.key);
    if (!device) return;
    const open = !this._expanded.has(device.key);
    if (open) this._expanded.add(device.key);
    else this._expanded.delete(device.key);
    li.classList.toggle("open", open);
    li.querySelector(".row").setAttribute("aria-expanded", String(open));
    li.querySelector(".details")?.remove();
    if (open) li.insertAdjacentHTML("beforeend", this._detailsHtml(device, true));
  }

  async _copy(value, button) {
    const ok = await copyText(value, this.shadowRoot);
    button.focus();
    this._toast(ok ? "Copied to clipboard" : "Couldn't copy to the clipboard");
    if (!ok) return;
    const icon = button.querySelector("ha-icon");
    button.classList.add("copied");
    icon?.setAttribute("icon", "mdi:check");
    window.setTimeout(() => {
      button.classList.remove("copied");
      icon?.setAttribute("icon", "mdi:content-copy");
    }, 1500);
  }

  async _scan() {
    if (this._scanning || !this._hass || !this._entityId) return;
    this._scanning = true;
    this._renderHeader();
    try {
      // CoordinatorEntity.async_update asks the coordinator for a refresh, so
      // this runs a real scan and resolves once it has finished.
      await this._hass.callService("homeassistant", "update_entity", { entity_id: this._entityId });
    } catch (err) {
      this._toast(`Scan failed: ${err?.message ?? err}`);
    } finally {
      this._scanning = false;
      this._renderHeader();
    }
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }
}

// ---------------------------------------------------------------- editor

const EDITOR_SCHEMA = [
  { name: "entity", selector: { entity: { filter: { domain: "sensor", integration: DOMAIN } } } },
  { name: "title", selector: { text: {} } },
  {
    name: "columns",
    selector: {
      select: {
        multiple: true,
        mode: "list",
        options: OPTIONAL_COLUMNS.map((column) => ({ value: column, label: COLUMN_LABELS[column] })),
      },
    },
  },
  {
    type: "grid",
    name: "",
    schema: [
      {
        name: "sort_by",
        selector: {
          select: {
            mode: "dropdown",
            options: SORT_KEYS.map((key) => ({ value: key, label: key === "name" ? "Name" : COLUMN_LABELS[key] })),
          },
        },
      },
      {
        name: "sort_order",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "asc", label: "Ascending" },
              { value: "desc", label: "Descending" },
            ],
          },
        },
      },
    ],
  },
  {
    type: "grid",
    name: "",
    schema: [
      {
        name: "layout",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "auto", label: "Automatic" },
              { value: "table", label: "Table" },
              { value: "list", label: "List" },
            ],
          },
        },
      },
      { name: "max_height", selector: { text: {} } },
    ],
  },
  { name: "show_stats", selector: { boolean: {} } },
  { name: "show_toolbar", selector: { boolean: {} } },
  { name: "show_scan_button", selector: { boolean: {} } },
];

const EDITOR_LABELS = {
  entity: "Network Scanner sensor",
  title: "Title",
  columns: "Table columns",
  sort_by: "Sort by",
  sort_order: "Sort order",
  layout: "Layout",
  max_height: "Maximum height",
  show_stats: "Show summary tiles",
  show_toolbar: "Show search and filters",
  show_scan_button: "Show scan button",
};

const EDITOR_HELPERS = {
  entity: "Leave empty to use the first Network Scanner sensor.",
  columns: "Shown beside the device name when the card is wide enough for a table.",
  layout: "Automatic shows a table when the columns fit and a list otherwise.",
  max_height: "e.g. 480px. The device list scrolls past this height.",
};

class NetworkScannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    else this._render();
  }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.schema = EDITOR_SCHEMA;
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] ?? schema.name;
      this._form.computeHelper = (schema) => EDITOR_HELPERS[schema.name];
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    // Show defaults in the form, but _valueChanged strips them back out so the
    // saved YAML only lists what the user actually changed. Defaults go after
    // the config's own keys so `type:` stays at the top of the YAML.
    const missing = Object.entries(DEFAULTS).filter(([key]) => !(key in this._config));
    this._form.data = { ...this._config, ...Object.fromEntries(missing) };
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const config = { ...ev.detail.value };
    for (const [key, value] of Object.entries(config)) {
      const isDefault = key in DEFAULTS && JSON.stringify(value) === JSON.stringify(DEFAULTS[key]);
      if (isDefault || value === "" || value === null || value === undefined) delete config[key];
    }
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

// A second copy of this file (say, also added as a dashboard resource by hand)
// must not try to redefine the elements.
if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, NetworkScannerCard);
  customElements.define(EDITOR_TAG, NetworkScannerCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "Network Scanner",
    description: "Sortable, searchable list of the devices found by the Network Scanner integration.",
    preview: true,
    documentationURL: "https://github.com/kedube/ha-network-scanner",
  });
  // Shows in the browser console which release the page actually loaded.
  console.info(
    `%c NETWORK-SCANNER-CARD %c v${CARD_VERSION} `,
    "color:#fff;background:#03a9f4;font-weight:700",
    "color:#03a9f4;background:#fff"
  );
}
