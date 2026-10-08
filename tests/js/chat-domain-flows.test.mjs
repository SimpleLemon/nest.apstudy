import assert from "node:assert/strict";
import test from "node:test";
import { createTestChatStore, importChatModule, installChatHttpStub } from "./helpers/chat-modules.mjs";

const { createChatMessageLoading } = await importChatModule("message-loading.js");
const { createChatStore } = await importChatModule("store.js");
const { createChatLifecycle } = await importChatModule("lifecycle.js");
const { createChatComposer } = await importChatModule("composer.js");
const { createChatBootstrap } = await importChatModule("bootstrap.js");
const { createChatRooms } = await importChatModule("rooms.js");
const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
const noop = () => {};
const message = (id, created_at = "2026-08-09T12:00:00Z") => ({ id, content: id, created_at });

function loadingFixture(fetchJson, nearBottom = true) {
  const room = { type: "channel", id: "general" };
  const cache = { messages: [message("existing")], loaded: true, stale: false, scrollTop: 42 };
  const state = { activeRoom: room, loadingMessages: false, channels: [room], threads: [], prefetchingRooms: new Set() };
  const pane = { scrollTop: 42, scrollHeight: 200 };
  const renders = [];
  const reads = [];
  const metadata = [];
  const statuses = [];
  const loader = createChatMessageLoading({
    readState: { markRoomRead: (...args) => reads.push(args) },
    onRoomDetails: () => metadata.push("members"),

    state,
    els: { messages: pane },
    identity: { roomKey },
    store: createTestChatStore(state, cache),
    scheduler: { schedulePersistentBootstrapSave: noop, scheduleTransientTimeout: noop, scheduleIdle: noop },
    rooms: { activeChannel: () => room,
      channelIsPending: () => false,
      renderHeader: () => metadata.push("header"),
      updateChannel: () => metadata.push("channel"),
      updateThread: () => metadata.push("thread"),
      updateRoomLists: () => metadata.push("lists") },

    view: {
      isNearBottom: () => nearBottom,
      renderApprovalNotice: noop,
      renderMessageLoader: noop,
      renderMessages: noop,
      restoreScroll: (...args) => renders.push({ restore: args }),
      stickToBottom: () => renders.push({ bottom: true }),
      syncMessagesToDom: (messages, options) => {
        renders.push({ messages, options });
        pane.scrollHeight = 300;
      },
    },
    feedback: { setStatus: (...args) => statuses.push(args) },
    fetchJson,
  });
  return { loader, state, cache, pane, renders, reads, metadata, statuses };
}

test("quiet deltas merge cache and append only new messages without metadata or read effects when scrolled up", async () => {
  const fixture = loadingFixture(async () => ({ messages: [message("existing"), message("new", "2026-08-09T12:01:00Z")] }), false);
  await fixture.loader.loadMessages({ after: "2026-08-09T12:00:00Z", quiet: true });
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing", "new"]);
  assert.equal(fixture.renders.length, 1);
  assert.equal(fixture.renders[0].options.incremental, true);
  assert.deepEqual(fixture.renders[0].options.incoming.map((row) => row.id), ["new"]);
  assert.equal(fixture.renders[0].options.scrollToBottom, false);
  assert.deepEqual(fixture.metadata, []);
  assert.deepEqual(fixture.reads, []);
  assert.equal(fixture.state.loadingMessages, false);
});

test("history pagination preserves the viewport anchor and does not mark messages read", async () => {
  const fixture = loadingFixture(async () => ({ messages: [message("older", "2026-08-09T11:00:00Z")], has_more: true }));
  await fixture.loader.loadMessages({ before: "2026-08-09T12:00:00Z", preserveScroll: true });
  assert.equal(fixture.pane.scrollTop, 142);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["older", "existing"]);
  assert.equal(fixture.cache.hasMore, true);
  assert.deepEqual(fixture.reads, []);
});

test("replaced loads cannot change the room cache or clear the newest request loading state", async () => {
  const requests = [];
  const fixture = loadingFixture(() => new Promise((resolve) => requests.push(resolve)));
  const first = fixture.loader.loadMessages({ force: true });
  fixture.state.activeRoom = { type: "channel", id: "new-room" };
  fixture.state.roomCache.set("channel:new-room", fixture.cache);
  const second = fixture.loader.loadMessages({ force: true });
  requests[0]({ messages: [message("stale")] });
  await first;
  assert.equal(fixture.state.loadingMessages, true);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing"]);
  assert.equal(fixture.renders.length, 0);
  requests[1]({ messages: [message("current")] });
  await second;
  assert.equal(fixture.state.loadingMessages, false);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["current"]);
  assert.equal(fixture.reads.length, 1);
});

test("failed message refresh retains cached history and a later request recovers", async () => {
  let unavailable = true;
  const fixture = loadingFixture(async () => {
    if (unavailable) throw new Error("Network unavailable");
    return { messages: [message("recovered")] };
  });
  await assert.rejects(fixture.loader.loadMessages({ force: true }), /Network unavailable/);
  assert.equal(fixture.cache.stale, true);
  assert.equal(fixture.state.loadingMessages, false);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing"]);
  assert.deepEqual(fixture.statuses, [["Network unavailable", "error"]]);
  assert.equal(fixture.reads.length, 0);
  unavailable = false;
  await fixture.loader.loadMessages();
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["recovered"]);
  assert.deepEqual(fixture.statuses.at(-1), [null]);
});

for (const obsoleteResult of ["success", "failure"]) {
  test(`newer same-room snapshot keeps ownership after an older forced ${obsoleteResult}`, async () => {
    const requests = [];
    const fixture = loadingFixture(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
    const first = fixture.loader.loadMessages({ force: true });
    const second = fixture.loader.loadMessages({ force: true });
    const readState = { general: "newest" };
    requests[1].resolve({ messages: [message("newest")], has_more: true, channel: { id: "general" }, read_state: readState });
    await second;
    const published = {
      renders: fixture.renders.length, reads: fixture.reads.length,
      metadata: fixture.metadata.length, statuses: fixture.statuses.length,
    };
    if (obsoleteResult === "failure") requests[0].reject(new Error("Obsolete network error"));
    else requests[0].resolve({ messages: [message("obsolete")], has_more: false, channel: { id: "obsolete" }, read_state: { general: "obsolete" } });
    assert.deepEqual(await first, []);
    assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["newest"]);
    assert.equal(fixture.cache.hasMore, true);
    assert.equal(fixture.state.roomReadState, readState);
    assert.deepEqual({ renders: fixture.renders.length, reads: fixture.reads.length,
      metadata: fixture.metadata.length, statuses: fixture.statuses.length }, published);
    assert.equal(fixture.state.loadingMessages, false);
  });
}

test("an obsolete same-room completion cannot publish while the newer request is pending", async () => {
  const requests = [];
  const fixture = loadingFixture(() => new Promise((resolve) => requests.push(resolve)));
  const older = fixture.loader.loadMessages({ force: true });
  const newer = fixture.loader.loadMessages({ force: true });
  requests[0]({ messages: [message("obsolete")] });
  assert.deepEqual(await older, []);
  assert.equal(fixture.state.loadingMessages, true);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing"]);
  assert.equal(fixture.renders.length, 0);
  requests[1]({ messages: [message("current")] });
  await newer;
  assert.equal(fixture.state.loadingMessages, false);
});

test("a newer delta excludes an older full snapshot without losing messages or history availability", async () => {
  const requests = [];
  const fixture = loadingFixture(() => new Promise((resolve) => requests.push(resolve)));
  fixture.cache.hasMore = true;
  const full = fixture.loader.loadMessages({ force: true });
  const delta = fixture.loader.loadMessages({ force: true, quiet: true, after_message_id: "existing" });
  requests[1]({ messages: [message("incoming", "2026-08-09T12:01:00Z")] });
  await delta;
  requests[0]({ messages: [message("existing")], has_more: false });
  assert.deepEqual(await full, []);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing", "incoming"]);
  assert.equal(fixture.cache.hasMore, true);
});

test("an overlapping history page still merges after the newest full refresh without stale metadata", async () => {
  const requests = [];
  const fixture = loadingFixture(() => new Promise((resolve) => requests.push(resolve)));
  const history = fixture.loader.loadMessages({ before_message_id: "existing", preserveScroll: true });
  const refresh = fixture.loader.loadMessages({ force: true });
  requests[1]({ messages: [message("current")], read_state: { general: "current" } });
  await refresh;
  const metadataCount = fixture.metadata.length;
  const statusCount = fixture.statuses.length;
  requests[0]({ messages: [message("older", "2026-08-09T11:00:00Z")], has_more: true,
    read_state: { general: "obsolete" }, channel: { id: "obsolete" } });
  await history;
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["older", "current"]);
  assert.equal(fixture.cache.hasMore, true);
  assert.equal(fixture.pane.scrollTop, 142);
  assert.deepEqual(fixture.state.roomReadState, { general: "current" });
  assert.equal(fixture.metadata.length, metadataCount);
  assert.equal(fixture.statuses.length, statusCount);
  assert.equal(fixture.reads.length, 1);
});

test("a full refresh retains the history page that completed while its snapshot was pending", async () => {
  const requests = [];
  const fixture = loadingFixture(() => new Promise((resolve) => requests.push(resolve)));
  const full = fixture.loader.loadMessages({ force: true });
  const history = fixture.loader.loadMessages({ force: true, before_message_id: "existing", preserveScroll: true });
  requests[1]({ messages: [message("older", "2026-08-09T11:00:00Z")], has_more: false });
  await history;
  assert.equal(fixture.state.loadingMessages, false);
  requests[0]({ messages: [message("current")], has_more: true });
  await full;
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["older", "current"]);
  assert.equal(fixture.cache.hasMore, false, "The older page owns the reached history boundary");
});

test("a failed prefetch unlocks the room for retry and the recovered delta keeps cached messages", async () => {
  let attempts = 0;
  const requests = [];
  const fixture = loadingFixture(async (url) => {
    requests.push(url);
    if (++attempts === 1) throw new Error("Offline");
    return { messages: [message("new", "2026-08-09T12:01:00Z")] };
  });
  fixture.cache.stale = true;
  fixture.cache.latestCursor = "2026-08-09T12:00:00Z";
  fixture.cache.latestMessageId = "existing";
  await fixture.loader.prefetchRoomMessages(fixture.state.activeRoom);
  assert.equal(fixture.cache.stale, true);
  assert.equal(fixture.state.prefetchingRooms.size, 0);
  await fixture.loader.prefetchRoomMessages(fixture.state.activeRoom);
  assert.equal(attempts, 2);
  assert.match(requests[1], /after_message_id=existing/);
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing", "new"]);
  assert.equal(fixture.cache.stale, false);
  assert.equal(fixture.state.prefetchingRooms.size, 0);
  assert.equal(fixture.renders.length, 0);
  assert.equal(fixture.reads.length, 0);
});

test("selection generation rejects an old response even after returning to the same room", async () => {
  let complete;
  let current = true;
  const fixture = loadingFixture(() => new Promise((resolve) => { complete = resolve; }));
  const load = fixture.loader.loadMessages({ roomSelection: { isCurrent: () => current } });
  current = false;
  complete({ messages: [message("obsolete")] });
  await load;
  assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["existing"]);
  assert.equal(fixture.renders.length, 0);
  assert.equal(fixture.reads.length, 0);
});

test("offline bootstrap still hydrates a cached room while reporting the server failure", async () => {
  const room = { type: "channel", id: "general" };
  const state = { user: { id: "user-1" }, settings: {}, membersCollapsed: false };
  const selected = [];
  const configured = [];
  const statuses = [];
  const bootstrap = createChatBootstrap({
    readState: { refreshChatSummary: async () => {} },

    root: { dataset: {} }, state,
    extensions: { attachments: { configure: (value) => configured.push(value) } },
    persistence: { hydrateRoomFromPersistentCache: async () => true },
    rooms: { selectRoom: async (...args) => selected.push(args),
      setMembersCollapsed: noop,
      updateRoomLists: noop,
      renderHeader: noop,
      registerKnownUsersFromState: noop },

    realtime: { startRealtimeServices: async () => {} },
    view: { renderMessageLoader: noop, renderMessages: noop },
    scheduler: { schedulePersistentBootstrapSave: noop, scheduleRoomPrefetches: noop },
    feedback: { setStatus: (...args) => statuses.push(args) },
    identity: { currentUserId: () => "user-1", requestedRoomFromLocation: () => null, roomKey },
    persistentCache: { read: async () => ({ channels: [room], activeRoom: room }), write: async () => {} },
    fetchJson: async () => { throw new Error("Server unreachable"); },
  });
  await bootstrap.startChat();
  assert.equal(state.persistentCacheReady, true);
  assert.equal(state.hydratedFromPersistentCache, true);
  assert.deepEqual(selected, [[room, { fromCacheHydration: true, quiet: true }]]);
  assert.deepEqual(statuses, [["Server unreachable", "error"]]);
  assert.deepEqual(configured, [{}]);
});

for (const restriction of ["read_only", "unapproved", "removed-channel", "blocked", "removed-thread"]) {
  test(`message retry retains the failed record without sending after ${restriction}`, async () => {
    const room = { type: restriction.includes("thread") || restriction === "blocked" ? "thread" : "channel", id: "original" };
    const channel = { id: "original", approved: true, read_only: false };
    const thread = { id: "original", blocked: false };
    const state = {
      activeRoom: { type: "channel", id: "another" },
      channels: [channel, { id: "another", approved: true }], threads: [thread],
      failedMessages: new Map([["failed", { room, payload: { content: "Original draft" } }]]),
      messageSendInFlight: false,
    };
    const store = createTestChatStore(state);
    const failed = { id: "failed", content: "Original draft", delivery_state: "failed" };
    store.mergeRoomMessages(room, [failed]);
    const messages = store.cacheFor(room).messages;
    const posts = [];
    const patches = [];
    const statuses = [];
    const clears = [];
    const els = { input: { value: "New draft", style: {}, scrollHeight: 24 }, sendButton: { disabled: false } };
    const composer = createChatComposer({
      state, store, els, identity: { roomKey },
      rooms: createChatRooms({ state, config: {} }),
      extensions: { attachments: { clear: () => clears.push("attachments") }, mediaPicker: { clear: () => clears.push("gif") } },
      loading: { currentRoomUrl: target => `/messages/${target.id}` },
      view: { patchMessageInDom: row => patches.push(row.delivery_state), renderRemovedMessage: noop, renderIncomingMessages: noop },
      feedback: { setStatus: (...args) => statuses.push(args) },
      fetchJson: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { message: message("delivered") }; },
    });
    if (restriction === "read_only") channel.read_only = true;
    if (restriction === "unapproved") channel.approved = false;
    if (restriction === "removed-channel") state.channels = state.channels.filter(item => item !== channel);
    if (restriction === "blocked") thread.blocked = true;
    if (restriction === "removed-thread") state.threads = [];
    await composer.retryMessage("failed");
    assert.deepEqual(posts, []);
    assert.deepEqual(patches, []);
    assert.equal(messages[0].delivery_state, "failed");
    assert.equal(state.failedMessages.size, 1);
    assert.equal(state.messageSendInFlight, false);
    assert.equal(els.sendButton.disabled, false);
    assert.equal(els.input.value, "New draft");
    assert.deepEqual(clears, []);
    assert.deepEqual(statuses, [["You can’t send messages to this conversation right now.", "error"]]);
    channel.read_only = false;
    channel.approved = true;
    thread.blocked = false;
    state.channels = [channel, { id: "another", approved: true }];
    state.threads = [thread];
    await composer.retryMessage("failed");
    assert.deepEqual(posts, [{ url: "/messages/original", body: { content: "Original draft" } }]);
    assert.equal(state.failedMessages.size, 0);
    assert.deepEqual(patches, ["sending"]);
    assert.equal(store.cacheFor(room).messages[0].id, "delivered");
    assert.equal(els.input.value, "New draft");
    assert.deepEqual(clears, []);
  });
}

test("composer ignores duplicate submission until the pending send completes", async () => {
  const room = { type: "channel", id: "general", approved: true };
  const state = { activeRoom: room, channels: [room], threads: [], user: { id: "me" }, failedMessages: new Map() };
  const cache = { messages: [] };
  const els = { input: { value: "Only once", style: {}, scrollHeight: 24 }, sendButton: {}, composer: {} };
  const posts = [];
  let complete;
  const composer = createChatComposer({
    state, els, extensions: {}, identity: { roomKey },
    rooms: { channelIsWritable: channel => Boolean(channel?.approved) },
    loading: { currentRoomUrl: selected => `/messages/${selected.id}` },
    presence: { clearTypingPresence: noop, refreshViewingPresence: noop },
    scheduler: { schedulePersistentBootstrapSave: noop },
    store: createTestChatStore(state, cache),
    view: { renderIncomingMessages: noop, renderRemovedMessage: noop },
    feedback: { setStatus: noop },
    fetchJson: (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { complete = resolve; });
    },
  });
  const pending = composer.sendActiveMessage({ preventDefault: noop });
  assert.equal(state.messageSendInFlight, true);
  assert.equal(els.sendButton.disabled, true);
  await composer.sendActiveMessage({ preventDefault: noop });
  assert.equal(posts.length, 1);
  assert.equal(cache.messages.length, 1, "duplicate submission creates no extra optimistic message");
  complete({ message: message("delivered") });
  await pending;
  assert.equal(state.messageSendInFlight, false);
  assert.equal(els.input.value, "");
  assert.deepEqual(cache.messages.map(row => row.id), ["delivered"]);
  els.input.value = "Next message";
  const next = composer.sendActiveMessage({ preventDefault: noop });
  assert.equal(posts.length, 2, "completion allows another send");
  complete({ message: message("next-delivered") });
  await next;
});

test("send failure preserves attachments for retry, then retry updates its original room without clearing the new draft", async () => {
  const originalRoom = { type: "channel", id: "general" };
  const state = { user: { id: "user-1" }, activeRoom: originalRoom, channels: [originalRoom], threads: [], failedMessages: new Map() };
  const cache = { messages: [] };
  const els = { input: { value: "Original draft", style: {}, scrollHeight: 24 }, sendButton: {}, composer: {} };
  const posts = [];
  const patches = [];
  const clears = [];
  const statuses = [];
  let retryResponse;
  const composer = createChatComposer({
    state, els,
    extensions: {
      attachments: { readyIds: () => ["upload-1"], isBusy: () => false, clear: () => clears.push("attachments") },
      mediaPicker: { selection: () => ({ gif_id: "gif-1" }), clear: () => clears.push("gif") },
    },
    identity: { roomKey },
    rooms: { activeChannel: () => originalRoom, activeThread: () => null, channelIsWritable: () => true },
    loading: { currentRoomUrl: (room) => `/messages/${room.id}` },
    presence: { clearTypingPresence: noop, refreshViewingPresence: noop },
    scheduler: { schedulePersistentBootstrapSave: noop, scheduleTransientTimeout: noop },
    store: createTestChatStore(state, cache),
    view: {
      renderIncomingMessages: noop,
      renderRemovedMessage: noop,
      patchMessageInDom: (row) => patches.push(row.delivery_state),
    },
    feedback: { setStatus: (...args) => statuses.push(args) },
    fetchJson: (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      if (posts.length === 1) return Promise.reject(new Error("Upload send interrupted"));
      return new Promise((resolve) => { retryResponse = resolve; });
    },
  });
  await composer.sendActiveMessage({ preventDefault: noop });
  const failedId = cache.messages[0].id;
  assert.equal(cache.messages[0].delivery_state, "failed");
  assert.equal(state.messageSendInFlight, false);
  assert.equal(els.input.value, "Original draft");
  assert.deepEqual(clears, []);
  assert.deepEqual(statuses, [["Upload send interrupted", "error"]]);
  const retry = composer.retryMessage(failedId);
  assert.equal(state.messageSendInFlight, true);
  assert.equal(els.sendButton.disabled, true);
  state.activeRoom = { type: "channel", id: "another" };
  els.input.value = "New room draft";
  retryResponse({ message: message("delivered") });
  await retry;
  assert.deepEqual(posts, [
    { url: "/messages/general", body: { content: "Original draft", attachment_ids: ["upload-1"], gif_id: "gif-1" } },
    { url: "/messages/general", body: { content: "Original draft", attachment_ids: ["upload-1"], gif_id: "gif-1" } },
  ]);
  assert.deepEqual(cache.messages.map((row) => row.id), ["delivered"]);
  assert.deepEqual(patches, ["failed", "sending"]);
  assert.equal(state.failedMessages.size, 0);
  assert.equal(state.messageSendInFlight, false);
  assert.equal(els.input.value, "New room draft");
  assert.deepEqual(clears, []);
});

test("optimistic removal restores every cached occurrence once and persists under the current user", async () => {
  const room = { type: "channel", id: "general" };
  const state = { activeRoom: room, roomCache: new Map() };
  const writes = [];
  const queued = [];
  const store = createChatStore({
    state,
    identity: { currentUserId: () => "user-1", roomKey },
    scheduler: { scheduleTransientTimeout: (callback) => queued.push(callback) },
    persistentCache: { read: async () => null, write: async (...args) => writes.push(args) },
    view: { removeMessageFromDom: () => false, renderMessages: noop, updateAnnouncementsUnreadBanner: noop, updateHistoryBannerVisibility: noop },
  });
  const active = store.cacheFor(room);
  const other = store.cacheFor({ type: "thread", id: "dm" });
  for (const cache of [active, other]) Object.assign(cache, { messages: [message("one"), message("removed"), message("three")], loaded: true });
  const removed = store.removeMessageFromCaches("removed");
  assert.equal(removed.length, 2);
  store.restoreMessagesToCaches(removed);
  store.restoreMessagesToCaches(removed);
  assert.deepEqual(active.messages.map((row) => row.id), ["one", "removed", "three"]);
  assert.deepEqual(other.messages.map((row) => row.id), ["one", "removed", "three"]);
  queued.forEach((callback) => callback());
  await Promise.resolve();
  assert.deepEqual(new Set(writes.map(([key]) => key)), new Set(["v2:user:user-1:room:channel:general", "v2:user:user-1:room:thread:dm"]));
});

test("pause cancels requests and transient work; resume renews the signal and dispose prevents another resume", async () => {
  const previousWindow = globalThis.window;
  const callbacks = new Map();
  const cancelled = [];
  const requests = [];
  const calls = [];
  let registered;
  globalThis.window = {
    setTimeout: (callback) => { const id = Symbol(); callbacks.set(id, callback); return id; },
    clearTimeout: (id) => { callbacks.delete(id); cancelled.push(id); },
    requestAnimationFrame: (callback) => { const id = Symbol(); callbacks.set(id, callback); return id; },
    cancelAnimationFrame: (id) => { callbacks.delete(id); cancelled.push(id); },
    requestIdleCallback: (callback) => { const id = Symbol(); callbacks.set(id, callback); return id; },
    cancelIdleCallback: (id) => { callbacks.delete(id); cancelled.push(id); },
    APStudyPageLifecycle: { register: (value) => { registered = value; } },
  };
  installChatHttpStub(globalThis.window, async (_url, options) => { requests.push(options.signal); return {}; });
  const record = (name) => () => calls.push(name);
  const state = { activeRoom: { type: "channel", id: "general" }, serverBootstrapped: true };
  const cache = {};
  const runtime = createChatLifecycle({
    readState: { cancelUnreadSummaryRefresh: record("unread"), refreshChatSummary: record("summary") },

    state,
    audio: { pause: record("audio") },
    store: { cacheFor: () => cache, persistRoomCache: record("persist"), saveRoomScroll: (_room, top) => { cache.scrollTop = top; } },
    rooms: { cancelRoomSelection: record("selection"),
      closeRoomContextMenu: record("context") },
    presence: { clearTypingPresence: record("typing"), refreshViewingPresence: record("viewing"), startPresenceRefreshTimer: record("startPresence"), stopPresenceRefreshTimer: record("stopPresence") },
    realtime: { clearReconnectTimer: record("reconnect"), resetRealtimeConnection: record("reset"), startRealtimeServices: record("startRealtime"), stopRealtimeFallback: record("fallback") },
    view: { messages: { scrollTop: 123 }, closeInlineProfilePopover: record("profile") },
    bootstrap: { startChat: record("bootstrap") },
  });
  try {
    runtime.register();
    await runtime.fetchJson("/first");
    const scheduled = [runtime.scheduleTransientTimeout(record("timeout")), runtime.scheduleTransientFrame(record("frame"))];
    runtime.scheduleIdle(record("idle"), {});
    const lateCallbacks = [...callbacks.values()];
    registered.pause();
    registered.pause();
    lateCallbacks.forEach((callback) => callback());
    assert.equal(requests[0].aborted, true);
    assert.ok(scheduled.every((id) => cancelled.includes(id)));
    assert.equal(callbacks.size, 0);
    assert.equal(cache.scrollTop, 123);
    assert.equal(calls.filter((name) => name === "reset").length, 1);
    assert.ok(!calls.includes("timeout") && !calls.includes("frame") && !calls.includes("idle"));
    registered.resume();
    registered.resume();
    await runtime.fetchJson("/resumed");
    assert.equal(requests[1].aborted, false);
    assert.notEqual(requests[0], requests[1]);
    assert.equal(calls.filter((name) => name === "startRealtime").length, 1);
    registered.dispose();
    registered.resume();
    assert.equal(runtime.status.disposed, true);
    assert.equal(requests[1].aborted, true);
    assert.equal(calls.filter((name) => name === "startRealtime").length, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});
