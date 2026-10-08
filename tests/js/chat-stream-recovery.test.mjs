import assert from "node:assert/strict";
import test from "node:test";
import { createTestChatStore, importChatModule } from "./helpers/chat-modules.mjs";

const { createChatRealtime } = await importChatModule("realtime.js");
const { createChatMessageLoading } = await importChatModule("message-loading.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const event = (id, overrides = {}) => ({ $id: id, created_at: `2026-10-06T12:00:0${id}Z`,
  scope_type: "channel", scope_id: "general", event_type: "block_updated", ...overrides });

function streamFixture(bootstrap, fetchMessage = async () => ({ message: { id: "message-1", created_at: "2026-10-06T12:00:00Z" } }), loadJson = null) {
  const previous = { window: globalThis.window, document: globalThis.document, EventSource: globalThis.EventSource, warn: console.warn };
  const sources = [];
  const intervals = new Set();
  const timeouts = new Set();
  const warnings = [];
  const rendered = [];
  const statuses = [];
  const readMarks = [];
  const documentListeners = new Map();
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    emit(payload) { this.onmessage({ data: JSON.stringify(payload) }); }
  }
  globalThis.window = { EventSource: FakeEventSource,
    setInterval(callback) { intervals.add(callback); return callback; },
    clearInterval(callback) { intervals.delete(callback); },
    setTimeout(callback) { timeouts.add(callback); return callback; },
    clearTimeout(callback) { timeouts.delete(callback); } };
  globalThis.EventSource = FakeEventSource;
  globalThis.document = { visibilityState: "visible", addEventListener(name, callback) { documentListeners.set(name, callback); } };
  console.warn = (...args) => warnings.push(args);
  const state = { activeRoom: { type: "channel", id: "general" }, channels: [{ id: "general" }], threads: [], realtimeReady: false, loadingMessages: false };
  const lifecycle = { paused: false, disposed: false };
  const store = createTestChatStore(state);
  const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
  const markRoomRead = (room) => readMarks.push(room);
  const loading = loadJson ? createChatMessageLoading({
    readState: { markRoomRead },
    onRoomDetails: () => {},
    state, store,
    identity: { roomKey }, els: { messages: { scrollTop: 0, scrollHeight: 100 } },
    scheduler: { schedulePersistentBootstrapSave() {} },
    rooms: { activeChannel: () => state.channels[0],
      channelIsPending: () => false,
      renderHeader() {},
      updateRoomLists() {} },
    feedback: { setStatus: (...args) => statuses.push(args) },
    view: { isNearBottom: () => false, renderMessageLoader() {}, syncMessagesToDom() {}, restoreScroll() {}, stickToBottom() {} },
    fetchJson: loadJson }) : { loadMessages: async () => [] };
  const realtime = createChatRealtime({
    readState: { scheduleUnreadSummaryRefresh: () => {}, refreshChatSummary: async () => {}, markRoomRead },
    state, lifecycle, store, bootstrap: { bootstrap },
    config: { REALTIME_FALLBACK_MS: 3000, REALTIME_RECONNECT_MS: 1500 },
    identity: { roomKey },
    presence: { loadInitialPresences: async () => {}, refreshViewingPresence() {}, clearTypingPresence() {} },
    loading,
    feedback: { playChatSound: () => {} },
    rooms: { fetchThread: async () => null,
      threadExists: () => false },
    view: { renderIncomingMessages: (change) => rendered.push(change.messages), patchMessageInDom: () => false },
    fetchJson: fetchMessage });
  return { state, lifecycle, store, loading, realtime, sources, intervals, timeouts, warnings, rendered, statuses, readMarks,
    show() { documentListeners.get("visibilitychange")(); },
    reconnect() { const callback = [...timeouts][0]; timeouts.delete(callback); callback(); const source = sources.at(-1); source.onopen(); return source; },
    restore() { realtime.resetRealtimeConnection(); realtime.stopRealtimeFallback(); realtime.clearReconnectTimer();
      globalThis.window = previous.window; globalThis.document = previous.document; globalThis.EventSource = previous.EventSource; console.warn = previous.warn; } };
}

for (const eventType of ["message_created", "message_updated"]) {
  test(`${eventType} hydration failure remains replayable when both message fetch and real room loading fail`, async () => {
    const failure = new Error("Room messages unavailable");
    let offline = true;
    let bootstrapCalls = 0;
    const f = streamFixture(async () => { bootstrapCalls += 1; }, async () => { throw new Error("Message unavailable"); }, async () => {
      if (offline) throw failure;
      return { messages: [{ id: "message-1", created_at: "2026-10-06T12:00:02Z" }] };
    });
    try {
      f.store.replaceRoomMessages(f.state.activeRoom, [{ id: "cached-0", created_at: "2026-10-06T12:00:00Z" }]);
      await f.realtime.startRealtimeServices();
      const source = f.sources[0]; source.onopen(); source.emit(event("1")); await flush();
      const change = event("2", { event_type: eventType, message_id: "message-1" });
      source.emit(change); source.emit(event("3")); await flush();
      assert.equal(source.closed, true);
      assert.equal(f.warnings[0][2], failure);
      assert.equal(bootstrapCalls, 1, "Later events wait for failed hydration to replay");
      assert.equal(f.state.loadingMessages, false);
      assert.equal(f.store.cacheFor(f.state.activeRoom).stale, true);
      assert.deepEqual(f.store.cacheFor(f.state.activeRoom).messages.map((row) => row.id), ["cached-0"]);
      assert.deepEqual(f.statuses.at(-1), [failure.message, "error"]);
      const recovered = f.reconnect();
      assert.equal(new URL(recovered.url, "http://localhost").searchParams.get("after_id"), "1");
      offline = false;
      recovered.emit(change); recovered.emit(event("3")); await flush();
      assert.ok(f.store.cacheFor(f.state.activeRoom).messages.some((row) => row.id === "message-1"));
      assert.equal(bootstrapCalls, 2);
      recovered.onerror();
      assert.equal(new URL(f.reconnect().url, "http://localhost").searchParams.get("after_id"), "3");
    } finally { f.restore(); }
  });
}

test("visible-room read acknowledgements wait for a successful real message refresh", async () => {
  let offline = true;
  const f = streamFixture(async () => {}, undefined, async () => {
    if (offline) throw new Error("Offline");
    return { messages: [{ id: "message-1", created_at: "2026-10-06T12:00:02Z" }] };
  });
  try {
    f.store.replaceRoomMessages(f.state.activeRoom, [{ id: "cached-0", created_at: "2026-10-06T12:00:00Z" }]);
    f.realtime.bindEvents();
    f.show(); await flush();
    assert.equal(f.readMarks.length, 0);
    offline = false;
    f.show(); await flush();
    assert.equal(f.readMarks.length, 1);
    assert.equal(f.store.cacheFor(f.state.activeRoom).messages.at(-1).id, "message-1");
  } finally { f.restore(); }
});

test("stream bootstrap failure preserves the contiguous checkpoint and replays before later events", async () => {
  let rejectBootstrap;
  let bootstrapCalls = 0;
  const failure = new Error("Bootstrap temporarily offline");
  const f = streamFixture(() => {
    bootstrapCalls += 1;
    return bootstrapCalls === 2 ? new Promise((resolve, reject) => { rejectBootstrap = reject; }) : Promise.resolve();
  });
  try {
    await f.realtime.startRealtimeServices();
    const source = f.sources[0]; source.onopen();
    source.emit(event("1")); await flush();
    source.emit(event("2")); source.emit(event("3")); await flush();
    assert.equal(bootstrapCalls, 2, "Later events wait for the pending event");
    rejectBootstrap(failure); await flush();
    assert.equal(bootstrapCalls, 2, "The failed generation skips its queued event");
    assert.equal(source.closed, true);
    assert.equal(f.state.realtimeReady, false);
    assert.equal(f.intervals.size, 1);
    assert.equal(f.timeouts.size, 1);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0][2], failure);
    assert.deepEqual(f.warnings[0][1], { eventId: "2", eventType: "block_updated" });
    source.onerror(); assert.equal(f.timeouts.size, 1);
    const recovered = f.reconnect();
    const checkpoint = new URL(recovered.url, "http://localhost");
    assert.equal(checkpoint.searchParams.get("after_id"), "1");
    assert.equal(checkpoint.searchParams.get("since"), event("1").created_at);
    recovered.emit(event("1")); recovered.emit(event("2")); recovered.emit(event("3")); await flush();
    assert.equal(bootstrapCalls, 4, "Only the failed and later events replay");
    recovered.onerror();
    assert.equal(new URL(f.reconnect().url, "http://localhost").searchParams.get("after_id"), "3");
    assert.equal(f.intervals.size, 0);
  } finally { f.restore(); }
});

test("missing-thread failure leaves both event and message IDs replayable", async () => {
  let attempts = 0;
  const failure = new Error("Thread bootstrap offline");
  const f = streamFixture(async () => { if (++attempts === 1) throw failure; });
  try {
    f.state.activeRoom = { type: "thread", id: "new-thread" };
    const created = event("1", { event_type: "message_created", scope_type: "thread", scope_id: "new-thread", thread_id: "new-thread", message_id: "message-1" });
    await f.realtime.startRealtimeServices();
    const source = f.sources[0]; source.onopen(); source.emit(created); await flush();
    assert.equal(f.rendered.length, 0);
    assert.equal(f.warnings[0][2], failure);
    const recovered = f.reconnect();
    assert.equal(recovered.url, "/api/chat/events/stream");
    recovered.emit(created); recovered.emit(created); await flush();
    assert.equal(attempts, 2);
    assert.equal(f.rendered.length, 1);
    assert.equal(f.store.cacheFor(f.state.activeRoom).messages[0].id, "message-1");
  } finally { f.restore(); }
});

for (const mode of ["paused", "disposed", "replaced"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`${mode} connection cannot checkpoint or recover after pending bootstrap ${outcome}`, async () => {
      let settle;
      const f = streamFixture(() => new Promise((resolve, reject) => { settle = outcome === "resolve" ? resolve : reject; }));
      try {
        await f.realtime.startRealtimeServices();
        const source = f.sources[0]; source.onopen(); source.emit(event("1")); await flush();
        if (mode !== "replaced") f.lifecycle[mode] = true;
        f.realtime.resetRealtimeConnection();
        if (mode === "replaced") {
          await f.realtime.startRealtimeServices();
          f.sources.at(-1).onopen();
        }
        settle(outcome === "reject" ? new Error("Late failure") : undefined); await flush();
        assert.equal(f.timeouts.size, 0);
        assert.equal(f.intervals.size, 0);
        f.lifecycle.paused = false; f.lifecycle.disposed = false;
        await f.realtime.startRealtimeServices();
        assert.equal(f.sources.at(-1).url, "/api/chat/events/stream");
      } finally { f.restore(); }
    });
  }
}

test("a replaced stream cannot merge or render its pending message fetch", async () => {
  let complete;
  const f = streamFixture(async () => {}, () => new Promise((resolve) => { complete = resolve; }));
  try {
    await f.realtime.startRealtimeServices();
    const source = f.sources[0]; source.onopen();
    const created = event("1", { event_type: "message_created", message_id: "message-1" });
    source.emit(created); await flush();
    f.realtime.resetRealtimeConnection();
    await f.realtime.startRealtimeServices(); f.sources.at(-1).onopen();
    complete({ message: { id: "message-1" } }); await flush();
    assert.equal(f.store.cacheFor(f.state.activeRoom).messages.length, 0);
    assert.equal(f.rendered.length, 0);
    f.sources.at(-1).emit(created); await flush();
    complete({ message: { id: "message-1" } }); await flush();
    assert.equal(f.rendered.length, 1, "Replay remains eligible on the replacement connection");
  } finally { f.restore(); }
});
