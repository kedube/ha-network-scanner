#!/usr/bin/env node
// Renders the README screenshots of the dashboard card:
//
//     npm run screenshots
//
// The real card file runs in headless Chrome with the fictional devices below,
// so the images never show anyone's actual network. Home Assistant's own
// elements are stood in for: <ha-card> as a plain card surface, and <ha-icon>
// drawing Material Design Icons from @mdi/js, the icon set Home Assistant
// uses. Colors are Home Assistant's default light and dark themes.
//
// Uses Google Chrome if it is installed, otherwise Playwright's Chromium
// (install that with `npx playwright-core install chromium`).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as mdi from "@mdi/js";
import { chromium } from "playwright-core";

const ROOT = new URL("../", import.meta.url);
const INTEGRATION = new URL("custom_components/network_scanner/", ROOT);
const CARD_SOURCE = readFileSync(new URL("frontend/network-scanner-card.js", INTEGRATION), "utf8");
const VERSION = JSON.parse(readFileSync(new URL("manifest.json", INTEGRATION), "utf8")).version;
const ORIGIN = "http://homeassistant.local:8123";
// Served the way __init__.py serves it, so the card reports the real version.
const HASH = createHash("sha256").update(CARD_SOURCE).digest("hex").slice(0, 12);
const CARD_URL = `${ORIGIN}/network_scanner/network-scanner-card.js?v=${VERSION}&h=${HASH}`;
const ENTITY_ID = "sensor.network_scanner";
const DEVICE_ID = "network-scanner-device";

const unknown = { name: "Unknown Device", type: "Unknown Device" };
// Fictional devices, in the shape the integration reports them.
const DEVICES = [
  { ip: "192.168.1.1", mac: "F4:92:BF:3A:10:01", name: "Router", type: "UniFi Dream Machine", vendor: "Ubiquiti Inc", hostname: "unifi" },
  { ip: "192.168.1.10", mac: "3C:2A:F4:81:1B:0A", name: "Office printer", type: "Brother HL-L2350DW", vendor: "Brother Industries", hostname: "brw3c2af4811b0a" },
  { ip: "192.168.1.12", mac: "A8:23:FE:4D:77:12", name: "Living room TV", type: "LG webOS TV", vendor: "LG Electronics", hostname: "lgwebostv" },
  { ip: "192.168.1.15", mac: "48:A6:B8:0C:3E:15", name: "Kitchen speaker", type: "Sonos One", vendor: "Sonos, Inc.", hostname: "sonos-kitchen" },
  { ip: "192.168.1.20", mac: "00:11:32:9A:4F:20", name: "NAS", type: "Synology DS920+", vendor: "Synology Incorporated", hostname: "diskstation" },
  { ip: "192.168.1.23", mac: "DA:A1:19:5E:02:23", ...unknown, vendor: "Unknown", hostname: "pixel-8" },
  { ip: "192.168.1.31", mac: "EC:64:C9:12:AB:31", ...unknown, vendor: "Espressif Inc.", hostname: "esphome-garage" },
  { ip: "192.168.1.42", mac: "EC:71:DB:66:20:42", name: "Front door camera", type: "Reolink Video Doorbell", vendor: "Reolink Innovation Limited", hostname: null },
  { ip: "192.168.1.64", mac: "D8:3A:DD:47:1C:64", name: "Home Assistant", type: "Raspberry Pi 5", vendor: "Raspberry Pi (Trading) Ltd", hostname: "homeassistant" },
  { ip: "192.168.1.88", mac: "F0:2F:4B:0E:57:88", ...unknown, vendor: "Apple, Inc.", hostname: "macbook-air" },
  { ip: "192.168.1.103", mac: "7E:5D:0B:21:C9:03", ...unknown, vendor: "Unknown", hostname: null },
  { ip: "192.168.1.117", mac: "98:41:5C:3A:90:17", ...unknown, vendor: "Nintendo Co.,Ltd", hostname: null },
];

const SHOTS = [
  {
    file: "images/network-scanner-card.png",
    theme: "light",
    width: 920,
  },
  {
    // A phone in dark mode, filtered to unknown devices, with one opened up.
    file: "images/network-scanner-card-mobile.png",
    theme: "dark",
    width: 390,
    steps: [{ click: '.tile[data-status="unknown"]' }, { click: 'li[data-key="F0:2F:4B:0E:57:88"] .row' }],
  },
];

// Home Assistant's default theme variables, as far as the card uses them.
const THEMES = {
  light: {
    "--primary-color": "#03a9f4",
    "--primary-background-color": "#fafafa",
    "--card-background-color": "#ffffff",
    "--primary-text-color": "#212121",
    "--secondary-text-color": "#727272",
    "--divider-color": "rgba(0, 0, 0, 0.12)",
    "--error-color": "#db4437",
    "--success-color": "#43a047",
  },
  dark: {
    "--primary-color": "#03a9f4",
    "--primary-background-color": "#111111",
    "--card-background-color": "#1c1c1c",
    "--primary-text-color": "#e1e1e1",
    "--secondary-text-color": "#9b9b9b",
    "--divider-color": "rgba(225, 225, 225, 0.12)",
    "--error-color": "#db4437",
    "--success-color": "#43a047",
  },
};

/** Every mdi: icon the card can draw, as SVG path data. */
function iconPaths() {
  const names = [...new Set(CARD_SOURCE.match(/mdi:[a-z0-9-]+/g))];
  const paths = {};
  for (const name of names) {
    const exportName = `mdi${name.slice(4).replace(/(^|-)([a-z0-9])/g, (_, _dash, c) => c.toUpperCase())}`;
    if (!mdi[exportName]) throw new Error(`The card uses ${name}, which Material Design Icons doesn't have`);
    paths[name] = mdi[exportName];
  }
  return paths;
}

function page(theme, width) {
  const vars = Object.entries(THEMES[theme]).map(([key, value]) => `${key}: ${value};`).join(" ");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=block">
  <style>
    :root { ${vars} }
    html, body { margin: 0; background: var(--primary-background-color); }
    body { font-family: Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
    #frame { width: ${width}px; padding: 16px; }
  </style>
</head>
<body>
  <div id="frame"></div>
  <script>
    const ICONS = ${JSON.stringify(iconPaths())};
    customElements.define("ha-card", class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = \`<style>
          :host {
            display: block; border-radius: 12px; color: var(--primary-text-color);
            background: var(--card-background-color); border: 1px solid var(--divider-color);
          }</style><slot></slot>\`;
      }
    });
    customElements.define("ha-icon", class extends HTMLElement {
      static observedAttributes = ["icon"];
      constructor() {
        super();
        this.attachShadow({ mode: "open" });
      }
      connectedCallback() { this.draw(); }
      attributeChangedCallback() { this.draw(); }
      draw() {
        this.shadowRoot.innerHTML = \`<style>
          :host { display: inline-flex; vertical-align: middle; fill: currentColor;
            width: var(--mdc-icon-size, 24px); height: var(--mdc-icon-size, 24px); }
          svg { width: 100%; height: 100%; }</style>
          <svg viewBox="0 0 24 24"><path d="\${ICONS[this.getAttribute("icon")] ?? ""}"/></svg>\`;
      }
    });
  </script>
  <script type="module" src="${CARD_URL}"></script>
</body>
</html>`;
}

function hass(theme) {
  const now = Date.now();
  return {
    states: {
      [ENTITY_ID]: {
        entity_id: ENTITY_ID,
        state: String(DEVICES.length),
        last_updated: new Date(now - 2 * 60 * 1000).toISOString(),
        attributes: {
          friendly_name: "Network Scanner",
          unit_of_measurement: "Devices",
          ip_range: "192.168.1.0/24",
          last_scan: new Date(now - 2 * 60 * 1000).toISOString(),
          devices: DEVICES,
        },
      },
    },
    entities: { [ENTITY_ID]: { entity_id: ENTITY_ID, platform: "network_scanner", device_id: DEVICE_ID } },
    devices: { [DEVICE_ID]: { id: DEVICE_ID, sw_version: VERSION } },
    themes: { darkMode: theme === "dark" },
    locale: { language: "en" },
    language: "en",
  };
}

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return chromium.launch();
  }
}

const browser = await launch();
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: { width: shot.width + 32, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: shot.theme,
      reducedMotion: "reduce",
    });
    const tab = await context.newPage();
    tab.on("pageerror", (error) => {
      throw error;
    });
    await tab.route(`${ORIGIN}/**`, (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/lovelace/0`) {
        return route.fulfill({ contentType: "text/html", body: page(shot.theme, shot.width) });
      }
      if (url === CARD_URL) {
        return route.fulfill({ contentType: "text/javascript", body: CARD_SOURCE });
      }
      return route.fulfill({ status: 404 });
    });
    await tab.goto(`${ORIGIN}/lovelace/0`);
    await tab.waitForFunction(() => customElements.get("network-scanner-card"));
    await tab.evaluate(() => document.fonts.ready);
    await tab.evaluate((hass) => {
      const card = document.createElement("network-scanner-card");
      card.setConfig({ type: "custom:network-scanner-card", entity: "sensor.network_scanner" });
      card.hass = { ...hass, callService: async () => {} };
      document.getElementById("frame").append(card);
    }, hass(shot.theme));

    for (const step of shot.steps ?? []) {
      await tab.locator("network-scanner-card").locator(step.click).click();
    }
    // Let the card's layout settle (it measures itself, then renders a frame later).
    await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await tab.locator("#frame").screenshot({ path: fileURLToPath(new URL(shot.file, ROOT)) });
    console.log(`Wrote ${shot.file}`);
    await context.close();
  }
} finally {
  await browser.close();
}
