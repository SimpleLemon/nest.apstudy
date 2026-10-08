import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule } from "./helpers/chat-modules.mjs";

const { createChatStore } = await importChatModule("store.js");
const { createChatMessageLoading } = await importChatModule("message-loading.js");
const { createChatMessagesDom } = await importChatModule("messages-dom.js");
const room = { type: "channel", id: "general" };
const roomKey = (value) => value ? `${value.type}:${value.id}` : "";
const noop = () => {};
const message = (index) => ({ id: String(index), created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });

function fixture({ payload = null, response = { messages: [], has_more: false } } = {}) {
  const state = { activeRoom: room, roomCache: new Map(), loadingMessages: false, prefetchingRooms: new Set() };
  const writes = [];
  const requests = [];
  const store = createChatStore({
    state, identity: { roomKey, currentUserId: () => "user" },
    scheduler: { scheduleTransientTimeout: noop },
    persistentCache: { read: async () => payload, write: async (...args) => writes.push(args) },
  });
  const loading = createChatMessageLoading({
    readState: { markRoomRead: noop },
    onRoomDetails: noop,

    state, store, els: { messages: { scrollTop: 0, scrollHeight: 100 } }, identity: { roomKey },
    scheduler: { schedulePersistentBootstrapSave: noop },
    rooms: { activeChannel: () => null,
      channelIsPending: () => false,
      renderHeader: noop,
      updateRoomLists: noop },
    feedback: { setStatus: noop },
    view: { isNearBottom: () => true, syncMessagesToDom: noop, restoreScroll: noop,
      stickToBottom: noop, renderMessageLoader: noop },
    fetchJson: async (url) => { requests.push(url); return response; },
  });
  return { state, store, loading, writes, requests };
}

for (const delta of [{ after: message(1).created_at }, { after_message_id: "1" }]) {
  for (const hasMore of [false, true]) {
    test(`active delta ${Object.keys(delta)[0]} preserves history availability ${hasMore}`, async () => {
      const f = fixture({ response: { messages: [message(2)], has_more: false } });
      f.store.replaceRoomMessages(room, [message(1)], { hasMore });
      await f.loading.loadMessages({ ...delta, quiet: true });
      assert.equal(f.store.cacheFor(room).hasMore, hasMore);
      assert.deepEqual(f.store.cacheFor(room).messages.map((row) => row.id), ["1", "2"]);
      assert.equal(f.store.cacheFor(room).latestMessageId, "2");
    });
  }
}

test("initial and before pages update backward availability from the server", async () => {
  const f = fixture({ response: { messages: [message(1)], has_more: false } });
  f.store.replaceRoomMessages(room, [message(2)], { hasMore: true });
  await f.loading.loadMessages({ before: message(2).created_at });
  assert.equal(f.store.cacheFor(room).hasMore, false);
  assert.deepEqual(f.store.cacheFor(room).messages.map((row) => row.id), ["1", "2"]);
  f.store.cacheFor(room).hasMore = true;
  await f.loading.loadMessages();
  assert.equal(f.store.cacheFor(room).hasMore, false);
  assert.deepEqual(f.store.cacheFor(room).messages.map((row) => row.id), ["1"]);
});

test("an ID-only history page merges the room snapshot and updates older availability", async () => {
  const f = fixture({ response: { messages: [message(1)], has_more: false } });
  f.store.replaceRoomMessages(room, [message(2)], { hasMore: true });
  await f.loading.loadMessages({ before_message_id: "2", quiet: true });
  assert.equal(f.store.cacheFor(room).hasMore, false);
  assert.deepEqual(f.store.cacheFor(room).messages.map((row) => row.id), ["1", "2"]);
  assert.equal(new URL(f.requests[0], "http://localhost").searchParams.get("before_message_id"), "2");
});

for (const hasMore of [false, true]) {
  test(`prefetched disk history keeps availability ${hasMore} across an empty delta`, async () => {
    const f = fixture({ payload: { room, messages: [message(1)], hasMore } });
    await f.loading.prefetchRoomMessages(room);
    assert.equal(f.store.cacheFor(room).hasMore, hasMore);
    assert.equal(f.store.cacheFor(room).stale, false);
    assert.deepEqual(f.store.cacheFor(room).messages.map((row) => row.id), ["1"]);
    assert.match(f.requests[0], /after=/);
    assert.match(f.requests[0], /after_message_id=1/);
  });
}

test("prefetching an uncached room sets history availability from its initial page", async () => {
  const f = fixture({ response: { messages: [message(1)], has_more: true } });
  await f.loading.prefetchRoomMessages(room);
  assert.equal(f.store.cacheFor(room).hasMore, true);
  assert.equal(f.requests[0], "/api/chat/channels/general/messages");
});

test("persistent truncation reopens history and hydration preserves its cursor", async () => {
  const f = fixture();
  const rows = Array.from({ length: 55 }, (_, index) => message(index));
  f.store.replaceRoomMessages(room, rows, { hasMore: false });
  await f.store.persistRoomCache(room);
  const [, payload] = f.writes[0];
  assert.equal(payload.messages.length, 50);
  assert.equal(payload.messages[0].id, "5");
  assert.equal(payload.hasMore, true);
  assert.equal(f.store.cacheFor(room).hasMore, false, "The full live snapshot still contains all history");
  const hydrated = fixture({ payload });
  assert.equal(await hydrated.store.hydrateRoomFromPersistentCache(room), true);
  const cache = hydrated.store.cacheFor(room);
  assert.equal(cache.hasMore, true);
  assert.equal(cache.oldestCursor, message(5).created_at);
  assert.equal(cache.latestMessageId, "54");
  await hydrated.loading.prefetchRoomMessages(room);
  assert.equal(cache.hasMore, true);
});

test("hydration itself marks oversized legacy payloads as having older history", async () => {
  const f = fixture({ payload: { room, messages: Array.from({ length: 51 }, (_, index) => message(index)), hasMore: false } });
  await f.store.hydrateRoomFromPersistentCache(room);
  assert.equal(f.store.cacheFor(room).messages.length, 50);
  assert.equal(f.store.cacheFor(room).hasMore, true);
});

test("untrimmed complete history stays complete across persistence and hydration", async () => {
  const f = fixture();
  f.store.replaceRoomMessages(room, Array.from({ length: 50 }, (_, index) => message(index)), { hasMore: false });
  await f.store.persistRoomCache(room);
  const payload = f.writes[0][1];
  assert.equal(payload.hasMore, false);
  const hydrated = fixture({ payload });
  await hydrated.store.hydrateRoomFromPersistentCache(room);
  assert.equal(hydrated.store.cacheFor(room).hasMore, false);
});

test("scrolling a hydrated tied cutoff sends its timestamp and oldest ID through the real loader", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { clearTimeout: noop, setTimeout: noop };
  try {
    const timestamp = "2026-01-01T00:00:00Z";
    const rows = [
      { id: "cut-2", created_at: timestamp }, { id: "cut-1", created_at: timestamp },
      ...Array.from({ length: 49 }, (_, index) => ({ id: `new-${index}`, created_at: message(index + 1).created_at })),
    ];
    const live = fixture();
    live.store.replaceRoomMessages(room, rows, { hasMore: false });
    await live.store.persistRoomCache(room);
    const f = fixture({ payload: live.writes[0][1] });
    await f.store.hydrateRoomFromPersistentCache(room);
    const cache = f.store.cacheFor(room);
    assert.equal(cache.hasMore, true);
    assert.equal(cache.oldestCursor, timestamp);
    assert.equal(cache.oldestMessageId, "cut-2");
    assert.ok(!cache.messages.some((row) => row.id === "cut-1"));
    const events = new Map();
    const pane = { scrollTop: 0, scrollHeight: 100, addEventListener: (name, callback) => events.set(name, callback) };
    const dom = createChatMessagesDom({
      root: { dataset: {} }, state: f.state, els: { messages: pane }, extensions: {}, config: {},
      store: f.store, loading: f.loading, rooms: { activeChannel: () => null }, view: { isNearBottom: () => true },
    });
    dom.bindPaneEvents();
    events.get("scroll")();
    await new Promise((resolve) => setImmediate(resolve));
    const url = new URL(f.requests[0], "http://localhost");
    assert.equal(url.searchParams.get("before"), timestamp);
    assert.equal(url.searchParams.get("before_message_id"), "cut-2");
    assert.equal(url.searchParams.has("after"), false);
  } finally {
    globalThis.window = previousWindow;
  }
});
