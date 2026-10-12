/*
 * Network Scanner card for Home Assistant dashboards.
 *
 * Served and auto-loaded by the network_scanner integration (see __init__.py),
 * so there is no dashboard resource to add by hand. Deliberately a plain custom
 * element with no dependencies and no build step - the integration ships this
 * file as-is. Every color comes from Home Assistant theme variables, which is
 * what makes light mode, dark mode and custom themes follow the user's theme
 * instead of being hard-coded here. Likewise every piece of text comes from
 * TRANSLATIONS at the end of the file, in the language of the user's Home
 * Assistant profile.
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

const OPTIONAL_COLUMNS = ["ip", "mac", "vendor", "hostname", "type"];
const SORT_KEYS = ["name", ...OPTIONAL_COLUMNS];
// Column headers are column_<key>. The sort menu says "Name" rather than the
// "Device" header, since that is what it sorts by.
const sortLabelKey = (key) => (key === "name" ? "field_name" : `column_${key}`);

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

// Each tile's label is status_<id> and its tooltip status_<id>_hint.
const STATUS_FILTERS = [
  { id: "all", icon: "mdi:lan-connect", test: () => true },
  { id: "known", icon: "mdi:tag-check-outline", test: (d) => d.mapped },
  { id: "unknown", icon: "mdi:help-circle-outline", test: (d) => !d.mapped },
  { id: "private", icon: "mdi:incognito", test: (d) => d.privateMac },
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

/** The closest language the card has: de-CH falls back to de, anything else to English. */
function resolveLanguage(language) {
  const base = String(language ?? "").split("-")[0];
  return [language, base].find((code) => Object.hasOwn(TRANSLATIONS, code)) ?? "en";
}

/** The language of the user's Home Assistant profile, as resolveLanguage picks it. */
const languageOf = (hass) => resolveLanguage(hass?.locale?.language ?? hass?.language);

/** A string in the given language, or in English where that language lacks it. */
const translate = (language, key) => TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key];

/** A translated string with its {placeholders} filled in. */
const fill = (template, values = {}) =>
  template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));

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

function normalizeDevice(raw, language) {
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
  if (!label && vendor) {
    [label, labelSource] = [fill(translate(language, "vendor_device"), { vendor: shortVendor(vendor) }), "vendor"];
  }
  if (!label) [label, labelSource] = [translate(language, "unknown_device"), "none"];

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

function relativeTime(date, language) {
  const seconds = Math.min(0, (date.getTime() - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds > -45) return translate(language, "just_now");
  // In the card's language, not the user's locale, so it reads as one sentence
  // with the translated text around it.
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
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
    // English until hass says otherwise.
    this._lang = "en";

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
    const language = languageOf(hass);
    if (language !== this._lang) {
      // setConfig usually draws the card before hass arrives, so in English.
      this._lang = language;
      if (this._config) {
        this._renderShell();
        this._stale = true;
      }
    }
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

  /** Card text in the user's language. */
  _t(key, values) {
    return fill(translate(this._lang, key), values);
  }

  /** The same as HTML: the text escaped, and the placeholders filled with HTML the caller has escaped. */
  _html(key, values) {
    return fill(esc(translate(this._lang, key)), values);
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
    this._devices = Array.isArray(raw) ? raw.map((device) => normalizeDevice(device, this._lang)) : [];
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
      <span class="note-body">${this._html("version_mismatch", { running: esc(running), card: esc(CARD_VERSION) })}</span>
      <button type="button" class="btn" data-action="reload">${this._html("refresh")}</button>`;
  }

  get _isFiltered() {
    return Boolean(this._query.trim() || this._status !== "all" || this._vendor);
  }

  // ------------------------------------------------------------ rendering

  _renderShell() {
    const c = this._config;
    const sortOptions = SORT_KEYS.map((key) => `<option value="${key}">${this._html(sortLabelKey(key))}</option>`).join("");

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
                ? `<button type="button" class="icon-btn scan" data-action="scan" title="${this._html("scan_now")}"
                     aria-label="${this._html("scan_now_label")}"><ha-icon icon="mdi:radar"></ha-icon></button>`
                : ""
            }
          </div>
          <div class="note update" role="status" hidden></div>
          ${c.show_stats ? `<div class="stats" role="group" aria-label="${this._html("filter_by_status")}"></div>` : ""}
          ${
            c.show_toolbar
              ? `<div class="toolbar">
                  <div class="search">
                    <ha-icon icon="mdi:magnify"></ha-icon>
                    <input type="search" placeholder="${this._html("search_placeholder")}"
                      aria-label="${this._html("search_label")}" autocomplete="off" spellcheck="false">
                    <button type="button" class="icon-btn sm" data-action="clear-search"
                      aria-label="${this._html("clear_search")}" hidden><ha-icon icon="mdi:close"></ha-icon></button>
                  </div>
                  <div class="select vendor-select">
                    <select aria-label="${this._html("filter_by_vendor")}" data-role="vendor"></select>
                    <ha-icon icon="mdi:chevron-down"></ha-icon>
                  </div>
                  <div class="sort-group">
                    <div class="select">
                      <select aria-label="${this._html("sort_by")}" data-role="sort">${sortOptions}</select>
                      <ha-icon icon="mdi:chevron-down"></ha-icon>
                    </div>
                    <button type="button" class="icon-btn" data-action="sort-dir"><ha-icon></ha-icon></button>
                  </div>
                </div>`
              : ""
          }
          <div class="list-wrap">
            <div class="list-head"></div>
            <ul class="list" aria-label="${this._html("device_list")}"></ul>
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
      html = `<span class="busy">${this._html("scanning_network")}</span>`;
    } else if (!st) {
      html = this._html("not_configured");
    } else if (st.state === "unavailable") {
      html = `<span class="error">${this._html("scanner_unavailable")}</span>`;
    } else if (st.state === "unknown") {
      html = this._html("waiting_first_scan");
    } else {
      const parts = [];
      if (st.attributes.ip_range) parts.push(`<span class="mono">${esc(st.attributes.ip_range)}</span>`);
      // last_scan is written by the integration on every scan; last_updated
      // only moves when the device list changes, so label the fallback honestly.
      const scanned = st.attributes.last_scan ?? st.last_updated;
      const when = scanned ? new Date(scanned) : null;
      if (when && !Number.isNaN(when.getTime())) {
        const locale = this._hass?.locale?.language ?? this._hass?.language;
        const key = st.attributes.last_scan ? "scanned_at" : "updated_at";
        parts.push(
          `<time datetime="${esc(when.toISOString())}" title="${esc(when.toLocaleString(locale))}">` +
            `${this._html(key, { time: esc(relativeTime(when, this._lang)) })}</time>`
        );
      }
      html = parts.join(" · ");
    }
    subtitle.innerHTML = html;

    if (scan) {
      scan.hidden = !st;
      scan.setAttribute("aria-busy", String(this._scanning));
      scan.title = this._t(this._scanning ? "scanning" : "scan_now");
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
          aria-pressed="${pressed}" title="${this._html(`status_${f.id}_hint`)}">
          <span class="tile-top"><span>${this._html(`status_${f.id}`)}</span><ha-icon icon="${f.icon}"></ha-icon></span>
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
        `<option value="">${this._html("all_vendors")}</option>` +
        this._vendors
          .map(
            ([vendor, count]) =>
              `<option value="${esc(vendor)}">${
                vendor === NO_VENDOR ? this._html("unknown_vendor") : esc(vendor)
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
      sortDir.setAttribute("aria-label", this._t(asc ? "switch_to_descending" : "switch_to_ascending"));
      sortDir.title = this._t(asc ? "ascending" : "descending");
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
          const label = this._html(`column_${column}`);
          const aria = active ? `sort_by_column_${desc ? "descending" : "ascending"}` : "sort_by_column";
          return `
            <button type="button" class="th${active ? " active" : ""}" data-action="sort" data-sort="${column}"
              aria-label="${this._html(aria, { column: label })}">
              <span>${label}</span>
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
        <span>${this._html("showing_count", { shown: `<strong>${visible.length}</strong>`, total: this._devices.length })}</span>
        <button type="button" class="link" data-action="clear-filters">${this._html("clear_filters")}</button>`;
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
    if (!d.vendor && d.privateMac && !shown.has("vendor")) add(this._t("status_private"));
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
      const blank = column === "vendor" && d.privateMac ? this._html("private_address") : "—";
      return `<span class="cell muted">${blank}</span>`;
    }
    const mono = ["ip", "mac", "hostname"].includes(column) ? " mono" : "";
    return `<span class="cell${mono}" title="${esc(value)}">${highlight(value, tokens)}</span>`;
  }

  _detailsHtml(d, reveal) {
    const copyButton = (value, labelKey) => `
      <button type="button" class="icon-btn sm" data-action="copy" data-value="${esc(value)}"
        aria-label="${this._html(labelKey)}" title="${this._html("copy")}"><ha-icon icon="mdi:content-copy"></ha-icon></button>`;
    const fact = (labelKey, html, copy = "") =>
      `<div class="fact"><dt>${this._html(labelKey)}</dt><dd>${html}${copy}</dd></div>`;
    const blank = (key) => `<span class="muted">${this._html(key)}</span>`;

    const notes = [];
    if (d.privateMac) {
      notes.push(`
        <p class="note"><ha-icon icon="mdi:incognito"></ha-icon><span class="note-body">${this._html("private_mac_note")}</span></p>`);
    }
    if (!d.mapped && d.mac) {
      const suggestedName =
        d.hostname || (d.vendor ? this._t("vendor_device", { vendor: shortVendor(d.vendor) }) : this._t("new_device"));
      const line = [d.mac.toLowerCase(), suggestedName, d.vendor || this._t("unknown")]
        .map((part) => part.replace(/[;\n]/g, " "))
        .join(";");
      notes.push(`
        <div class="note"><ha-icon icon="mdi:tag-plus-outline"></ha-icon><div class="note-body">
          ${this._html("mapping_note")}
          <div class="snippet"><code>${esc(line)}</code>${copyButton(line, "copy_mapping")}</div>
        </div></div>`);
    }

    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip);
    return `
      <div class="details${reveal ? " reveal" : ""}" id="${d.domId}" role="region"
        aria-label="${this._html("details_label", { name: esc(d.label) })}">
        <dl class="facts">
          ${fact("field_name", d.name ? esc(d.name) : blank("not_in_mapping"))}
          ${fact("column_type", d.type ? esc(d.type) : blank("none"))}
          ${fact("column_ip", `<span class="mono">${esc(d.ip)}</span>`, d.ip && copyButton(d.ip, "copy_ip"))}
          ${fact("column_mac", `<span class="mono">${esc(d.mac)}</span>`, d.mac && copyButton(d.mac, "copy_mac"))}
          ${fact("column_hostname", d.hostname ? `<span class="mono">${esc(d.hostname)}</span>` : blank("no_reverse_dns"))}
          ${fact("column_vendor", d.vendor ? esc(d.vendor) : blank(d.privateMac ? "hidden_by_private_mac" : "unknown"))}
        </dl>
        ${notes.join("")}
        ${
          isIpv4
            ? `<div class="actions">
                <a class="btn" href="http://${esc(d.ip)}" target="_blank" rel="noopener noreferrer">
                  <ha-icon icon="mdi:open-in-new"></ha-icon>${this._html("open_web_interface")}</a>
              </div>`
            : ""
        }
      </div>`;
  }

  _emptyHtml(kind) {
    const range = this._stateObj?.attributes?.ip_range;
    const mono = (text) => `<span class="mono">${esc(text)}</span>`;
    const retry = this._config.show_scan_button
      ? `<button type="button" class="btn" data-action="scan"><ha-icon icon="mdi:radar"></ha-icon>${this._html("scan_now")}</button>`
      : "";
    const states = {
      missing: [
        "mdi:lan-disconnect",
        "no_sensor_title",
        this._config.entity
          ? this._html("entity_missing", { entity: mono(this._config.entity) })
          : this._html("set_up_integration"),
        "",
      ],
      unavailable: ["mdi:alert-circle-outline", "scanner_unavailable", this._html("scan_failed_text"), retry],
      pending: ["mdi:radar", "first_scan_title", this._html("first_scan_text"), ""],
      "no-devices": [
        "mdi:access-point-network-off",
        "no_devices_title",
        range ? this._html("nothing_answered_range", { range: mono(range) }) : this._html("nothing_answered"),
        retry,
      ],
      "no-match": [
        "mdi:magnify-close",
        "no_match_title",
        this._html("no_match_text"),
        `<button type="button" class="btn" data-action="clear-filters">${this._html("clear_filters")}</button>`,
      ],
    };
    const [icon, titleKey, text, action] = states[kind];
    return `
      <div class="empty-icon"><ha-icon icon="${icon}"></ha-icon></div>
      <div class="empty-title">${this._html(titleKey)}</div>
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
    this._toast(this._t(ok ? "copied" : "copy_failed"));
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
      this._toast(this._t("scan_failed", { error: err?.message ?? err }));
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

// Field labels are editor_<name> and helper text editor_<name>_helper.
function editorSchema(language) {
  const options = (values, labelKey) => values.map((value) => ({ value, label: translate(language, labelKey(value)) }));
  return [
    { name: "entity", selector: { entity: { filter: { domain: "sensor", integration: DOMAIN } } } },
    { name: "title", selector: { text: {} } },
    {
      name: "columns",
      selector: {
        select: {
          multiple: true,
          mode: "list",
          options: options(OPTIONAL_COLUMNS, (column) => `column_${column}`),
        },
      },
    },
    {
      type: "grid",
      name: "",
      schema: [
        {
          name: "sort_by",
          selector: { select: { mode: "dropdown", options: options(SORT_KEYS, sortLabelKey) } },
        },
        {
          name: "sort_order",
          selector: {
            select: {
              mode: "dropdown",
              options: options(["asc", "desc"], (order) => (order === "asc" ? "ascending" : "descending")),
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
            select: { mode: "dropdown", options: options(["auto", "table", "list"], (layout) => `layout_${layout}`) },
          },
        },
        { name: "max_height", selector: { text: {} } },
      ],
    },
    { name: "show_stats", selector: { boolean: {} } },
    { name: "show_toolbar", selector: { boolean: {} } },
    { name: "show_scan_button", selector: { boolean: {} } },
  ];
}

class NetworkScannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form && this._lang === languageOf(hass)) this._form.hass = hass;
    else this._render();
  }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => translate(this._lang, `editor_${schema.name}`) ?? schema.name;
      this._form.computeHelper = (schema) => translate(this._lang, `editor_${schema.name}_helper`);
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this.appendChild(this._form);
    }
    const language = languageOf(this._hass);
    if (language !== this._lang) {
      this._lang = language;
      this._form.schema = editorSchema(language);
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

// ---------------------------------------------------------------- translations

// Keyed by Home Assistant language code. English is the reference: every
// other language has exactly its keys and {placeholders}, which the card tests
// check. A language not listed here gets English, and a regional variant gets
// its base language (de-CH reads de). The integration's own text, the setup
// and options dialogs, is in translations/ beside this folder.
const TRANSLATIONS = {
  en: {
    card_description: "Sortable, searchable list of the devices found by the Network Scanner integration.",
    column_name: "Device",
    column_ip: "IP address",
    column_mac: "MAC address",
    column_vendor: "Vendor",
    column_hostname: "Hostname",
    column_type: "Description",
    field_name: "Name",
    status_all: "Devices",
    status_all_hint: "Every device found by the last scan",
    status_known: "Known",
    status_known_hint: "Named in your MAC mapping",
    status_unknown: "Unknown",
    status_unknown_hint: "Not in your MAC mapping yet",
    status_private: "Private MAC",
    status_private_hint: "Randomized MAC address, typical of phones, tablets and laptops",
    vendor_device: "{vendor} device",
    unknown_device: "Unknown device",
    new_device: "New device",
    unknown: "Unknown",
    just_now: "just now",
    version_mismatch:
      "Network Scanner is running version {running}, but this page loaded the card from version {card}. Refresh the page to load the matching card.",
    refresh: "Refresh",
    scan_now: "Scan now",
    scan_now_label: "Scan the network now",
    scanning: "Scanning…",
    filter_by_status: "Filter by status",
    search_placeholder: "Search name, IP, MAC, vendor…",
    search_label: "Search devices",
    clear_search: "Clear search",
    filter_by_vendor: "Filter by vendor",
    sort_by: "Sort by",
    device_list: "Devices",
    scanning_network: "Scanning the network…",
    not_configured: "Not configured",
    scanner_unavailable: "Scanner unavailable",
    waiting_first_scan: "Waiting for the first scan",
    scanned_at: "Scanned {time}",
    updated_at: "Updated {time}",
    all_vendors: "All vendors",
    unknown_vendor: "Unknown vendor",
    ascending: "Ascending",
    descending: "Descending",
    switch_to_descending: "Sorted ascending, switch to descending",
    switch_to_ascending: "Sorted descending, switch to ascending",
    sort_by_column: "Sort by {column}",
    sort_by_column_ascending: "Sort by {column}, sorted ascending",
    sort_by_column_descending: "Sort by {column}, sorted descending",
    showing_count: "Showing {shown} of {total} devices",
    clear_filters: "Clear filters",
    private_address: "Private address",
    copy: "Copy",
    copy_ip: "Copy IP address",
    copy_mac: "Copy MAC address",
    copy_mapping: "Copy mapping line",
    not_in_mapping: "Not in MAC mapping",
    none: "None",
    no_reverse_dns: "No reverse DNS",
    hidden_by_private_mac: "Hidden by private MAC",
    private_mac_note:
      "This device uses a private (randomized) MAC address, as phones, tablets and laptops do by default. Its vendor can't be looked up, and the address can change over time.",
    mapping_note: "Not in your MAC mapping. Add this line to the integration's MAC mappings to give it a name:",
    details_label: "{name} details",
    open_web_interface: "Open web interface",
    no_sensor_title: "No scanner sensor found",
    entity_missing: "{entity} doesn't exist. Check the card's entity setting.",
    set_up_integration: "Set up the Network Scanner integration, or pick its sensor in the card settings.",
    scan_failed_text: "The last network scan failed. Check the Home Assistant logs for details.",
    first_scan_title: "Scanning your network…",
    first_scan_text: "The first scan can take a minute. Devices appear here as soon as it finishes.",
    no_devices_title: "No devices found",
    nothing_answered_range: "Nothing answered in {range}.",
    nothing_answered: "Nothing answered the last scan.",
    no_match_title: "No matching devices",
    no_match_text: "Try a different search, or clear the filters to see every device.",
    copied: "Copied to clipboard",
    copy_failed: "Couldn't copy to the clipboard",
    scan_failed: "Scan failed: {error}",
    editor_entity: "Network Scanner sensor",
    editor_entity_helper: "Leave empty to use the first Network Scanner sensor.",
    editor_title: "Title",
    editor_columns: "Table columns",
    editor_columns_helper: "Shown beside the device name when the card is wide enough for a table.",
    editor_sort_by: "Sort by",
    editor_sort_order: "Sort order",
    editor_layout: "Layout",
    editor_layout_helper: "Automatic shows a table when the columns fit and a list otherwise.",
    editor_max_height: "Maximum height",
    editor_max_height_helper: "e.g. 480px. The device list scrolls past this height.",
    editor_show_stats: "Show summary tiles",
    editor_show_toolbar: "Show search and filters",
    editor_show_scan_button: "Show scan button",
    layout_auto: "Automatic",
    layout_table: "Table",
    layout_list: "List",
  },
  de: {
    card_description: "Sortierbare, durchsuchbare Liste der Geräte, die die Integration Network Scanner gefunden hat.",
    column_name: "Gerät",
    column_ip: "IP-Adresse",
    column_mac: "MAC-Adresse",
    column_vendor: "Hersteller",
    column_hostname: "Hostname",
    column_type: "Beschreibung",
    field_name: "Name",
    status_all: "Geräte",
    status_all_hint: "Alle Geräte, die der letzte Scan gefunden hat",
    status_known: "Bekannt",
    status_known_hint: "In deiner MAC-Zuordnung benannt",
    status_unknown: "Unbekannt",
    status_unknown_hint: "Noch nicht in deiner MAC-Zuordnung",
    status_private: "Private MAC",
    status_private_hint: "Zufällig generierte MAC-Adresse, typisch für Smartphones, Tablets und Laptops",
    vendor_device: "{vendor}-Gerät",
    unknown_device: "Unbekanntes Gerät",
    new_device: "Neues Gerät",
    unknown: "Unbekannt",
    just_now: "gerade eben",
    version_mismatch:
      "Network Scanner läuft in Version {running}, diese Seite hat die Karte aber aus Version {card} geladen. Lade die Seite neu, um die passende Karte zu laden.",
    refresh: "Neu laden",
    scan_now: "Jetzt scannen",
    scan_now_label: "Netzwerk jetzt scannen",
    scanning: "Wird gescannt…",
    filter_by_status: "Nach Status filtern",
    search_placeholder: "Name, IP, MAC, Hersteller suchen…",
    search_label: "Geräte durchsuchen",
    clear_search: "Suche löschen",
    filter_by_vendor: "Nach Hersteller filtern",
    sort_by: "Sortieren nach",
    device_list: "Geräte",
    scanning_network: "Netzwerk wird gescannt…",
    not_configured: "Nicht eingerichtet",
    scanner_unavailable: "Scanner nicht verfügbar",
    waiting_first_scan: "Warte auf den ersten Scan",
    scanned_at: "Gescannt {time}",
    updated_at: "Aktualisiert {time}",
    all_vendors: "Alle Hersteller",
    unknown_vendor: "Unbekannter Hersteller",
    ascending: "Aufsteigend",
    descending: "Absteigend",
    switch_to_descending: "Aufsteigend sortiert, zu absteigend wechseln",
    switch_to_ascending: "Absteigend sortiert, zu aufsteigend wechseln",
    sort_by_column: "Nach {column} sortieren",
    sort_by_column_ascending: "Nach {column} sortieren, aufsteigend sortiert",
    sort_by_column_descending: "Nach {column} sortieren, absteigend sortiert",
    showing_count: "{shown} von {total} Geräten angezeigt",
    clear_filters: "Filter zurücksetzen",
    private_address: "Private Adresse",
    copy: "Kopieren",
    copy_ip: "IP-Adresse kopieren",
    copy_mac: "MAC-Adresse kopieren",
    copy_mapping: "Zuordnungszeile kopieren",
    not_in_mapping: "Nicht in der MAC-Zuordnung",
    none: "Keine",
    no_reverse_dns: "Kein Reverse-DNS",
    hidden_by_private_mac: "Durch private MAC verborgen",
    private_mac_note:
      "Dieses Gerät verwendet eine private (zufällig generierte) MAC-Adresse, wie es Smartphones, Tablets und Laptops standardmäßig tun. Der Hersteller lässt sich nicht ermitteln, und die Adresse kann sich mit der Zeit ändern.",
    mapping_note:
      "Nicht in deiner MAC-Zuordnung. Füge diese Zeile zu den MAC-Adresszuordnungen der Integration hinzu, um dem Gerät einen Namen zu geben:",
    details_label: "Details zu {name}",
    open_web_interface: "Weboberfläche öffnen",
    no_sensor_title: "Kein Scanner-Sensor gefunden",
    entity_missing: "{entity} existiert nicht. Prüfe die Entität in den Karteneinstellungen.",
    set_up_integration: "Richte die Integration Network Scanner ein oder wähle ihren Sensor in den Karteneinstellungen aus.",
    scan_failed_text: "Der letzte Netzwerkscan ist fehlgeschlagen. Details findest du in den Protokollen von Home Assistant.",
    first_scan_title: "Dein Netzwerk wird gescannt…",
    first_scan_text: "Der erste Scan kann eine Minute dauern. Die Geräte erscheinen hier, sobald er abgeschlossen ist.",
    no_devices_title: "Keine Geräte gefunden",
    nothing_answered_range: "In {range} hat nichts geantwortet.",
    nothing_answered: "Beim letzten Scan hat nichts geantwortet.",
    no_match_title: "Keine passenden Geräte",
    no_match_text: "Versuche eine andere Suche oder setze die Filter zurück, um alle Geräte zu sehen.",
    copied: "In die Zwischenablage kopiert",
    copy_failed: "Kopieren in die Zwischenablage fehlgeschlagen",
    scan_failed: "Scan fehlgeschlagen: {error}",
    editor_entity: "Network-Scanner-Sensor",
    editor_entity_helper: "Leer lassen, um den ersten Network-Scanner-Sensor zu verwenden.",
    editor_title: "Titel",
    editor_columns: "Tabellenspalten",
    editor_columns_helper: "Werden neben dem Gerätenamen angezeigt, wenn die Karte breit genug für eine Tabelle ist.",
    editor_sort_by: "Sortieren nach",
    editor_sort_order: "Sortierreihenfolge",
    editor_layout: "Layout",
    editor_layout_helper: "Automatisch zeigt eine Tabelle, wenn die Spalten passen, und sonst eine Liste.",
    editor_max_height: "Maximale Höhe",
    editor_max_height_helper: "z. B. 480px. Ist die Geräteliste höher, wird sie scrollbar.",
    editor_show_stats: "Übersichtskacheln anzeigen",
    editor_show_toolbar: "Suche und Filter anzeigen",
    editor_show_scan_button: "Scan-Schaltfläche anzeigen",
    layout_auto: "Automatisch",
    layout_table: "Tabelle",
    layout_list: "Liste",
  },
  es: {
    card_description: "Lista ordenable y con búsqueda de los dispositivos encontrados por la integración Network Scanner.",
    column_name: "Dispositivo",
    column_ip: "Dirección IP",
    column_mac: "Dirección MAC",
    column_vendor: "Fabricante",
    column_hostname: "Nombre de host",
    column_type: "Descripción",
    field_name: "Nombre",
    status_all: "Dispositivos",
    status_all_hint: "Todos los dispositivos encontrados en el último escaneo",
    status_known: "Conocidos",
    status_known_hint: "Con nombre en tus asignaciones MAC",
    status_unknown: "Desconocidos",
    status_unknown_hint: "Aún no están en tus asignaciones MAC",
    status_private: "MAC privada",
    status_private_hint: "Dirección MAC aleatoria, típica de teléfonos, tabletas y portátiles",
    vendor_device: "Dispositivo {vendor}",
    unknown_device: "Dispositivo desconocido",
    new_device: "Nuevo dispositivo",
    unknown: "Desconocido",
    just_now: "hace un momento",
    version_mismatch:
      "Network Scanner está en la versión {running}, pero esta página cargó la tarjeta de la versión {card}. Actualiza la página para cargar la tarjeta correspondiente.",
    refresh: "Actualizar",
    scan_now: "Escanear ahora",
    scan_now_label: "Escanear la red ahora",
    scanning: "Escaneando…",
    filter_by_status: "Filtrar por estado",
    search_placeholder: "Buscar nombre, IP, MAC, fabricante…",
    search_label: "Buscar dispositivos",
    clear_search: "Borrar búsqueda",
    filter_by_vendor: "Filtrar por fabricante",
    sort_by: "Ordenar por",
    device_list: "Dispositivos",
    scanning_network: "Escaneando la red…",
    not_configured: "Sin configurar",
    scanner_unavailable: "Escáner no disponible",
    waiting_first_scan: "Esperando el primer escaneo",
    scanned_at: "Escaneado {time}",
    updated_at: "Actualizado {time}",
    all_vendors: "Todos los fabricantes",
    unknown_vendor: "Fabricante desconocido",
    ascending: "Ascendente",
    descending: "Descendente",
    switch_to_descending: "Orden ascendente, cambiar a descendente",
    switch_to_ascending: "Orden descendente, cambiar a ascendente",
    sort_by_column: "Ordenar por {column}",
    sort_by_column_ascending: "Ordenar por {column}, orden ascendente",
    sort_by_column_descending: "Ordenar por {column}, orden descendente",
    showing_count: "Mostrando {shown} de {total} dispositivos",
    clear_filters: "Borrar filtros",
    private_address: "Dirección privada",
    copy: "Copiar",
    copy_ip: "Copiar dirección IP",
    copy_mac: "Copiar dirección MAC",
    copy_mapping: "Copiar línea de asignación",
    not_in_mapping: "No está en las asignaciones MAC",
    none: "Ninguna",
    no_reverse_dns: "Sin DNS inverso",
    hidden_by_private_mac: "Oculto por la MAC privada",
    private_mac_note:
      "Este dispositivo usa una dirección MAC privada (aleatoria), como hacen por defecto los teléfonos, tabletas y portátiles. No se puede averiguar su fabricante y la dirección puede cambiar con el tiempo.",
    mapping_note:
      "No está en tus asignaciones MAC. Añade esta línea a las asignaciones de direcciones MAC de la integración para darle un nombre:",
    details_label: "Detalles de {name}",
    open_web_interface: "Abrir interfaz web",
    no_sensor_title: "No se encontró ningún sensor de Network Scanner",
    entity_missing: "{entity} no existe. Revisa la entidad en la configuración de la tarjeta.",
    set_up_integration: "Configura la integración Network Scanner o elige su sensor en la configuración de la tarjeta.",
    scan_failed_text: "El último escaneo de la red falló. Consulta los registros de Home Assistant para ver los detalles.",
    first_scan_title: "Escaneando tu red…",
    first_scan_text: "El primer escaneo puede tardar un minuto. Los dispositivos aparecerán aquí en cuanto termine.",
    no_devices_title: "No se encontraron dispositivos",
    nothing_answered_range: "Nada respondió en {range}.",
    nothing_answered: "Nada respondió en el último escaneo.",
    no_match_title: "Ningún dispositivo coincide",
    no_match_text: "Prueba con otra búsqueda o borra los filtros para ver todos los dispositivos.",
    copied: "Copiado al portapapeles",
    copy_failed: "No se pudo copiar al portapapeles",
    scan_failed: "Error en el escaneo: {error}",
    editor_entity: "Sensor de Network Scanner",
    editor_entity_helper: "Déjalo vacío para usar el primer sensor de Network Scanner.",
    editor_title: "Título",
    editor_columns: "Columnas de la tabla",
    editor_columns_helper: "Se muestran junto al nombre del dispositivo cuando la tarjeta es lo bastante ancha para una tabla.",
    editor_sort_by: "Ordenar por",
    editor_sort_order: "Orden",
    editor_layout: "Diseño",
    editor_layout_helper: "Automático muestra una tabla si caben las columnas y, si no, una lista.",
    editor_max_height: "Altura máxima",
    editor_max_height_helper: "p. ej., 480px. A partir de esta altura, la lista de dispositivos se desplaza.",
    editor_show_stats: "Mostrar mosaicos de resumen",
    editor_show_toolbar: "Mostrar búsqueda y filtros",
    editor_show_scan_button: "Mostrar botón de escaneo",
    layout_auto: "Automático",
    layout_table: "Tabla",
    layout_list: "Lista",
  },
  fr: {
    card_description: "Liste des appareils détectés par l'intégration Network Scanner, avec tri et recherche.",
    column_name: "Appareil",
    column_ip: "Adresse IP",
    column_mac: "Adresse MAC",
    column_vendor: "Fabricant",
    column_hostname: "Nom d'hôte",
    column_type: "Description",
    field_name: "Nom",
    status_all: "Appareils",
    status_all_hint: "Tous les appareils détectés lors de la dernière analyse",
    status_known: "Connus",
    status_known_hint: "Nommés dans vos correspondances MAC",
    status_unknown: "Inconnus",
    status_unknown_hint: "Pas encore dans vos correspondances MAC",
    status_private: "MAC privée",
    status_private_hint: "Adresse MAC aléatoire, typique des téléphones, tablettes et ordinateurs portables",
    vendor_device: "Appareil {vendor}",
    unknown_device: "Appareil inconnu",
    new_device: "Nouvel appareil",
    unknown: "Inconnu",
    just_now: "à l'instant",
    version_mismatch:
      "Network Scanner fonctionne en version {running}, mais cette page a chargé la carte de la version {card}. Actualisez la page pour charger la carte correspondante.",
    refresh: "Actualiser",
    scan_now: "Analyser maintenant",
    scan_now_label: "Analyser le réseau maintenant",
    scanning: "Analyse en cours…",
    filter_by_status: "Filtrer par statut",
    search_placeholder: "Rechercher nom, IP, MAC, fabricant…",
    search_label: "Rechercher des appareils",
    clear_search: "Effacer la recherche",
    filter_by_vendor: "Filtrer par fabricant",
    sort_by: "Trier par",
    device_list: "Appareils",
    scanning_network: "Analyse du réseau en cours…",
    not_configured: "Non configuré",
    scanner_unavailable: "Scanner indisponible",
    waiting_first_scan: "En attente de la première analyse",
    scanned_at: "Analysé {time}",
    updated_at: "Mis à jour {time}",
    all_vendors: "Tous les fabricants",
    unknown_vendor: "Fabricant inconnu",
    ascending: "Croissant",
    descending: "Décroissant",
    switch_to_descending: "Tri croissant, passer au tri décroissant",
    switch_to_ascending: "Tri décroissant, passer au tri croissant",
    sort_by_column: "Trier par {column}",
    sort_by_column_ascending: "Trier par {column}, tri croissant",
    sort_by_column_descending: "Trier par {column}, tri décroissant",
    showing_count: "Affichage de {shown} sur {total} appareils",
    clear_filters: "Effacer les filtres",
    private_address: "Adresse privée",
    copy: "Copier",
    copy_ip: "Copier l'adresse IP",
    copy_mac: "Copier l'adresse MAC",
    copy_mapping: "Copier la ligne de correspondance",
    not_in_mapping: "Absent des correspondances MAC",
    none: "Aucune",
    no_reverse_dns: "Pas de DNS inverse",
    hidden_by_private_mac: "Masqué par la MAC privée",
    private_mac_note:
      "Cet appareil utilise une adresse MAC privée (aléatoire), comme le font par défaut les téléphones, tablettes et ordinateurs portables. Son fabricant ne peut pas être identifié et l'adresse peut changer au fil du temps.",
    mapping_note:
      "Absent de vos correspondances MAC. Ajoutez cette ligne aux correspondances d'adresses MAC de l'intégration pour lui donner un nom :",
    details_label: "Détails de {name}",
    open_web_interface: "Ouvrir l'interface web",
    no_sensor_title: "Aucun capteur Network Scanner trouvé",
    entity_missing: "{entity} n'existe pas. Vérifiez l'entité dans les paramètres de la carte.",
    set_up_integration: "Configurez l'intégration Network Scanner ou choisissez son capteur dans les paramètres de la carte.",
    scan_failed_text: "La dernière analyse du réseau a échoué. Consultez les journaux de Home Assistant pour plus de détails.",
    first_scan_title: "Analyse de votre réseau…",
    first_scan_text: "La première analyse peut prendre une minute. Les appareils s'afficheront ici dès qu'elle sera terminée.",
    no_devices_title: "Aucun appareil trouvé",
    nothing_answered_range: "Aucun appareil n'a répondu dans {range}.",
    nothing_answered: "Aucun appareil n'a répondu lors de la dernière analyse.",
    no_match_title: "Aucun appareil correspondant",
    no_match_text: "Essayez une autre recherche ou effacez les filtres pour voir tous les appareils.",
    copied: "Copié dans le presse-papiers",
    copy_failed: "Impossible de copier dans le presse-papiers",
    scan_failed: "Échec de l'analyse : {error}",
    editor_entity: "Capteur Network Scanner",
    editor_entity_helper: "Laissez vide pour utiliser le premier capteur Network Scanner.",
    editor_title: "Titre",
    editor_columns: "Colonnes du tableau",
    editor_columns_helper: "Affichées à côté du nom de l'appareil lorsque la carte est assez large pour un tableau.",
    editor_sort_by: "Trier par",
    editor_sort_order: "Ordre de tri",
    editor_layout: "Disposition",
    editor_layout_helper: "Automatique affiche un tableau si les colonnes tiennent, et une liste sinon.",
    editor_max_height: "Hauteur maximale",
    editor_max_height_helper: "Par exemple 480px. Au-delà de cette hauteur, la liste des appareils défile.",
    editor_show_stats: "Afficher les tuiles de synthèse",
    editor_show_toolbar: "Afficher la recherche et les filtres",
    editor_show_scan_button: "Afficher le bouton d'analyse",
    layout_auto: "Automatique",
    layout_table: "Tableau",
    layout_list: "Liste",
  },
  it: {
    card_description: "Elenco ordinabile e ricercabile dei dispositivi trovati dall'integrazione Network Scanner.",
    column_name: "Dispositivo",
    column_ip: "Indirizzo IP",
    column_mac: "Indirizzo MAC",
    column_vendor: "Produttore",
    column_hostname: "Nome host",
    column_type: "Descrizione",
    field_name: "Nome",
    status_all: "Dispositivi",
    status_all_hint: "Tutti i dispositivi trovati dall'ultima scansione",
    status_known: "Noti",
    status_known_hint: "Con un nome nelle tue associazioni MAC",
    status_unknown: "Sconosciuti",
    status_unknown_hint: "Non ancora nelle tue associazioni MAC",
    status_private: "MAC privato",
    status_private_hint: "Indirizzo MAC casuale, tipico di telefoni, tablet e portatili",
    vendor_device: "Dispositivo {vendor}",
    unknown_device: "Dispositivo sconosciuto",
    new_device: "Nuovo dispositivo",
    unknown: "Sconosciuto",
    just_now: "pochi istanti fa",
    version_mismatch:
      "Network Scanner è alla versione {running}, ma questa pagina ha caricato la scheda della versione {card}. Ricarica la pagina per caricare la scheda corrispondente.",
    refresh: "Ricarica",
    scan_now: "Scansiona ora",
    scan_now_label: "Scansiona la rete ora",
    scanning: "Scansione in corso…",
    filter_by_status: "Filtra per stato",
    search_placeholder: "Cerca nome, IP, MAC, produttore…",
    search_label: "Cerca dispositivi",
    clear_search: "Cancella ricerca",
    filter_by_vendor: "Filtra per produttore",
    sort_by: "Ordina per",
    device_list: "Dispositivi",
    scanning_network: "Scansione della rete in corso…",
    not_configured: "Non configurato",
    scanner_unavailable: "Scanner non disponibile",
    waiting_first_scan: "In attesa della prima scansione",
    scanned_at: "Ultima scansione {time}",
    updated_at: "Ultimo aggiornamento {time}",
    all_vendors: "Tutti i produttori",
    unknown_vendor: "Produttore sconosciuto",
    ascending: "Crescente",
    descending: "Decrescente",
    switch_to_descending: "Ordine crescente, passa a decrescente",
    switch_to_ascending: "Ordine decrescente, passa a crescente",
    sort_by_column: "Ordina per {column}",
    sort_by_column_ascending: "Ordina per {column}, ordine crescente",
    sort_by_column_descending: "Ordina per {column}, ordine decrescente",
    showing_count: "{shown} di {total} dispositivi visualizzati",
    clear_filters: "Cancella filtri",
    private_address: "Indirizzo privato",
    copy: "Copia",
    copy_ip: "Copia indirizzo IP",
    copy_mac: "Copia indirizzo MAC",
    copy_mapping: "Copia riga di associazione",
    not_in_mapping: "Non nelle associazioni MAC",
    none: "Nessuna",
    no_reverse_dns: "Nessun DNS inverso",
    hidden_by_private_mac: "Nascosto dal MAC privato",
    private_mac_note:
      "Questo dispositivo usa un indirizzo MAC privato (casuale), come fanno per impostazione predefinita telefoni, tablet e portatili. Il produttore non può essere identificato e l'indirizzo può cambiare nel tempo.",
    mapping_note:
      "Non nelle tue associazioni MAC. Aggiungi questa riga alle associazioni degli indirizzi MAC dell'integrazione per dargli un nome:",
    details_label: "Dettagli di {name}",
    open_web_interface: "Apri interfaccia web",
    no_sensor_title: "Nessun sensore Network Scanner trovato",
    entity_missing: "{entity} non esiste. Controlla l'entità nelle impostazioni della scheda.",
    set_up_integration: "Configura l'integrazione Network Scanner o scegli il suo sensore nelle impostazioni della scheda.",
    scan_failed_text: "L'ultima scansione della rete non è riuscita. Controlla i log di Home Assistant per i dettagli.",
    first_scan_title: "Scansione della tua rete in corso…",
    first_scan_text: "La prima scansione può richiedere un minuto. I dispositivi compariranno qui non appena sarà terminata.",
    no_devices_title: "Nessun dispositivo trovato",
    nothing_answered_range: "Nessuna risposta in {range}.",
    nothing_answered: "Nessuna risposta all'ultima scansione.",
    no_match_title: "Nessun dispositivo corrispondente",
    no_match_text: "Prova una ricerca diversa o cancella i filtri per vedere tutti i dispositivi.",
    copied: "Copiato negli appunti",
    copy_failed: "Impossibile copiare negli appunti",
    scan_failed: "Scansione non riuscita: {error}",
    editor_entity: "Sensore Network Scanner",
    editor_entity_helper: "Lascia vuoto per usare il primo sensore Network Scanner.",
    editor_title: "Titolo",
    editor_columns: "Colonne della tabella",
    editor_columns_helper: "Mostrate accanto al nome del dispositivo quando la scheda è abbastanza larga per una tabella.",
    editor_sort_by: "Ordina per",
    editor_sort_order: "Ordinamento",
    editor_layout: "Layout",
    editor_layout_helper: "Automatico mostra una tabella se le colonne ci stanno, altrimenti un elenco.",
    editor_max_height: "Altezza massima",
    editor_max_height_helper: "Ad es. 480px. Oltre questa altezza l'elenco dei dispositivi scorre.",
    editor_show_stats: "Mostra riquadri di riepilogo",
    editor_show_toolbar: "Mostra ricerca e filtri",
    editor_show_scan_button: "Mostra pulsante di scansione",
    layout_auto: "Automatico",
    layout_table: "Tabella",
    layout_list: "Elenco",
  },
  nl: {
    card_description: "Sorteerbare, doorzoekbare lijst van de apparaten die de Network Scanner-integratie heeft gevonden.",
    column_name: "Apparaat",
    column_ip: "IP-adres",
    column_mac: "MAC-adres",
    column_vendor: "Fabrikant",
    column_hostname: "Hostnaam",
    column_type: "Beschrijving",
    field_name: "Naam",
    status_all: "Apparaten",
    status_all_hint: "Alle apparaten die de laatste scan heeft gevonden",
    status_known: "Bekend",
    status_known_hint: "Benoemd in je MAC-koppelingen",
    status_unknown: "Onbekend",
    status_unknown_hint: "Nog niet in je MAC-koppelingen",
    status_private: "Privé-MAC",
    status_private_hint: "Willekeurig MAC-adres, typisch voor telefoons, tablets en laptops",
    vendor_device: "{vendor}-apparaat",
    unknown_device: "Onbekend apparaat",
    new_device: "Nieuw apparaat",
    unknown: "Onbekend",
    just_now: "zojuist",
    version_mismatch:
      "Network Scanner draait versie {running}, maar deze pagina heeft de kaart van versie {card} geladen. Vernieuw de pagina om de bijbehorende kaart te laden.",
    refresh: "Vernieuwen",
    scan_now: "Nu scannen",
    scan_now_label: "Het netwerk nu scannen",
    scanning: "Bezig met scannen…",
    filter_by_status: "Filteren op status",
    search_placeholder: "Zoek op naam, IP, MAC, fabrikant…",
    search_label: "Apparaten zoeken",
    clear_search: "Zoekopdracht wissen",
    filter_by_vendor: "Filteren op fabrikant",
    sort_by: "Sorteren op",
    device_list: "Apparaten",
    scanning_network: "Netwerk wordt gescand…",
    not_configured: "Niet geconfigureerd",
    scanner_unavailable: "Scanner niet beschikbaar",
    waiting_first_scan: "Wachten op de eerste scan",
    scanned_at: "Gescand {time}",
    updated_at: "Bijgewerkt {time}",
    all_vendors: "Alle fabrikanten",
    unknown_vendor: "Onbekende fabrikant",
    ascending: "Oplopend",
    descending: "Aflopend",
    switch_to_descending: "Oplopend gesorteerd, overschakelen naar aflopend",
    switch_to_ascending: "Aflopend gesorteerd, overschakelen naar oplopend",
    sort_by_column: "Sorteren op {column}",
    sort_by_column_ascending: "Sorteren op {column}, oplopend gesorteerd",
    sort_by_column_descending: "Sorteren op {column}, aflopend gesorteerd",
    showing_count: "{shown} van {total} apparaten weergegeven",
    clear_filters: "Filters wissen",
    private_address: "Privéadres",
    copy: "Kopiëren",
    copy_ip: "IP-adres kopiëren",
    copy_mac: "MAC-adres kopiëren",
    copy_mapping: "Koppelingsregel kopiëren",
    not_in_mapping: "Niet in MAC-koppelingen",
    none: "Geen",
    no_reverse_dns: "Geen reverse DNS",
    hidden_by_private_mac: "Verborgen door privé-MAC",
    private_mac_note:
      "Dit apparaat gebruikt een privé (willekeurig) MAC-adres, zoals telefoons, tablets en laptops standaard doen. De fabrikant kan niet worden opgezocht en het adres kan na verloop van tijd veranderen.",
    mapping_note:
      "Niet in je MAC-koppelingen. Voeg deze regel toe aan de MAC-adreskoppelingen van de integratie om het apparaat een naam te geven:",
    details_label: "Details van {name}",
    open_web_interface: "Webinterface openen",
    no_sensor_title: "Geen scannersensor gevonden",
    entity_missing: "{entity} bestaat niet. Controleer de entiteit in de kaartinstellingen.",
    set_up_integration: "Stel de Network Scanner-integratie in, of kies de sensor ervan in de kaartinstellingen.",
    scan_failed_text: "De laatste netwerkscan is mislukt. Bekijk de logboeken van Home Assistant voor details.",
    first_scan_title: "Je netwerk wordt gescand…",
    first_scan_text: "De eerste scan kan een minuut duren. Apparaten verschijnen hier zodra hij klaar is.",
    no_devices_title: "Geen apparaten gevonden",
    nothing_answered_range: "Niets heeft geantwoord in {range}.",
    nothing_answered: "Niets heeft geantwoord bij de laatste scan.",
    no_match_title: "Geen overeenkomende apparaten",
    no_match_text: "Probeer een andere zoekopdracht, of wis de filters om alle apparaten te zien.",
    copied: "Gekopieerd naar klembord",
    copy_failed: "Kopiëren naar klembord mislukt",
    scan_failed: "Scan mislukt: {error}",
    editor_entity: "Network Scanner-sensor",
    editor_entity_helper: "Laat leeg om de eerste Network Scanner-sensor te gebruiken.",
    editor_title: "Titel",
    editor_columns: "Tabelkolommen",
    editor_columns_helper: "Worden naast de apparaatnaam getoond als de kaart breed genoeg is voor een tabel.",
    editor_sort_by: "Sorteren op",
    editor_sort_order: "Sorteervolgorde",
    editor_layout: "Indeling",
    editor_layout_helper: "Automatisch toont een tabel als de kolommen passen en anders een lijst.",
    editor_max_height: "Maximale hoogte",
    editor_max_height_helper: "Bijv. 480px. Boven deze hoogte scrolt de apparatenlijst.",
    editor_show_stats: "Overzichtstegels tonen",
    editor_show_toolbar: "Zoeken en filters tonen",
    editor_show_scan_button: "Scanknop tonen",
    layout_auto: "Automatisch",
    layout_table: "Tabel",
    layout_list: "Lijst",
  },
  pl: {
    card_description: "Lista urządzeń znalezionych przez integrację Network Scanner, z sortowaniem i wyszukiwaniem.",
    column_name: "Urządzenie",
    column_ip: "Adres IP",
    column_mac: "Adres MAC",
    column_vendor: "Producent",
    column_hostname: "Nazwa hosta",
    column_type: "Opis",
    field_name: "Nazwa",
    status_all: "Urządzenia",
    status_all_hint: "Wszystkie urządzenia znalezione podczas ostatniego skanowania",
    status_known: "Znane",
    status_known_hint: "Nazwane w mapowaniach MAC",
    status_unknown: "Nieznane",
    status_unknown_hint: "Jeszcze nie ma ich w mapowaniach MAC",
    status_private: "Prywatny MAC",
    status_private_hint: "Losowy adres MAC, typowy dla telefonów, tabletów i laptopów",
    vendor_device: "Urządzenie {vendor}",
    unknown_device: "Nieznane urządzenie",
    new_device: "Nowe urządzenie",
    unknown: "Nieznany",
    just_now: "przed chwilą",
    version_mismatch:
      "Network Scanner działa w wersji {running}, ale ta strona wczytała kartę z wersji {card}. Odśwież stronę, aby wczytać pasującą kartę.",
    refresh: "Odśwież",
    scan_now: "Skanuj teraz",
    scan_now_label: "Skanuj sieć teraz",
    scanning: "Skanowanie…",
    filter_by_status: "Filtruj według stanu",
    search_placeholder: "Szukaj nazwy, IP, MAC, producenta…",
    search_label: "Szukaj urządzeń",
    clear_search: "Wyczyść wyszukiwanie",
    filter_by_vendor: "Filtruj według producenta",
    sort_by: "Sortuj według",
    device_list: "Urządzenia",
    scanning_network: "Skanowanie sieci…",
    not_configured: "Nieskonfigurowany",
    scanner_unavailable: "Skaner niedostępny",
    waiting_first_scan: "Oczekiwanie na pierwsze skanowanie",
    scanned_at: "Skanowano {time}",
    updated_at: "Zaktualizowano {time}",
    all_vendors: "Wszyscy producenci",
    unknown_vendor: "Nieznany producent",
    ascending: "Rosnąco",
    descending: "Malejąco",
    switch_to_descending: "Sortowanie rosnące, przełącz na malejące",
    switch_to_ascending: "Sortowanie malejące, przełącz na rosnące",
    sort_by_column: "Sortuj według: {column}",
    sort_by_column_ascending: "Sortuj według: {column}, sortowanie rosnące",
    sort_by_column_descending: "Sortuj według: {column}, sortowanie malejące",
    showing_count: "Wyświetlono {shown} z {total}",
    clear_filters: "Wyczyść filtry",
    private_address: "Adres prywatny",
    copy: "Kopiuj",
    copy_ip: "Kopiuj adres IP",
    copy_mac: "Kopiuj adres MAC",
    copy_mapping: "Kopiuj wiersz mapowania",
    not_in_mapping: "Brak w mapowaniach MAC",
    none: "Brak",
    no_reverse_dns: "Brak odwrotnego DNS",
    hidden_by_private_mac: "Ukryty przez prywatny MAC",
    private_mac_note:
      "To urządzenie używa prywatnego (losowego) adresu MAC, jak domyślnie robią to telefony, tablety i laptopy. Nie można ustalić producenta, a adres może się z czasem zmieniać.",
    mapping_note: "Brak w mapowaniach MAC. Dodaj ten wiersz do mapowań adresów MAC integracji, aby nadać urządzeniu nazwę:",
    details_label: "Szczegóły: {name}",
    open_web_interface: "Otwórz interfejs WWW",
    no_sensor_title: "Nie znaleziono sensora Network Scanner",
    entity_missing: "{entity} nie istnieje. Sprawdź encję w ustawieniach karty.",
    set_up_integration: "Skonfiguruj integrację Network Scanner lub wybierz jej sensor w ustawieniach karty.",
    scan_failed_text: "Ostatnie skanowanie sieci nie powiodło się. Szczegóły znajdziesz w logach Home Assistanta.",
    first_scan_title: "Trwa skanowanie sieci…",
    first_scan_text: "Pierwsze skanowanie może potrwać minutę. Urządzenia pojawią się tutaj zaraz po jego zakończeniu.",
    no_devices_title: "Nie znaleziono urządzeń",
    nothing_answered_range: "Nic nie odpowiedziało w zakresie {range}.",
    nothing_answered: "Nic nie odpowiedziało podczas ostatniego skanowania.",
    no_match_title: "Brak pasujących urządzeń",
    no_match_text: "Spróbuj innego wyszukiwania lub wyczyść filtry, aby zobaczyć wszystkie urządzenia.",
    copied: "Skopiowano do schowka",
    copy_failed: "Nie udało się skopiować do schowka",
    scan_failed: "Skanowanie nie powiodło się: {error}",
    editor_entity: "Sensor Network Scanner",
    editor_entity_helper: "Pozostaw puste, aby użyć pierwszego sensora Network Scanner.",
    editor_title: "Tytuł",
    editor_columns: "Kolumny tabeli",
    editor_columns_helper: "Wyświetlane obok nazwy urządzenia, gdy karta jest wystarczająco szeroka na tabelę.",
    editor_sort_by: "Sortuj według",
    editor_sort_order: "Kolejność sortowania",
    editor_layout: "Układ",
    editor_layout_helper: "Automatyczny pokazuje tabelę, gdy kolumny się mieszczą, a w przeciwnym razie listę.",
    editor_max_height: "Maksymalna wysokość",
    editor_max_height_helper: "Np. 480px. Powyżej tej wysokości lista urządzeń jest przewijana.",
    editor_show_stats: "Pokaż kafelki podsumowania",
    editor_show_toolbar: "Pokaż wyszukiwanie i filtry",
    editor_show_scan_button: "Pokaż przycisk skanowania",
    layout_auto: "Automatyczny",
    layout_table: "Tabela",
    layout_list: "Lista",
  },
  sv: {
    card_description: "Sorterbar och sökbar lista över enheterna som integrationen Network Scanner har hittat.",
    column_name: "Enhet",
    column_ip: "IP-adress",
    column_mac: "MAC-adress",
    column_vendor: "Tillverkare",
    column_hostname: "Värdnamn",
    column_type: "Beskrivning",
    field_name: "Namn",
    status_all: "Enheter",
    status_all_hint: "Alla enheter som den senaste skanningen hittade",
    status_known: "Kända",
    status_known_hint: "Namngivna i dina MAC-mappningar",
    status_unknown: "Okända",
    status_unknown_hint: "Finns inte i dina MAC-mappningar än",
    status_private: "Privat MAC",
    status_private_hint: "Slumpmässig MAC-adress, typisk för telefoner, surfplattor och bärbara datorer",
    vendor_device: "{vendor}-enhet",
    unknown_device: "Okänd enhet",
    new_device: "Ny enhet",
    unknown: "Okänd",
    just_now: "nyss",
    version_mismatch:
      "Network Scanner kör version {running}, men den här sidan läste in kortet från version {card}. Uppdatera sidan för att läsa in rätt kort.",
    refresh: "Uppdatera",
    scan_now: "Skanna nu",
    scan_now_label: "Skanna nätverket nu",
    scanning: "Skannar…",
    filter_by_status: "Filtrera efter status",
    search_placeholder: "Sök namn, IP, MAC, tillverkare…",
    search_label: "Sök enheter",
    clear_search: "Rensa sökning",
    filter_by_vendor: "Filtrera efter tillverkare",
    sort_by: "Sortera efter",
    device_list: "Enheter",
    scanning_network: "Skannar nätverket…",
    not_configured: "Inte konfigurerad",
    scanner_unavailable: "Skannern är inte tillgänglig",
    waiting_first_scan: "Väntar på den första skanningen",
    scanned_at: "Skannat {time}",
    updated_at: "Uppdaterat {time}",
    all_vendors: "Alla tillverkare",
    unknown_vendor: "Okänd tillverkare",
    ascending: "Stigande",
    descending: "Fallande",
    switch_to_descending: "Sorterat stigande, byt till fallande",
    switch_to_ascending: "Sorterat fallande, byt till stigande",
    sort_by_column: "Sortera efter {column}",
    sort_by_column_ascending: "Sortera efter {column}, sorterat stigande",
    sort_by_column_descending: "Sortera efter {column}, sorterat fallande",
    showing_count: "Visar {shown} av {total} enheter",
    clear_filters: "Rensa filter",
    private_address: "Privat adress",
    copy: "Kopiera",
    copy_ip: "Kopiera IP-adress",
    copy_mac: "Kopiera MAC-adress",
    copy_mapping: "Kopiera mappningsrad",
    not_in_mapping: "Inte i MAC-mappningen",
    none: "Ingen",
    no_reverse_dns: "Ingen omvänd DNS",
    hidden_by_private_mac: "Dold av privat MAC",
    private_mac_note:
      "Den här enheten använder en privat (slumpmässig) MAC-adress, som telefoner, surfplattor och bärbara datorer gör som standard. Tillverkaren kan inte slås upp och adressen kan ändras med tiden.",
    mapping_note:
      "Finns inte i dina MAC-mappningar. Lägg till den här raden i integrationens MAC-adressmappningar för att ge enheten ett namn:",
    details_label: "Detaljer för {name}",
    open_web_interface: "Öppna webbgränssnitt",
    no_sensor_title: "Ingen Network Scanner-sensor hittades",
    entity_missing: "{entity} finns inte. Kontrollera entiteten i kortets inställningar.",
    set_up_integration: "Konfigurera integrationen Network Scanner eller välj dess sensor i kortets inställningar.",
    scan_failed_text: "Den senaste nätverksskanningen misslyckades. Se Home Assistants loggar för mer information.",
    first_scan_title: "Skannar ditt nätverk…",
    first_scan_text: "Den första skanningen kan ta en minut. Enheterna visas här så snart den är klar.",
    no_devices_title: "Inga enheter hittades",
    nothing_answered_range: "Inget svarade i {range}.",
    nothing_answered: "Inget svarade vid den senaste skanningen.",
    no_match_title: "Inga matchande enheter",
    no_match_text: "Prova en annan sökning eller rensa filtren för att se alla enheter.",
    copied: "Kopierat till urklipp",
    copy_failed: "Det gick inte att kopiera till urklipp",
    scan_failed: "Skanningen misslyckades: {error}",
    editor_entity: "Network Scanner-sensor",
    editor_entity_helper: "Lämna tomt för att använda den första Network Scanner-sensorn.",
    editor_title: "Rubrik",
    editor_columns: "Tabellkolumner",
    editor_columns_helper: "Visas bredvid enhetsnamnet när kortet är tillräckligt brett för en tabell.",
    editor_sort_by: "Sortera efter",
    editor_sort_order: "Sorteringsordning",
    editor_layout: "Layout",
    editor_layout_helper: "Automatisk visar en tabell när kolumnerna får plats och annars en lista.",
    editor_max_height: "Maximal höjd",
    editor_max_height_helper: "T.ex. 480px. Enhetslistan rullar när den blir högre än så.",
    editor_show_stats: "Visa sammanfattningsrutor",
    editor_show_toolbar: "Visa sökning och filter",
    editor_show_scan_button: "Visa skanningsknapp",
    layout_auto: "Automatisk",
    layout_table: "Tabell",
    layout_list: "Lista",
  },
  "zh-Hans": {
    card_description: "Network Scanner 集成发现的设备列表，支持排序和搜索。",
    column_name: "设备",
    column_ip: "IP 地址",
    column_mac: "MAC 地址",
    column_vendor: "厂商",
    column_hostname: "主机名",
    column_type: "描述",
    field_name: "名称",
    status_all: "设备",
    status_all_hint: "上次扫描发现的所有设备",
    status_known: "已知",
    status_known_hint: "已在 MAC 映射中命名",
    status_unknown: "未知",
    status_unknown_hint: "尚未加入 MAC 映射",
    status_private: "私有 MAC",
    status_private_hint: "随机 MAC 地址，常见于手机、平板电脑和笔记本电脑",
    vendor_device: "{vendor} 设备",
    unknown_device: "未知设备",
    new_device: "新设备",
    unknown: "未知",
    just_now: "刚刚",
    version_mismatch: "Network Scanner 正在运行 {running} 版本，但此页面加载的是 {card} 版本的卡片。请刷新页面以加载匹配的卡片。",
    refresh: "刷新",
    scan_now: "立即扫描",
    scan_now_label: "立即扫描网络",
    scanning: "正在扫描…",
    filter_by_status: "按状态筛选",
    search_placeholder: "搜索名称、IP、MAC、厂商…",
    search_label: "搜索设备",
    clear_search: "清除搜索",
    filter_by_vendor: "按厂商筛选",
    sort_by: "排序方式",
    device_list: "设备",
    scanning_network: "正在扫描网络…",
    not_configured: "未配置",
    scanner_unavailable: "扫描器不可用",
    waiting_first_scan: "等待首次扫描",
    scanned_at: "{time}扫描",
    updated_at: "{time}更新",
    all_vendors: "所有厂商",
    unknown_vendor: "未知厂商",
    ascending: "升序",
    descending: "降序",
    switch_to_descending: "当前为升序，切换为降序",
    switch_to_ascending: "当前为降序，切换为升序",
    sort_by_column: "按{column}排序",
    sort_by_column_ascending: "按{column}排序，当前为升序",
    sort_by_column_descending: "按{column}排序，当前为降序",
    showing_count: "显示 {shown} 台，共 {total} 台设备",
    clear_filters: "清除筛选",
    private_address: "私有地址",
    copy: "复制",
    copy_ip: "复制 IP 地址",
    copy_mac: "复制 MAC 地址",
    copy_mapping: "复制映射行",
    not_in_mapping: "不在 MAC 映射中",
    none: "无",
    no_reverse_dns: "无反向 DNS",
    hidden_by_private_mac: "被私有 MAC 隐藏",
    private_mac_note: "此设备使用私有（随机）MAC 地址，手机、平板电脑和笔记本电脑默认都会这样做。无法查询其厂商，且该地址可能会随时间变化。",
    mapping_note: "不在 MAC 映射中。将此行添加到集成的 MAC 地址映射中即可为其命名：",
    details_label: "{name} 详情",
    open_web_interface: "打开网页界面",
    no_sensor_title: "未找到 Network Scanner 传感器",
    entity_missing: "{entity} 不存在。请检查卡片的实体设置。",
    set_up_integration: "请设置 Network Scanner 集成，或在卡片设置中选择其传感器。",
    scan_failed_text: "上次网络扫描失败。请查看 Home Assistant 日志了解详情。",
    first_scan_title: "正在扫描您的网络…",
    first_scan_text: "首次扫描可能需要一分钟。扫描完成后，设备会立即显示在这里。",
    no_devices_title: "未找到设备",
    nothing_answered_range: "{range} 中没有设备响应。",
    nothing_answered: "上次扫描没有设备响应。",
    no_match_title: "没有匹配的设备",
    no_match_text: "请尝试其他搜索，或清除筛选以查看所有设备。",
    copied: "已复制到剪贴板",
    copy_failed: "无法复制到剪贴板",
    scan_failed: "扫描失败：{error}",
    editor_entity: "Network Scanner 传感器",
    editor_entity_helper: "留空则使用第一个 Network Scanner 传感器。",
    editor_title: "标题",
    editor_columns: "表格列",
    editor_columns_helper: "卡片宽度足以显示表格时，显示在设备名称旁边。",
    editor_sort_by: "排序方式",
    editor_sort_order: "排序顺序",
    editor_layout: "布局",
    editor_layout_helper: "自动：列能放下时显示表格，否则显示列表。",
    editor_max_height: "最大高度",
    editor_max_height_helper: "例如 480px。设备列表超过此高度时会滚动。",
    editor_show_stats: "显示汇总磁贴",
    editor_show_toolbar: "显示搜索和筛选",
    editor_show_scan_button: "显示扫描按钮",
    layout_auto: "自动",
    layout_table: "表格",
    layout_list: "列表",
  },
};

// A second copy of this file (say, also added as a dashboard resource by hand)
// must not try to redefine the elements.
if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, NetworkScannerCard);
  customElements.define(EDITOR_TAG, NetworkScannerCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "Network Scanner",
    // A getter, because this file loads before Home Assistant has set the
    // page's language; the card picker reads it later, when it opens.
    get description() {
      return translate(resolveLanguage(document.documentElement.lang), "card_description");
    },
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
