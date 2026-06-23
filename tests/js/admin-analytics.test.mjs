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
