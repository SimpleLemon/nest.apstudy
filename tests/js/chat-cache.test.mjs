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
