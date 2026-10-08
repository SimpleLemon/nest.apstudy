import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../static/js/chat/cache.js", import.meta.url), "utf8");
const cache = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test("chat cache deduplicates, orders, and limits persisted messages", () => {
  const messages = Array.from({ length: 55 }, (_, index) => ({
    id: String(index),
    created_at: new Date(2026, 0, 1, 0, index).toISOString(),
  })).reverse();
  const trimmed = cache.trimMessagesForPersistentCache(messages);
  assert.equal(trimmed.length, 50);
  assert.equal(trimmed[0].id, "5");

  const merged = cache.mergeMessages(
    [{ id: "a", created_at: "2026-01-01T00:00:00Z", text: "old" }],
    [{ id: "a", created_at: "2026-01-01T00:00:00Z", text: "new" }, { id: "b", created_at: "2026-01-02T00:00:00Z" }],
  );
  assert.deepEqual(merged.map(({ id, text }) => ({ id, text })), [
    { id: "a", text: "new" },
    { id: "b", text: undefined },
  ]);
});

test("chat cache expires delete permission and maintains delta cursors", () => {
  const expired = cache.normalizeCachedMessage({
    id: "expired",
    can_delete: true,
    delete_expires_at: "2026-01-01T00:00:00Z",
  }, Date.parse("2026-01-02T00:00:00Z"));
  assert.equal(expired.can_delete, false);

  const roomCache = {
    messages: [
      { id: "later", created_at: "2026-01-02T00:00:00Z" },
      { id: "earlier", created_at: "2026-01-01T00:00:00Z" },
    ],
  };
  cache.updateCacheCursors(roomCache);
  assert.equal(roomCache.oldestCursor, "2026-01-01T00:00:00Z");
  assert.deepEqual(cache.deltaLoadParams(roomCache), {
    after: "2026-01-02T00:00:00Z",
    after_message_id: "later",
  });
});

function persistentWriteFixture() {
  const putRequest = {};
  const transaction = { objectStore: () => ({ put: () => putRequest }) };
  const database = { transaction: () => transaction };
  const openRequest = { result: database };
  const persistent = cache.createPersistentChatCache({ indexedDB: { open: () => openRequest } });
  return { persistent, openRequest, putRequest, transaction, database };
}

test("persistent writes wait for the IndexedDB transaction commit after put success", async () => {
  const fixture = persistentWriteFixture();
  let settled = false;
  const write = fixture.persistent.write("room", { messages: [] }).then(() => { settled = true; });
  fixture.openRequest.onsuccess();
  await Promise.resolve();
  fixture.putRequest.onsuccess?.();
  await Promise.resolve();
  assert.equal(settled, false, "A successful request is not a committed transaction");
  fixture.transaction.oncomplete();
  await write;
  assert.equal(settled, true);
});

test("a put followed by transaction abort finishes best-effort persistence once", async () => {
  const fixture = persistentWriteFixture();
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const write = fixture.persistent.write("room", { messages: [] });
    fixture.openRequest.onsuccess();
    await Promise.resolve();
    fixture.putRequest.onsuccess?.();
    fixture.transaction.error = new Error("quota exceeded");
    fixture.transaction.onerror();
    fixture.transaction.onabort();
    await write;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], fixture.transaction.error);
  } finally {
    console.warn = previousWarn;
  }
});

test("cache persistence tolerates synchronous transaction failure", async () => {
  const fixture = persistentWriteFixture();
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  fixture.database.transaction = () => { throw new Error("database closed"); };
  try {
    const write = fixture.persistent.write("room", { messages: [] });
    fixture.openRequest.onsuccess();
    await write;
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = previousWarn;
  }
});

test("unavailable IndexedDB remains optional for both cache reads and writes", async () => {
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const persistent = cache.createPersistentChatCache({
    indexedDB: { open() { throw new Error("storage denied"); } },
  });
  try {
    assert.equal(await persistent.read("bootstrap"), null);
    await persistent.write("room", { messages: [] });
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = previousWarn;
  }
});

test("cache reads tolerate closed databases and transaction aborts", async () => {
  const fixture = persistentWriteFixture();
  fixture.database.transaction = () => { throw new Error("database closed"); };
  const read = fixture.persistent.read("room");
  fixture.openRequest.onsuccess();
  assert.equal(await read, null);

  fixture.database.transaction = () => ({
    objectStore: () => ({ get: () => ({}) }),
    set onabort(callback) { queueMicrotask(callback); },
  });
  assert.equal(await fixture.persistent.read("room"), null);
});
