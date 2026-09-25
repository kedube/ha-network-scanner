// Tests for the Network Scanner dashboard card.
//
// The card file is loaded unmodified into jsdom and driven through its shadow
// DOM the way a user would drive it. Device data comes from the same fixture
// the Python tests expect the integration to produce.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const INTEGRATION = new URL("../../custom_components/network_scanner/", import.meta.url);
const CARD_SOURCE = readFileSync(new URL("frontend/network-scanner-card.js", INTEGRATION), "utf8");
const INTEGRATION_VERSION = JSON.parse(readFileSync(new URL("manifest.json", INTEGRATION), "utf8")).version;
const DEVICES = JSON.parse(readFileSync(new URL("../fixtures/sweep_devices.json", import.meta.url), "utf8"));
const ENTITY_ID = "sensor.network_scanner";
const DEVICE_ID = "network-scanner-device";
const PAGE_URL = "http://homeassistant.local:8123/lovelace/0";
// What __init__.py registers: the integration version, plus a content hash.
const SERVED_QUERY = `?v=${INTEGRATION_VERSION}&h=0123456789ab`;

// ---------------------------------------------------------------- harness

/**
 * A fresh window with the card loaded. Closed automatically after the test.
 *
 * window.consoleInfo collects console.info output. window.jsdomErrors
 * collects uncaught errors and unimplemented browser APIs; any left over when
 * the test ends fail it, so a test that expects one must take it out.
 */
function loadCard(t, { query = SERVED_QUERY } = {}) {
  const virtualConsole = new VirtualConsole();
  const consoleInfo = [];
  const jsdomErrors = [];
  virtualConsole.on("info", (...args) => consoleInfo.push(args.join(" ")));
  virtualConsole.on("jsdomError", (error) => jsdomErrors.push(error));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: PAGE_URL,
    virtualConsole,
  });
  const { window } = dom;
  window.consoleInfo = consoleInfo;
  window.jsdomErrors = jsdomErrors;
  // jsdom has no ResizeObserver. This one lets tests set the card's width.
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
  window.resizeCards = (width) => observers.forEach((o) => o.callback([{ contentRect: { width } }]));
  // The card is an ES module that reads its version from import.meta.url.
  // jsdom evaluates classic scripts, so substitute the URL it is served from.
  const moduleUrl = new URL(`/network_scanner/network-scanner-card.js${query}`, PAGE_URL).href;
  window.evalCard = () => window.eval(CARD_SOURCE.replaceAll("import.meta.url", JSON.stringify(moduleUrl)));
  window.evalCard();
  t.after(() => {
    window.close();
    assert.deepEqual(jsdomErrors.map(String), [], "uncaught errors in the card");
  });
  return window;
}

function scannerState(devices = DEVICES, overrides = {}) {
  return {
    entity_id: ENTITY_ID,
    state: String(devices.length),
    last_updated: new Date().toISOString(),
    ...overrides,
    attributes: {
      friendly_name: "Network Scanner",
      unit_of_measurement: "Devices",
      ip_range: "192.168.1.0/24",
      last_scan: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      devices,
      ...overrides.attributes,
    },
  };
}

function makeHass(states = { [ENTITY_ID]: scannerState() }, { integrationVersion = INTEGRATION_VERSION } = {}) {
  const hass = {
    states,
    entities: { [ENTITY_ID]: { entity_id: ENTITY_ID, platform: "network_scanner", device_id: DEVICE_ID } },
    devices: { [DEVICE_ID]: { id: DEVICE_ID, sw_version: integrationVersion } },
    themes: { darkMode: false },
    locale: { language: "en" },
    language: "en",
    serviceCalls: [],
    callService: async (domain, service, data) => {
      hass.serviceCalls.push([domain, service, { ...data }]);
    },
  };
  return hass;
}

function mount(window, config = {}, hass = makeHass()) {
  const card = window.document.createElement("network-scanner-card");
  card.setConfig({ type: "custom:network-scanner-card", entity: ENTITY_ID, ...config });
  card.hass = hass;
  window.document.body.appendChild(card);
  return card;
}

const $ = (card, selector) => card.shadowRoot.querySelector(selector);
const $$ = (card, selector) => [...card.shadowRoot.querySelectorAll(selector)];
const text = (el) => el?.textContent.replace(/\s+/g, " ").trim();
const labels = (card) => $$(card, "li.device .primary").map(text);
const ips = (card) => $$(card, "li.device").map((li) => text(li.querySelector(".trail, .cell.mono")));
const tile = (card, status) => text($(card, `.tile[data-status="${status}"] .tile-value`));
/** Objects created inside the jsdom realm, as plain values for deepEqual. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Filtering and sorting render on the next animation frame. */
const nextFrame = (window) => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function typeSearch(window, card, query) {
  const input = $(card, ".search input");
  input.value = query;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await nextFrame(window);
}

async function choose(window, card, role, value) {
  const select = $(card, `select[data-role="${role}"]`);
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await nextFrame(window);
}

async function click(window, element) {
  assert.ok(element, "element to click exists");
  element.click();
  await nextFrame(window);
}

function deviceRow(card, ip) {
  return $$(card, "li.device").find((li) => li.dataset.key === DEVICES.find((d) => d.ip === ip).mac.toUpperCase());
}

// ---------------------------------------------------------------- registration and config

describe("registration", () => {
  test("defines the card and its editor, and lists the card in the card picker", (t) => {
    const window = loadCard(t);
    assert.ok(window.customElements.get("network-scanner-card"));
    assert.ok(window.customElements.get("network-scanner-card-editor"));
    assert.deepEqual(plain(window.customCards), [
      {
        type: "network-scanner-card",
        name: "Network Scanner",
        description: "Sortable, searchable list of the devices found by the Network Scanner integration.",
        preview: true,
        documentationURL: "https://github.com/kedube/ha-network-scanner",
      },
    ]);
  });

  test("loading the file twice does not throw or register the card twice", (t) => {
    const window = loadCard(t);
    window.evalCard();
    assert.equal(window.customCards.length, 1);
  });

  test("the stub config picks the integration's sensor", (t) => {
    const window = loadCard(t);
    const Card = window.customElements.get("network-scanner-card");
    const hass = makeHass({ "sensor.other": { state: "3", attributes: {} }, [ENTITY_ID]: scannerState() });
    assert.deepEqual(plain(Card.getStubConfig(hass)), { entity: ENTITY_ID });

    // Without entity registry data it recognises the sensor by its attributes.
    hass.entities = {};
    assert.deepEqual(plain(Card.getStubConfig(hass)), { entity: ENTITY_ID });
    assert.deepEqual(plain(Card.getStubConfig(makeHass({}))), {});
  });
});

describe("versioning", () => {
  const banners = (window) => window.consoleInfo.filter((line) => line.includes("NETWORK-SCANNER-CARD"));

  test("logs the integration release it was served with, once", (t) => {
    const window = loadCard(t);
    window.evalCard();
    assert.equal(banners(window).length, 1);
    assert.ok(banners(window)[0].includes(`v${INTEGRATION_VERSION}`), banners(window)[0]);
  });

  test("shows no notice when it matches the running integration", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    assert.equal($(card, ".update").hidden, true);
  });

  test("a page left open across an upgrade offers a refresh", async (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    const card = mount(window, {}, hass);

    // Home Assistant restarts on the new release; this page still runs the old card.
    card.hass = { ...hass, devices: { [DEVICE_ID]: { id: DEVICE_ID, sw_version: "99.0.0" } } };
    const notice = $(card, ".update");
    assert.equal(notice.hidden, false);
    assert.match(text(notice), /Network Scanner is running version 99\.0\.0/);
    assert.ok(text(notice).includes(`loaded the card from version ${INTEGRATION_VERSION}`), text(notice));

    // Still shown after the card is reconfigured and redrawn.
    card.setConfig({ type: "custom:network-scanner-card", entity: ENTITY_ID, title: "LAN" });
    assert.equal($(card, ".update").hidden, false);

    await click(window, $(card, '.update [data-action="reload"]'));
    // jsdom can't navigate; the attempt is the page reload.
    const reload = window.jsdomErrors.splice(0);
    assert.equal(reload.length, 1);
    assert.match(String(reload[0].message), /navigation/i);
  });

  test("stays quiet when it can't tell which release it is", (t) => {
    const window = loadCard(t, { query: "" });
    const card = mount(window, {}, makeHass(undefined, { integrationVersion: "99.0.0" }));
    assert.equal($(card, ".update").hidden, true);
    assert.ok(banners(window)[0].includes("vunknown"), banners(window)[0]);
  });

  test("stays quiet without device registry data", (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    delete hass.devices;
    const card = mount(window, {}, hass);
    assert.equal($(card, ".update").hidden, true);
  });
});

describe("setConfig", () => {
  const invalid = [
    [{ columns: ["ip", "rssi"] }, /Unknown column "rssi"/],
    [{ columns: "ip" }, /columns must be a list/],
    [{ sort_by: "age" }, /Unknown sort_by "age"/],
    [{ sort_order: "up" }, /sort_order must be/],
    [{ layout: "grid" }, /layout must be/],
  ];
  for (const [config, message] of invalid) {
    test(`rejects ${JSON.stringify(config)}`, (t) => {
      const window = loadCard(t);
      const card = window.document.createElement("network-scanner-card");
      assert.throws(() => card.setConfig({ type: "custom:network-scanner-card", ...config }), message);
    });
  }

  test("accepts a config with every option set", (t) => {
    const window = loadCard(t);
    const card = mount(window, {
      title: "Home LAN",
      columns: ["mac", "hostname", "type"],
      sort_by: "vendor",
      sort_order: "desc",
      layout: "table",
      max_height: "480px",
      show_stats: false,
      show_toolbar: false,
      show_scan_button: false,
    });
    assert.equal(text($(card, ".title")), "Home LAN");
    assert.equal($(card, ".stats"), null);
    assert.equal($(card, ".toolbar"), null);
    assert.equal($(card, ".scan"), null);
    assert.ok($(card, ".card").classList.contains("scroll"));
  });
});

// ---------------------------------------------------------------- rendering

describe("device list", () => {
  test("shows every device in IP order with the best available label", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    // Mapped name, else hostname, else "<vendor> device", else "Unknown device".
    assert.deepEqual(labels(card), ["router", "living-room-tv", "Brother Printer", "Unknown device", "nas"]);
    assert.deepEqual(ips(card), ["192.168.1.1", "192.168.1.9", "192.168.1.10", "192.168.1.23", "192.168.1.100"]);
  });

  test("labels a nameless device after its vendor, without the company suffix", (t) => {
    const window = loadCard(t);
    const device = { ip: "192.168.1.2", mac: "50:C7:BF:00:00:02", name: "Unknown Device", type: "Unknown Device", vendor: "TP-LINK TECHNOLOGIES CO.,LTD.", hostname: null };
    const card = mount(window, {}, makeHass({ [ENTITY_ID]: scannerState([device]) }));
    assert.deepEqual(labels(card), ["TP-LINK device"]);
  });

  test("picks an icon from the name, hostname and vendor", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    const icons = $$(card, "li.device .avatar ha-icon").map((icon) => icon.getAttribute("icon"));
    assert.deepEqual(icons, ["mdi:router-wireless", "mdi:television", "mdi:printer", "mdi:devices", "mdi:server"]);
  });

  test("summary tiles count known, unknown and private-MAC devices", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    assert.equal(tile(card, "all"), "5");
    assert.equal(tile(card, "known"), "1");
    assert.equal(tile(card, "unknown"), "4");
    // DA:... has the locally-administered bit set.
    assert.equal(tile(card, "private"), "1");
  });

  test("header shows the range and when the network was last scanned", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    assert.equal(text($(card, ".title")), "Network Scanner");
    assert.equal(text($(card, ".subtitle")), "192.168.1.0/24 · Scanned 3 minutes ago");
  });

  test("falls back to last_updated, labelled honestly, without last_scan", (t) => {
    const window = loadCard(t);
    const state = scannerState(DEVICES, { last_updated: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    delete state.attributes.last_scan;
    const card = mount(window, {}, makeHass({ [ENTITY_ID]: state }));
    assert.equal(text($(card, ".subtitle")), "192.168.1.0/24 · Updated 2 hours ago");
  });

  test("table layout shows column headers; list layout does not", (t) => {
    const window = loadCard(t);
    const table = mount(window, { layout: "table", columns: ["ip", "vendor"] });
    assert.deepEqual($$(table, ".list-head .th").map(text), ["Device", "IP address", "Vendor"]);
    assert.equal($(table, ".list-head").hidden, false);

    const list = mount(window, { layout: "list" });
    assert.equal($(list, ".list-head").hidden, true);
    assert.ok($(list, ".card").classList.contains("narrow"));
  });

  test("automatic layout switches between table and list with the card's width", (t) => {
    const window = loadCard(t);
    const card = mount(window);
    window.resizeCards(1000);
    assert.equal($(card, ".card").classList.contains("narrow"), false);
    assert.equal($(card, ".list-head").hidden, false);

    window.resizeCards(360);
    assert.ok($(card, ".card").classList.contains("narrow"));
    assert.ok($(card, ".card").classList.contains("compact"));
    assert.equal($(card, ".list-head").hidden, true);
  });

  test("escapes device data instead of rendering it as HTML", async (t) => {
    const window = loadCard(t);
    const payload = `<img src=x onerror="window.pwned=1">`;
    const device = { ip: "192.168.1.66", mac: "AA:BB:CC:DD:EE:66", name: payload, type: `"><script>1</script>`, vendor: payload, hostname: null };
    const card = mount(window, { layout: "table", columns: ["ip", "vendor", "type"] }, makeHass({ [ENTITY_ID]: scannerState([device]) }));
    await click(window, $(card, "li.device .row"));

    assert.equal(text($(card, ".primary")), payload);
    assert.equal(card.shadowRoot.querySelectorAll("img, script").length, 0);
    assert.equal(window.pwned, undefined);
  });

  test("ignores Home Assistant updates that don't touch the scanner sensor", (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    const card = mount(window, {}, hass);
    const row = $(card, "li.device");

    card.hass = { ...hass, states: { ...hass.states, "light.kitchen": { state: "on", attributes: {} } } };
    assert.equal($(card, "li.device"), row, "rows were rebuilt for an unrelated state change");

    card.hass = { ...hass, states: { [ENTITY_ID]: scannerState(DEVICES.slice(0, 2)) } };
    assert.equal($$(card, "li.device").length, 2);
  });
});

describe("empty and error states", () => {
  const cases = [
    ["a missing sensor", { entity: "sensor.nope" }, {}, "No scanner sensor found", /sensor\.nope doesn't exist/],
    ["an unavailable sensor", {}, { [ENTITY_ID]: scannerState([], { state: "unavailable" }) }, "Scanner unavailable", /last network scan failed/],
    ["the first scan still running", {}, { [ENTITY_ID]: scannerState([], { state: "unknown" }) }, "Scanning your network…", /first scan can take a minute/],
    ["a scan that found nothing", {}, { [ENTITY_ID]: scannerState([]) }, "No devices found", /Nothing answered in 192\.168\.1\.0\/24/],
  ];
  for (const [name, config, states, title, message] of cases) {
    test(`explains ${name}`, (t) => {
      const window = loadCard(t);
      const card = mount(window, config, makeHass(states));
      assert.equal(text($(card, ".empty-title")), title);
      assert.match(text($(card, ".empty-text")), message);
      assert.equal($$(card, "li.device").length, 0);
    });
  }

  test("offers a retry when the scanner is unavailable", (t) => {
    const window = loadCard(t);
    const card = mount(window, {}, makeHass({ [ENTITY_ID]: scannerState([], { state: "unavailable" }) }));
    assert.ok($(card, '.empty [data-action="scan"]'));
    assert.equal(text($(card, ".subtitle")), "Scanner unavailable");
  });
});

// ---------------------------------------------------------------- interaction

describe("search and filters", () => {
  test("search matches name, vendor, and MAC with or without colons", async (t) => {
    const window = loadCard(t);
    const card = mount(window);

    await typeSearch(window, card, "brother");
    assert.deepEqual(labels(card), ["Brother Printer"]);

    await typeSearch(window, card, "bc1414");
    assert.deepEqual(labels(card), ["Brother Printer"]);

    await typeSearch(window, card, "synology");
    assert.deepEqual(labels(card), ["nas"]);
    assert.equal(text($(card, ".foot span")), "Showing 1 of 5 devices");
  });

  test("highlights what matched", async (t) => {
    const window = loadCard(t);
    const card = mount(window);
    await typeSearch(window, card, "living");
    assert.equal(text($(card, ".primary mark")), "living");
  });

  test("Escape clears the search", async (t) => {
    const window = loadCard(t);
    const card = mount(window);
    await typeSearch(window, card, "brother");
    const input = $(card, ".search input");
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextFrame(window);
    assert.equal(input.value, "");
    assert.equal(labels(card).length, 5);
  });

  test("a search with no hits offers to clear the filters", async (t) => {
    const window = loadCard(t);
    const card = mount(window);
    await typeSearch(window, card, "nothing-matches-this");
    assert.equal(text($(card, ".empty-title")), "No matching devices");
    await click(window, $(card, '.empty [data-action="clear-filters"]'));
    assert.equal(labels(card).length, 5);
  });

  test("summary tiles filter the list and toggle off again", async (t) => {
    const window = loadCard(t);
    const card = mount(window);

    await click(window, $(card, '.tile[data-status="known"]'));
    assert.deepEqual(labels(card), ["Brother Printer"]);
    assert.equal($(card, '.tile[data-status="known"]').getAttribute("aria-pressed"), "true");

    await click(window, $(card, '.tile[data-status="private"]'));
    assert.deepEqual(labels(card), ["Unknown device"]);

    await click(window, $(card, '.tile[data-status="private"]'));
    assert.equal(labels(card).length, 5);
  });

  test("vendor filter lists each vendor once, with devices lacking one last", async (t) => {
    const window = loadCard(t);
    const card = mount(window);
    const options = $$(card, 'select[data-role="vendor"] option').map(text);
    assert.deepEqual(options, [
      "All vendors",
      "Amazon Technologies (1)",
      "Brother Industries (1)",
      "Synology Incorporated (1)",
      "TP-Link Technologies (1)",
      "Unknown vendor (1)",
    ]);

    await choose(window, card, "vendor", "Brother Industries");
    assert.deepEqual(labels(card), ["Brother Printer"]);

    await choose(window, card, "vendor", "__none__");
    assert.deepEqual(labels(card), ["Unknown device"]);

    await click(window, $(card, '.foot [data-action="clear-filters"]'));
    assert.equal(labels(card).length, 5);
    assert.equal($(card, 'select[data-role="vendor"]').value, "");
  });
});

describe("sorting", () => {
  test("column headers sort, and a second click reverses; blanks stay last", async (t) => {
    const window = loadCard(t);
    const card = mount(window, { layout: "table", columns: ["ip", "vendor"] });

    await click(window, $(card, '.th[data-sort="vendor"]'));
    assert.deepEqual(labels(card), ["living-room-tv", "Brother Printer", "nas", "router", "Unknown device"]);

    await click(window, $(card, '.th[data-sort="vendor"]'));
    assert.deepEqual(labels(card), ["router", "nas", "Brother Printer", "living-room-tv", "Unknown device"]);
    assert.match($(card, '.th[data-sort="vendor"]').getAttribute("aria-label"), /sorted descending/);
  });

  test("the sort menu and direction button work in the list layout", async (t) => {
    const window = loadCard(t);
    const card = mount(window, { layout: "list" });

    await choose(window, card, "sort", "name");
    assert.deepEqual(labels(card), ["Brother Printer", "living-room-tv", "nas", "router", "Unknown device"]);

    await click(window, $(card, '[data-action="sort-dir"]'));
    assert.deepEqual(labels(card), ["Unknown device", "router", "nas", "living-room-tv", "Brother Printer"]);
  });

  test("sort_by and sort_order set the initial order", (t) => {
    const window = loadCard(t);
    const card = mount(window, { sort_by: "ip", sort_order: "desc" });
    assert.deepEqual(ips(card), ["192.168.1.100", "192.168.1.23", "192.168.1.10", "192.168.1.9", "192.168.1.1"]);
  });
});

describe("device details", () => {
  test("expand and collapse in place", async (t) => {
    const window = loadCard(t);
    const card = mount(window);
    const row = deviceRow(card, "192.168.1.10");

    await click(window, row.querySelector(".row"));
    assert.equal(row.querySelector(".row").getAttribute("aria-expanded"), "true");
    const facts = Object.fromEntries(
      [...row.querySelectorAll(".fact")].map((fact) => [text(fact.querySelector("dt")), text(fact.querySelector("dd"))]),
    );
    assert.deepEqual(facts, {
      Name: "Brother Printer",
      Description: "Brother",
      "IP address": "192.168.1.10",
      "MAC address": "BC:14:14:F1:81:1B",
      Hostname: "No reverse DNS",
      Vendor: "Brother Industries",
    });
    assert.equal(row.querySelector(".actions a").getAttribute("href"), "http://192.168.1.10");
    // Mapped devices need no mapping suggestion.
    assert.equal(row.querySelector(".snippet"), null);

    await click(window, row.querySelector(".row"));
    assert.equal(row.querySelector(".details"), null);
  });

  test("unknown devices get a mapping line in the format the integration accepts", async (t) => {
    const window = loadCard(t);
    const card = mount(window);

    const router = deviceRow(card, "192.168.1.1");
    await click(window, router.querySelector(".row"));
    assert.equal(text(router.querySelector(".snippet code")), "10:27:f5:00:00:01;router;TP-Link Technologies");

    const phone = deviceRow(card, "192.168.1.23");
    await click(window, phone.querySelector(".row"));
    assert.equal(text(phone.querySelector(".snippet code")), "da:a1:19:00:00:23;New device;Unknown");
    assert.match(text(phone.querySelector(".note")), /private \(randomized\) MAC address/);
  });

  test("expanded rows stay expanded when a new scan arrives", async (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    const card = mount(window, {}, hass);
    await click(window, deviceRow(card, "192.168.1.10").querySelector(".row"));

    card.hass = { ...hass, states: { [ENTITY_ID]: scannerState() } };
    assert.ok(deviceRow(card, "192.168.1.10").querySelector(".details"));
  });
});

describe("Scan now", () => {
  test("asks Home Assistant to update the sensor and shows progress until it finishes", async (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    let finish;
    hass.callService = (domain, service, data) => {
      hass.serviceCalls.push([domain, service, { ...data }]);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const card = mount(window, {}, hass);
    const button = $(card, ".scan");

    button.click();
    assert.deepEqual(hass.serviceCalls, [["homeassistant", "update_entity", { entity_id: ENTITY_ID }]]);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(text($(card, ".subtitle")), "Scanning the network…");

    button.click();
    assert.equal(hass.serviceCalls.length, 1, "a second click started another scan");

    finish();
    await settle();
    assert.equal(button.getAttribute("aria-busy"), "false");
    assert.equal(text($(card, ".subtitle")), "192.168.1.0/24 · Scanned 3 minutes ago");
  });

  test("reports a failed scan", async (t) => {
    const window = loadCard(t);
    const hass = makeHass();
    hass.callService = async () => {
      throw new Error("Service call timed out");
    };
    const card = mount(window, {}, hass);
    const toasts = [];
    card.addEventListener("hass-notification", (ev) => toasts.push(ev.detail.message));

    $(card, ".scan").click();
    await settle();
    assert.deepEqual(toasts, ["Scan failed: Service call timed out"]);
    assert.equal($(card, ".scan").getAttribute("aria-busy"), "false");
  });
});

// ---------------------------------------------------------------- editor

describe("visual editor", () => {
  function mountEditor(window, config) {
    const editor = window.document.createElement("network-scanner-card-editor");
    editor.setConfig({ type: "custom:network-scanner-card", ...config });
    editor.hass = makeHass();
    window.document.body.appendChild(editor);
    return editor;
  }

  test("shows defaults for options the config leaves out", (t) => {
    const window = loadCard(t);
    const form = mountEditor(window, { title: "LAN" }).querySelector("ha-form");
    assert.deepEqual(plain(form.data), {
      type: "custom:network-scanner-card",
      title: "LAN",
      columns: ["ip", "mac", "vendor"],
      sort_by: "ip",
      sort_order: "asc",
      layout: "auto",
      show_stats: true,
      show_toolbar: true,
      show_scan_button: true,
    });
    assert.equal(form.computeLabel({ name: "show_stats" }), "Show summary tiles");
  });

  test("saves only what differs from the defaults", (t) => {
    const window = loadCard(t);
    const editor = mountEditor(window, {});
    const saved = [];
    editor.addEventListener("config-changed", (ev) => saved.push(plain(ev.detail.config)));

    editor.querySelector("ha-form").dispatchEvent(
      new window.CustomEvent("value-changed", {
        detail: {
          value: {
            type: "custom:network-scanner-card",
            title: "",
            columns: ["ip", "mac", "vendor"],
            sort_by: "name",
            show_stats: true,
            max_height: "480px",
          },
        },
      }),
    );
    assert.deepEqual(saved, [{ type: "custom:network-scanner-card", sort_by: "name", max_height: "480px" }]);
  });
});
