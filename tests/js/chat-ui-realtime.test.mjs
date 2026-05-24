import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFor(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("chat uses realtime event signals instead of message polling", async () => {
  const source = await sourceFor("static/js/chat.js");

  assert.doesNotMatch(source, /pollTimer/);
  assert.doesNotMatch(source, /setInterval\([^)]*loadMessages/s);
  assert.match(source, /Channel\?\.tablesdb/);
  assert.match(source, /\.table\(tableId\)\.row\(\)/);
  assert.match(source, /client\.subscribe/);
  assert.match(source, /handleRealtimePayload/);
});

test("chat keeps a page lifetime room cache with delta loading", async () => {
  const source = await sourceFor("static/js/chat.js");

  assert.match(source, /roomCache: new Map\(\)/);
  assert.match(source, /function cacheFor\(room\)/);
  assert.match(source, /latestCursor/);
  assert.match(source, /after: cache\.latestCursor/);
  assert.match(source, /removeMessageFromCaches/);
});

test("chat renders university pending state in the main panel only", async () => {
  const script = await sourceFor("static/js/chat.js");
  const template = await sourceFor("templates/chat.html");

  assert.match(script, /function renderApprovalNotice/);
  assert.match(script, /Waiting Admin Approval\./);
  assert.doesNotMatch(template, /chat-university-pending/);
  assert.doesNotMatch(template, /chat-pending-card/);
});

test("chat direct messages render presence dots and profile-only side pane", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");

  assert.match(script, /dmPresenceMarkup/);
  assert.match(script, /chat-presence-dot/);
  assert.doesNotMatch(script, /Direct message/);
  assert.match(styles, /chat-presence-dot\.is-online/);
  assert.match(styles, /chat-presence-dot\.is-offline/);
  assert.match(script, /is-dm-profile/);
});

test("chat active users pane has desktop collapse controls", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");
  const template = await sourceFor("templates/chat.html");

  assert.match(template, /data-collapse-members/);
  assert.match(template, /data-restore-members/);
  assert.match(script, /setMembersCollapsed/);
  assert.match(styles, /members-collapsed/);
});
