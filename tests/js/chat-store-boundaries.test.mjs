import assert from "node:assert/strict";
import test from "node:test";
import { createTestChatStore, importChatModule, installChatHttpStub } from "./helpers/chat-modules.mjs";

const { createChatStore } = await importChatModule("store.js");
const { createChatMessagesDom } = await importChatModule("messages-dom.js");
const { createChatLifecycle } = await importChatModule("lifecycle.js");
const room = { type: "channel", id: "general" };
const roomKey = (value) => value ? `${value.type}:${value.id}` : "";
const message = (id, minute = 0) => ({ id, created_at: `2026-08-09T12:${String(minute).padStart(2, "0")}:00Z`, content: id, author_name: "Test" });
const noop = () => {};

test("store changes own cursor and persistence updates and preserve published message snapshots", async () => {
  const queued = [];
  const writes = [];
  const state = { activeRoom: room, roomCache: new Map() };
  const store = createChatStore({
    state, identity: { roomKey, currentUserId: () => "user-1" },
    scheduler: { scheduleTransientTimeout: (callback) => queued.push(callback) },
    persistentCache: { read: async () => null, write: async (...args) => writes.push(args) },
  });
  const initial = store.replaceRoomMessages(room, [message("newer", 2), message("older", 1)], { hasMore: true });
  const merged = store.mergeRoomMessages(room, [message("newer", 2), message("latest", 3), message("latest", 3)]);
  assert.deepEqual(merged.incoming.map((row) => row.id), ["latest"]);
  assert.equal(merged.cache.hasMore, true);
  assert.equal(merged.cache.oldestCursor, message("older", 1).created_at);
  assert.equal(merged.cache.latestMessageId, "latest");
  const removed = store.removeMessageFromCaches("latest");
  assert.equal(merged.cache.latestMessageId, "newer");
  const removedSnapshot = merged.cache.messages;
  store.restoreMessagesToCaches(removed);
  store.restoreMessagesToCaches(removed);
  assert.equal(merged.cache.latestMessageId, "latest");
  assert.deepEqual(initial.messages.map((row) => row.id), ["older", "newer"]);
  assert.deepEqual(removedSnapshot.map((row) => row.id), ["older", "newer"]);
  store.replaceRoomMessages(room, [message("replacement")], { hasMore: false });
  store.saveRoomScroll(room, 73);
  queued.forEach((callback) => callback());
  await Promise.resolve();
  assert.equal(writes.length, 6);
  for (const [key, payload] of writes) {
    assert.equal(key, "v2:user:user-1:room:channel:general");
    assert.deepEqual(payload.messages.map((row) => row.id), ["replacement"]);
    assert.equal(payload.scrollTop, 73);
    assert.equal(payload.hasMore, false);
  }
});

test("delete and undo callers render the active snapshot while restoring every cached occurrence", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const state = { activeRoom: room, user: { id: "user-1" } };
  const store = createTestChatStore(state);
  const otherRoom = { type: "thread", id: "other" };
  const deleted = { ...message("deleted"), can_delete: true };
  store.replaceRoomMessages(room, [deleted]);
  store.replaceRoomMessages(otherRoom, [deleted]);
  let undo;
  const requests = [];
  globalThis.window.APStudyConfirm = { request: async () => true };
  globalThis.window.APStudyUndo = { stage: (options) => { undo = options; } };
  const events = new Map();
  const pane = {
    innerHTML: "",
    querySelector: () => null,
    addEventListener: (event, callback) => events.set(event, callback),
  };
  const view = createChatMessagesDom({
    readState: { markRoomRead: noop },

    root: { dataset: {} }, state, els: { messages: pane }, extensions: {},
    config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements", GRAMMARLY_DISABLED_ATTRS: "" },
    store, identity: { roomKey }, scheduler: { scheduleTransientFrame: noop },
    rooms: { activeChannel: () => null },
    view: { isNearBottom: () => true }, feedback: { setStatus: noop },
    fetchJson: async (...args) => requests.push(args),
  });
  try {
    view.renderMessages(store.cacheFor(room).messages);
    view.bindPaneEvents();
    assert.match(pane.innerHTML, /data-delete-message="deleted"/);
    events.get("click")({ target: { closest: (selector) => selector === "[data-delete-message]" ? { dataset: { deleteMessage: "deleted" } } : null } });
    await Promise.resolve();
    assert.ok(undo);
    assert.doesNotMatch(pane.innerHTML, /data-message-id/);
    assert.match(pane.innerHTML, /No messages yet/);
    assert.equal(store.cacheFor(otherRoom).messages.length, 0);
    undo.restore();
    assert.match(pane.innerHTML, /data-message-id="deleted"/);
    assert.equal(store.cacheFor(otherRoom).latestMessageId, "deleted");
    assert.deepEqual(requests, []);
    await undo.commit({ reason: "pagehide" });
    assert.equal(requests.length, 1);
    const [url, { signal, ...options }] = requests[0];
    assert.equal(url, "/api/chat/messages/deleted");
    assert.deepEqual(options, { method: "DELETE", keepalive: true });
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("chat HTTP delegates payloads and failures to the shared service with the prepared selection signal", async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const calls = [];
  const payload = { messages: [message("server")] };
  const failure = new Error("Shared HTTP failure");
  globalThis.window = {};
  globalThis.fetch = () => { throw new Error("Chat cannot decode its own response"); };
  installChatHttpStub(globalThis.window, async (url, options) => {
    calls.push({ url, options });
    if (url === "/failure") throw failure;
    return payload;
  });
  const lifecycle = createChatLifecycle({});
  const controller = new AbortController();
  try {
    assert.equal(await lifecycle.fetchJson("/messages", { signal: controller.signal, headers: { Accept: "application/json" } }), payload);
    assert.equal(calls[0].options.signal, controller.signal);
    assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
    await assert.rejects(lifecycle.fetchJson("/failure"), (error) => error === failure);
    assert.ok(calls[1].options.signal instanceof AbortSignal);
    assert.equal(calls[1].options.signal.aborted, false);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
