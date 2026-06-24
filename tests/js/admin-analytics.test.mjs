import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function runBrowserScript(relativePath, extra = {}) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const sandbox = {
    URL,
    Intl,
    Date,
    Number,
    Math,
    String,
    Array,
    Set,
    window: {
      location: { origin: "https://example.test" },
      ...extra.window,
    },
    document: {
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      ...extra.document,
    },
    ...extra.globals,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(source, sandbox, { filename: relativePath });
  return sandbox.window;
}

test("admin analytics helpers normalize range, timezone URLs, and series data", async () => {
  const window = await runBrowserScript("static/js/admin-analytics.js", {
    window: {
      Intl,
    },
  });

  assert.equal(window.AdminAnalytics.normalizeRange("bogus"), "30d");
  assert.equal(window.AdminAnalytics.normalizeRange("7d"), "7d");
  assert.equal(
    window.AdminAnalytics.buildAnalyticsUrl("24h", "America/Phoenix"),
    "https://example.test/admin/analytics/data?range=24h&tz=America%2FPhoenix",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(window.AdminAnalytics.normalizeSeries([{ key: "a", label: "A", value: "2" }, { key: "b" }]))), [
    { key: "a", label: "A", value: 2 },
    { key: "b", label: "b", value: 0 },
  ]);
});

test("admin analytics charts use nice axes, hover details, and vertical category bars", async () => {
  const window = await runBrowserScript("static/js/admin-analytics.js", {
    window: {
      Intl,
    },
  });

  const axis = window.AdminAnalytics.niceAxis(87);
  assert.ok(axis.max > 87);
  assert.equal(String(axis.max).endsWith("0"), true);
  assert.equal(axis.ticks.length, 6);

  const line = window.AdminAnalytics.renderLineChart([
    { label: "Jun 1", value: 14 },
    { label: "Jun 2", value: 87 },
  ]);
  assert.match(line, /admin-analytics-tooltip/);
  assert.match(line, /admin-analytics-grid-line/);
  assert.match(line, /role="listitem"/);

  const bars = window.AdminAnalytics.renderVerticalBarChart([
    { label: "Google", value: 4 },
    { label: "Emory (Main/Oxford)", value: 2 },
  ]);
  assert.match(bars, /admin-analytics-bar-column/);
  assert.match(bars, /admin-analytics-tooltip/);
  assert.doesNotMatch(bars, /admin-analytics-bars/);
});

test("admin analytics multi-line charts render dynamic series colors and interval growth", async () => {
  const window = await runBrowserScript("static/js/admin-analytics.js", {
    window: {
      Intl,
    },
  });

  const chart = window.AdminAnalytics.renderMultiLineChart([
    {
      key: "google",
      label: "Google",
      points: [{ label: "May 1", value: 2 }, { label: "May 2", value: 5 }],
    },
    {
      key: "discord",
      label: "Discord",
      points: [{ label: "May 1", value: 1 }, { label: "May 2", value: 2 }],
    },
  ]);

  assert.match(chart, /admin-analytics-series-line/);
  assert.match(chart, /admin-analytics-legend-item/);
  assert.match(chart, /\+3/);
  assert.match(chart, /\+1/);
  assert.match(chart, /hsl\(/);
});

test("admin analytics main card switches to selected metric graph", async () => {
  const window = await runBrowserScript("static/js/admin-analytics.js", {
    window: {
      Intl,
    },
  });

  const cards = new Map();
  const nodes = {
    main: {
      innerHTML: "",
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
    },
    title: { textContent: "" },
    description: { textContent: "" },
  };
  const tabs = ["totalUsers", "activeUsers", "oauth", "uniType"].map((metric) => ({
    dataset: { analyticsMetric: metric },
    active: false,
    attrs: {},
    classList: {
      toggle(name, selected) {
        if (name === "is-active") this.owner.active = selected;
      },
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  }));
  tabs.forEach((tab) => {
    tab.classList.owner = tab;
  });
  const root = {
    dataset: { activeMetric: "oauth" },
    querySelector(selector) {
      const card = selector.match(/\[data-analytics-card="([^"]+)"\]/)?.[1];
      if (card) {
        if (!cards.has(card)) cards.set(card, { textContent: "" });
        return cards.get(card);
      }
      if (selector === '[data-chart="main"]') return nodes.main;
      if (selector === '[data-analytics-main-title]') return nodes.title;
      if (selector === '[data-analytics-main-description]') return nodes.description;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-analytics-metric]" ? tabs : [];
    },
  };

  window.AdminAnalytics.renderDashboard(root, {
    cards: { totalUsers: 8, activeUsers: 3, pageViews: 0, onboardingRate: 0 },
    series: {
      totalUsers: [],
      activeUsers: [],
      pageViews: [],
      oauth: [
        { key: "google", label: "Google", points: [{ label: "May 1", value: 1 }, { label: "May 2", value: 3 }] },
        { key: "discord", label: "Discord", points: [{ label: "May 1", value: 0 }, { label: "May 2", value: 2 }] },
      ],
      uniType: [],
    },
    breakdowns: {
      oauth: [{ label: "Google", value: 5 }, { label: "Discord", value: 3 }],
      uniType: [],
    },
    engagement: {},
    ga4: { configured: false },
  });

  assert.equal(nodes.title.textContent, "OAuth");
  assert.match(nodes.main.innerHTML, /admin-analytics-multiline/);
  assert.match(nodes.main.innerHTML, /admin-analytics-legend/);
  assert.match(nodes.main.innerHTML, /\+2/);
  assert.equal(cards.get("oauth").textContent, "4");
  assert.equal(tabs.find((tab) => tab.dataset.analyticsMetric === "oauth").attrs["aria-selected"], "true");
});

test("admin analytics range dropdown opens, selects, and closes on outside click", async () => {
  const documentListeners = new Map();
  const window = await runBrowserScript("static/js/admin-analytics.js", {
    document: {
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, handler) => {
        const handlers = documentListeners.get(type) || [];
        handlers.push(handler);
        documentListeners.set(type, handlers);
      },
      removeEventListener: (type, handler) => {
        const handlers = (documentListeners.get(type) || []).filter((item) => item !== handler);
        documentListeners.set(type, handlers);
      },
    },
    window: {
      Intl,
      location: { origin: "https://example.test" },
    },
  });

  const menu = { hidden: true };
  const label = { textContent: "Last 30 days" };
  const trigger = {
    attrs: {},
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
  const options = ["30d", "7d"].map((range) => ({
    dataset: { analyticsRange: range },
    textContent: range === "30d" ? "Last 30 days" : "Last 7 days",
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    attrs: {},
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  }));
  const dropdown = {
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    contains(target) {
      return target === dropdown || target === trigger || target === menu || options.includes(target);
    },
    querySelector(selector) {
      if (selector === "[data-analytics-range-trigger]") return trigger;
      if (selector === "[data-analytics-range-menu]") return menu;
      if (selector === "[data-analytics-range-label]") return label;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-analytics-range]" ? options : [];
    },
  };
  const root = {
    querySelector(selector) {
      return selector === "[data-analytics-range-dropdown]" ? dropdown : null;
    },
  };

  const changes = [];
  const controller = window.AdminAnalytics.initAnalyticsRangeDropdown(root, {
    defaultRange: "30d",
    onChange: (range) => changes.push(range),
  });

  assert.equal(controller.getActiveRange(), "30d");
  controller.setOpen(true);
  assert.equal(controller.isOpen(), true);
  assert.equal(menu.hidden, false);
  assert.equal(trigger.attrs["aria-expanded"], "true");

  controller.selectRange("7d");
  assert.equal(controller.isOpen(), false);
  assert.equal(menu.hidden, true);
  assert.equal(controller.getActiveRange(), "7d");
  assert.equal(label.textContent, "Last 7 days");
  assert.deepEqual(changes, ["7d"]);

  controller.setOpen(true);
  documentListeners.get("click")?.[0]?.({ target: {} });
  assert.equal(controller.isOpen(), false);

  controller.setOpen(true);
  documentListeners.get("keydown")?.[0]?.({ key: "Escape" });
  assert.equal(controller.isOpen(), false);

  controller.destroy();
});

test("admin timezone helper formats timestamps and exposes browser timezone", async () => {
  const window = await runBrowserScript("static/js/admin-timezone.js", {
    window: {
      Intl,
    },
  });

  assert.equal(typeof window.AdminTimezone.adminTimezone(), "string");
  const formatted = window.AdminTimezone.formatAdminTimestamp("2026-05-25T01:00:00Z", {
    timeZone: "America/Phoenix",
  });
  assert.match(formatted, /May|5\/24|5\/25/);
  assert.equal(window.AdminTimezone.formatAdminTimestamp(""), "--");
});
