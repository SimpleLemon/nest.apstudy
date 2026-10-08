import assert from "node:assert/strict";
import test from "node:test";
import { runAdminBrowserScript, runAdminBrowserModule } from "./helpers/admin-analytics.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (payload, ok = true) => ({ ok, status: ok ? 200 : 403, headers: { get: () => "application/json" }, json: async () => payload });

function element(dataset = {}) {
  const listeners = new Map();
  const selectors = new Map();
  const classes = new Set();
  return {
    dataset, listeners, selectors, attrs: {}, innerHTML: "", textContent: "", hidden: false,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains: (name) => classes.has(name),
    },
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => selectors.get(selector) || [],
    addEventListener(type, callback) { listeners.set(type, callback); },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    focus() {},
    click() { listeners.get("click")?.({ stopPropagation() {} }); },
  };
}

function dropdown(type) {
  const node = element(type ? { analyticsDetailRangeDropdown: type } : {});
  node.matches = () => true;
  node.contains = () => true;
  node.options = ["30d", "7d"].map((range) => Object.assign(element({ analyticsRange: range }), { textContent: range }));
  node.selectors.set("[data-analytics-range]", node.options);
  node.selectors.set("[data-analytics-range-label]", element());
  node.selectors.set("[data-analytics-range-menu]", element());
  return node;
}

async function runtime() {
  const shell = element({ defaultRange: "30d" });
  const mainRange = dropdown();
  const main = element();
  const totalCard = element();
  const notice = element();
  const tabs = ["totalUsers", "pageViews"].map((analyticsMetric) => element({ analyticsMetric }));
  const panels = {};
  for (const type of ["countries", "pages"]) {
    const panel = element();
    const range = dropdown(type);
    range.closest = () => panel;
    const list = element();
    const source = element();
    const map = element();
    panel.selectors.set(`[data-analytics-detail-list="${type}"]`, list);
    panel.selectors.set(type === "countries" ? "[data-analytics-ga-details-source]" : "[data-analytics-page-details-source]", source);
    panel.selectors.set("[data-analytics-country-map]", map);
    shell.selectors.set(`[data-analytics-detail-range-dropdown="${type}"]`, range);
    panels[type] = { panel, range, list, source, map };
  }
  shell.selectors.set("[data-analytics-range-dropdown]", mainRange);
  shell.selectors.set("[data-analytics-detail-range-dropdown]", Object.values(panels).map(({ range }) => range));
  shell.selectors.set("[data-analytics-metric]", tabs);
  shell.selectors.set('[data-chart="main"]', main);
  shell.selectors.set('[data-analytics-card="totalUsers"]', totalCard);
  shell.selectors.set("[data-analytics-notice]", notice);
  const requests = [];
  const window = await runAdminBrowserScript("static/js/admin-analytics.js", {
    document: { querySelector: () => shell },
    globals: {
      fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    },
  });
  assert.equal(window.AdminAnalytics, undefined, "startup must not publish a helper facade");
  return { shell, mainRange, main, totalCard, notice, tabs, panels, requests };
}

function payload(value) {
  return { cards: { totalUsers: value }, series: { totalUsers: [{ label: "Day", value }], pageViews: [{ label: "Views", value: value + 10 }] } };
}

test("admin main range ignores older success and failure while retaining selected metric", async () => {
  const fixture = await runtime();
  const { mainRange, requests, totalCard, notice, tabs, main } = fixture;
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.credentials, "same-origin");
  assert.equal(requests[2].options.headers.Accept, "application/json");
  mainRange.options[1].click();
  mainRange.options[0].click();
  assert.match(requests[3].url, /range=7d/);
  requests[4].resolve(response(payload(42)));
  await settle();
  assert.equal(totalCard.textContent, "42");
  assert.equal(notice.hidden, true);
  tabs[1].click();
  assert.equal(main.attrs["aria-label"], "Views analytics chart");
  assert.match(main.innerHTML, /52/);
  requests[2].resolve(response(payload(2)));
  requests[3].reject(new Error("Older range failed"));
  await settle();
  assert.equal(totalCard.textContent, "42");
  assert.equal(notice.hidden, true);
  assert.equal(main.attrs["aria-label"], "Views analytics chart");
});

test("admin detail ranges update independently and ignore older detail responses", async () => {
  const { requests, panels, notice } = await runtime();
  panels.countries.range.options[1].click();
  requests[3].resolve(response({ gaDetails: { countries: [{ countryId: "CA", label: "Canada", value: 8 }] }, sources: { traffic: { status: "ok", label: "Google Analytics" } } }));
  requests[1].resolve(response({ gaDetails: { pages: [{ path: "/", title: "Nest", value: 5 }] }, sources: { traffic: { status: "ok", label: "Google Analytics" } } }));
  await settle();
  assert.match(panels.countries.list.innerHTML, /Canada/);
  assert.match(panels.pages.list.innerHTML, /Landing Page/);
  requests[0].resolve(response({ gaDetails: { countries: [{ countryId: "US", label: "United States", value: 2 }] } }));
  await settle();
  assert.match(panels.countries.list.innerHTML, /Canada/);
  assert.doesNotMatch(panels.countries.list.innerHTML, /United States/);
  assert.equal(notice.textContent, "Loading analytics...");
});

test("admin main failures show the server error and details retain their own unavailable state", async () => {
  const { requests, panels, notice } = await runtime();
  requests[2].resolve(response({ error: "Analytics permission expired" }, false));
  requests[0].reject(new Error("Provider offline"));
  await settle();
  assert.equal(notice.textContent, "Analytics permission expired");
  assert.equal(notice.classList.contains("is-error"), true);
  assert.equal(panels.countries.source.textContent, "Source: Google Analytics unavailable");
  assert.match(panels.countries.list.innerHTML, /No data yet/);
  assert.equal(panels.pages.list.innerHTML, "");
});

test("admin malformed successful JSON preserves rendered analytics and reports detail failure", async () => {
  const { requests, panels, notice, totalCard, mainRange } = await runtime();
  requests[2].resolve(response(payload(42)));
  await settle();
  mainRange.options[1].click();
  const malformed = () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => { throw new SyntaxError("Login HTML"); } });
  requests[3].resolve(malformed());
  requests[0].resolve(malformed());
  await settle();
  assert.equal(totalCard.textContent, "42");
  assert.equal(notice.textContent, "Invalid JSON response.");
  assert.equal(notice.classList.contains("is-error"), true);
  assert.equal(panels.countries.source.textContent, "Source: Google Analytics unavailable");
});

test("admin GeoChart loads once, queues data, and redraws current data for theme changes", async () => {
  let loaded;
  let observe;
  let mutation;
  let dark = false;
  const loads = [];
  const draws = [];
  const dashboard = await runAdminBrowserModule("static/js/admin-analytics-dashboard.js", {
    document: { documentElement: { classList: { contains: () => dark } } },
    globals: { MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe(root, options) { observe = { root, options }; }
    } },
    window: { google: {
      charts: {
        load: (...args) => loads.push(args),
        setOnLoadCallback: (callback) => { loaded = callback; },
      },
      visualization: {
        arrayToDataTable: (table) => table,
        GeoChart: class { draw(data, options) { draws.push({ data, options }); } },
      },
    } },
  });
  const panel = element();
  panel.selectors.set("[data-analytics-country-map]", element());
  const render = (countryId, value) => dashboard.renderGaDetailPanel(panel, { gaDetails: { countries: [{ countryId, value }] } }, "countries");
  render("US", 2);
  render("CA", 4);
  assert.equal(loads.length, 1);
  assert.equal(draws.length, 0);
  loaded();
  assert.equal(draws.length, 2);
  assert.equal(draws[1].data[1][0], "CA");
  assert.deepEqual(Array.from(observe.options.attributeFilter), ["class", "data-theme"]);
  dark = true;
  mutation();
  assert.equal(draws.length, 3);
  assert.equal(draws[2].data[1][0], "CA");
  assert.equal(draws[2].options.datalessRegionColor, "#2a2d35");
});
