import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helperSource = await readFile(path.join(repoRoot, "static/js/admin-system.js"), "utf8");
const templateSource = await readFile(path.join(repoRoot, "templates/admin.html"), "utf8");

function loadAdminSystem() {
  const window = {
    fetch: async () => ({ ok: true }),
    setTimeout,
  };
  vm.runInNewContext(helperSource, { window, Date, Number, Promise, Object });
  return window.AdminSystem;
}

test("restart readiness waits for the backend delay before probing", async () => {
  const adminSystem = loadAdminSystem();
  const events = [];

  await adminSystem.waitForRestart({
    endpoint: "/admin/system-status",
    restartDelaySeconds: 2,
    delayImpl: async (milliseconds) => events.push(["delay", milliseconds]),
    fetchImpl: async (endpoint, options) => {
      events.push(["fetch", endpoint, options.cache, options.credentials]);
      return { ok: true };
    },
  });

  assert.deepEqual(events, [
    ["delay", 2000],
    ["fetch", "/admin/system-status", "no-store", "same-origin"],
  ]);
});

test("restart readiness retries failed probes and resolves only after success", async () => {
  const adminSystem = loadAdminSystem();
  const probes = [new Error("offline"), { ok: false }, { ok: true }];
  const delays = [];
  let now = 0;

  await adminSystem.waitForRestart({
    endpoint: "/admin/system-status",
    restartDelaySeconds: 0,
    timeoutMs: 10000,
    pollIntervalMs: 1000,
    nowImpl: () => now,
    delayImpl: async (milliseconds) => {
      delays.push(milliseconds);
      now += milliseconds;
    },
    fetchImpl: async () => {
      const result = probes.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  });

  assert.equal(probes.length, 0);
  assert.deepEqual(delays, [0, 1000, 1000]);
});

test("restart readiness times out with manual refresh guidance", async () => {
  const adminSystem = loadAdminSystem();
  let now = 0;

  await assert.rejects(
    adminSystem.waitForRestart({
      endpoint: "/admin/system-status",
      restartDelaySeconds: 1,
      timeoutMs: 2000,
      pollIntervalMs: 1000,
      nowImpl: () => now,
      delayImpl: async (milliseconds) => { now += milliseconds; },
      fetchImpl: async () => ({ ok: false }),
    }),
    /Refresh this page manually/,
  );
});

test("git pull handler reloads only for pulls that schedule a restart", () => {
  assert.match(templateSource, /if \(payload\.restart_scheduled\)/);
  assert.match(templateSource, /await window\.AdminSystem\.waitForRestart/);
  assert.match(templateSource, /window\.location\.reload\(\)/);
  assert.match(templateSource, /Git pull completed\. Output was written to the browser console\./);
  assert.match(templateSource, /finally \{[\s\S]*gitPullRequestPending = false/);
});
