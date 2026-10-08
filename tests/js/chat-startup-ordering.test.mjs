import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule } from "./helpers/chat-modules.mjs";

const { staleChannelPresence } = await importChatModule("presentation.js");
const { createChatBootstrap } = await importChatModule("bootstrap.js");
const { createChatStore } = await importChatModule("store.js");
const { createChatLifecycle } = await importChatModule("lifecycle.js");
const { createChatRealtime } = await importChatModule("realtime.js");
const noop = () => {};
const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
const cachedRoom = { type: "channel", id: "cached" };
const requestedRoom = { type: "channel", id: "requested" };
const message = (id) => ({ id, created_at: "2026-10-02T12:00:00Z", content: id });
function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}
function bootstrapFixture(overrides = {}) {
  const state = { user: { id: "user" }, settings: {}, channels: [], threads: [], activeRoom: null, membersCollapsed: false, serverBootstrapped: false };
  const selected = [];
  const requestedSelected = deferred();
  const statuses = [];
  const bootstrap = createChatBootstrap({
    readState: { refreshChatSummary: async () => {} },

    root: { dataset: {} }, state, extensions: {},
    persistence: { hydrateRoomFromPersistentCache: async () => true },
    rooms: { selectRoom: async (room, options) => {
        state.activeRoom = room;
        selected.push({ room, options });
        if (room.id === requestedRoom.id) requestedSelected.resolve();
      },
      setMembersCollapsed: noop,
      updateRoomLists: noop,
      renderHeader: noop,
      registerKnownUsersFromState: noop },

    realtime: { startRealtimeServices: async () => {} },
    view: { renderMessageLoader: noop, renderMessages: noop },
    scheduler: { schedulePersistentBootstrapSave: noop, scheduleRoomPrefetches: noop },
    feedback: { setStatus: (...args) => statuses.push(args) },
    identity: { currentUserId: () => "user", requestedRoomFromLocation: () => requestedRoom, roomKey },
    persistentCache: { read: async () => ({ channels: [cachedRoom], activeRoom: cachedRoom }), write: async () => {} },
    fetchJson: async () => ({ user: { id: "server-user" }, sections: { nest: [requestedRoom], direct_messages: [] } }),
    ...overrides,
  });
  return { state, selected, requestedSelected, statuses, bootstrap };
}

for (const stage of ["bootstrap-disk", "realtime", "room-disk"]) {
  test(`server requested room wins when cached startup is suspended at ${stage}`, async () => {
    const blocked = deferred();
    const entered = deferred();
    const server = deferred();
    const overrides = { fetchJson: () => server.promise };
    if (stage === "bootstrap-disk") {
      overrides.persistentCache = { read: () => { entered.resolve(); return blocked.promise; }, write: async () => {} };
    } else if (stage === "realtime") {
      let calls = 0;
      overrides.realtime = { startRealtimeServices: async () => {
        if (++calls === 1) { entered.resolve(); await blocked.promise; }
      } };
    } else {
      overrides.persistence = { hydrateRoomFromPersistentCache: () => { entered.resolve(); return blocked.promise; } };
    }
    const fixture = bootstrapFixture(overrides);
    const startup = fixture.bootstrap.startChat();
    await entered.promise;
    server.resolve({ user: { id: "server-user" }, sections: { nest: [requestedRoom], direct_messages: [] } });
    await fixture.requestedSelected.promise;
    blocked.resolve({ user: { id: "cache-user" }, channels: [cachedRoom], activeRoom: cachedRoom });
    await startup;
    assert.deepEqual(fixture.selected.map(({ room }) => room), [requestedRoom]);
    assert.deepEqual(fixture.state.activeRoom, requestedRoom);
    assert.equal(fixture.state.user.id, "server-user");
    assert.deepEqual(fixture.state.channels, [staleChannelPresence(requestedRoom)]);
    assert.equal(fixture.state.persistentCacheReady, true);
    assert.notEqual(fixture.state.hydratedFromPersistentCache, true);
  });
}

test("a room chosen during disk hydration is retained even when the server is offline", async () => {
  const blocked = deferred();
  const entered = deferred();
  const fixture = bootstrapFixture({
    fetchJson: async () => { throw new Error("Offline"); },
    persistence: { hydrateRoomFromPersistentCache: () => { entered.resolve(); return blocked.promise; } },
  });
  const startup = fixture.bootstrap.startChat();
  await entered.promise;
  fixture.state.activeRoom = requestedRoom;
  blocked.resolve(true);
  await startup;
  assert.deepEqual(fixture.state.activeRoom, requestedRoom);
  assert.deepEqual(fixture.selected, []);
  assert.deepEqual(fixture.statuses, [["Offline", "error"]]);
});

test("a superseded bootstrap response cannot replace newer server metadata or selection", async () => {
  const oldServer = deferred();
  const newServer = deferred();
  let calls = 0;
  const fixture = bootstrapFixture({ fetchJson: () => ++calls === 1 ? oldServer.promise : newServer.promise });
  const older = fixture.bootstrap.bootstrap();
  const newer = fixture.bootstrap.bootstrap();
  newServer.resolve({ user: { id: "new-user" }, sections: { nest: [requestedRoom] } });
  await newer;
  oldServer.resolve({ user: { id: "old-user" }, sections: { nest: [cachedRoom] } });
  await older;
  assert.equal(fixture.state.user.id, "new-user");
  assert.deepEqual(fixture.state.channels, [staleChannelPresence(requestedRoom)]);
  assert.deepEqual(fixture.selected.map(({ room }) => room), [requestedRoom]);
});

function storeFixture(read) {
  const state = { activeRoom: cachedRoom, roomCache: new Map() };
  const store = createChatStore({
    state, identity: { currentUserId: () => "user", roomKey },
    scheduler: { scheduleTransientTimeout: noop }, persistentCache: { read, write: async () => {} },
    view: { removeMessageFromDom: () => false, renderMessages: noop, updateAnnouncementsUnreadBanner: noop, updateHistoryBannerVisibility: noop },
  });
  return { state, store, cache: store.cacheFor(cachedRoom) };
}
for (const liveWrite of ["loaded", "replacement", "append"]) {
  test(`a pending room disk read preserves a live ${liveWrite} snapshot`, async () => {
    const disk = deferred();
    const fixture = storeFixture(() => disk.promise);
    const hydration = fixture.store.hydrateRoomFromPersistentCache(cachedRoom);
    if (liveWrite === "append") fixture.cache.messages.push(message("live"));
    else fixture.cache.messages = [message("live")];
    if (liveWrite === "loaded") fixture.cache.loaded = true;
    disk.resolve({ room: cachedRoom, messages: [message("disk")], hasMore: true, scrollTop: 99 });
    assert.equal(await hydration, false);
    assert.deepEqual(fixture.cache.messages.map((row) => row.id), ["live"]);
    assert.equal(fixture.cache.stale, false);
    assert.equal(fixture.cache.scrollTop, 0);
  });
}

test("an existing live partial snapshot never starts disk hydration", async () => {
  let reads = 0;
  const fixture = storeFixture(async () => { reads++; return null; });
  fixture.cache.messages.push(message("live"));
  assert.equal(await fixture.store.hydrateRoomFromPersistentCache(cachedRoom), false);
  assert.equal(reads, 0);
});

test("room disk reads reject records belonging to another room", async () => {
  const fixture = storeFixture(async () => ({ room: requestedRoom, messages: [message("wrong")], hasMore: true }));
  assert.equal(await fixture.store.hydrateRoomFromPersistentCache(cachedRoom), false);
  assert.equal(fixture.state.roomCache.size, 1);
  assert.equal(fixture.cache.loaded, false);
  assert.deepEqual(fixture.cache.messages, []);
});

test("a valid room disk snapshot hydrates history, scroll position, and delta cursors", async () => {
  const fixture = storeFixture(async () => ({ room: cachedRoom, messages: [message("disk")], hasMore: true, scrollTop: 99 }));
  assert.equal(await fixture.store.hydrateRoomFromPersistentCache(cachedRoom), true);
  assert.equal(fixture.cache.loaded, true);
  assert.equal(fixture.cache.stale, true);
  assert.equal(fixture.cache.hasMore, true);
  assert.equal(fixture.cache.scrollTop, 99);
  assert.equal(fixture.cache.latestMessageId, "disk");
});

for (const failure of ["NotAllowedError", "AbortError", "NotSupportedError", "synchronous"]) {
  test(`realtime notifications contain optional audio ${failure} failures`, async () => {
    const previousWindow = globalThis.window;
    const previousWarn = console.warn;
    const warnings = [];
    const timers = [];
    globalThis.window = { setTimeout: (callback) => { timers.push(callback); return timers.length; } };
    console.warn = (...args) => warnings.push(args);
    const error = new Error("Sound unavailable");
    error.name = failure;
    let plays = 0;
    const state = { user: { id: "user" }, settings: { chat_sound_enabled: true }, channels: [cachedRoom], threads: [], activeRoom: requestedRoom };
    const lifecycle = createChatLifecycle({ state, audio: { play: () => {
      plays++;
      if (failure === "synchronous") throw error;
      return Promise.reject(error);
    } } });
    const realtime = createChatRealtime({
      readState: { scheduleUnreadSummaryRefresh: noop },

      state, config: {}, identity: { roomKey },
      rooms: {  },
      store: { markRoomStale: noop }, feedback: { playChatSound: lifecycle.playChatSound },
    });
    try {
      await realtime.handleRealtimePayload({ scope_type: "channel", scope_id: cachedRoom.id, event_type: "message_created", message_id: "one", actor_id: "other" });
      await realtime.handleRealtimePayload({ scope_type: "channel", scope_id: cachedRoom.id, event_type: "message_created", message_id: "two", actor_id: "other" });
      await new Promise(setImmediate);
      assert.equal(plays, 1);
      assert.equal(timers.length, 1);
      assert.equal(warnings.length, ["NotAllowedError", "AbortError"].includes(failure) ? 0 : 1);
      if (warnings.length) assert.equal(warnings[0][1], error);
    } finally {
      globalThis.window = previousWindow;
      console.warn = previousWarn;
    }
  });
}
