import assert from "node:assert/strict";
import test from "node:test";
import { createTestChatStore, importChatModule } from "./helpers/chat-modules.mjs";

const { createChatReadState } = await importChatModule("read-state.js");
const { createChatRooms } = await importChatModule("rooms.js");
const { createChatMessagesDom } = await importChatModule("messages-dom.js");
const { createChatLifecycle } = await importChatModule("lifecycle.js");
const { createChatComposer } = await importChatModule("composer.js");
const noop = () => {};
const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
const announcement = { type: "channel", id: "announcements" };
const row = (id, minute = 1) => ({ id, created_at: `2026-08-09T12:0${minute}:00Z`, content: id, user_id: "other", delete_expires_at: null });
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function control() {
  const handlers = new Map();
  return {
    value: "", innerHTML: "", hidden: false, style: {}, scrollHeight: 24,
    classList: { add: noop, remove: noop },
    addEventListener: (type, listener) => handlers.set(type, listener),
    dispatch: (type, event = {}) => handlers.get(type)?.(event),
    focus: noop,
  };
}
function browser(t) {
  const previous = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent };
  const timers = new Map();
  const events = [];
  globalThis.window = {
    setTimeout: (callback) => { const token = Symbol(); timers.set(token, callback); return token; },
    clearTimeout: (token) => timers.delete(token),
    dispatchEvent: (event) => events.push(event),
  };
  globalThis.document = { visibilityState: "visible" };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  t.after(() => Object.assign(globalThis, previous));
  return { events, runTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); } };
}
function fixture() {
  const state = {
    activeRoom: announcement, channels: [{ ...announcement, approved: true }], threads: [], user: { id: "me" },
    roomUnread: new Map(), clearedReadRooms: new Set(), localReadSeq: 0,
    roomReadState: { last_read_at: null, last_read_message_id: null }, announcementsBannerVisible: true,
  };
  const store = createTestChatStore(state);
  store.replaceRoomMessages(announcement, [row("captured")]);
  const requests = [];
  const statuses = [];
  const profilesRendered = [];
  const composerStates = [];
  const els = {
    announcementsUnread: control(), announcementsRead: control(), dmSearchInput: control(), dmResults: control(),
    roomSymbol: control(), roomName: control(), roomMeta: control(),
    profilePanel: control(),
  };
  const identity = { roomKey, latestMessageForRead: (cache) => cache?.messages?.at(-1) || null };
  const viewPort = {
    saveActiveScroll: noop, closeInlineProfilePopover: noop, setHistoryBanner: noop, renderMessageLoader: noop,
    focusComposerSoon: noop, renderApprovalNotice: noop, unreadAnnouncementMessages: (...args) => dom.unreadAnnouncementMessages(...args),
  };
  const readState = createChatReadState({
    state, els, config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements" }, identity, store, view: viewPort,
    fetchJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    feedback: { setStatus: (...args) => statuses.push(args) },
    getSelectionRevision: () => rooms.selectionRevision, onChange: () => rooms.updateRoomLists(),
  });
  const rooms = createChatRooms({
    readState,
    onRoomChange: noop,
    onRecordsChange: noop,

    root: {}, state, els, extensions: {}, config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements" }, identity, store,
    fetchJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    feedback: { setStatus: (...args) => statuses.push(args) }, profiles: { memberTierBadgeMarkup: () => "", renderMembers: noop,
      renderDmProfile: (thread) => profilesRendered.push(thread.id) },
    composer: { setComposer: (...args) => composerStates.push(args) }, loading: { renderCachedRoom: () => false, loadMessages: async () => [] },

    scheduler: { schedulePersistentBootstrapSave: noop }, messageCache: {}, view: viewPort,
  });
  const dom = createChatMessagesDom({ root: {}, state, els, extensions: {}, config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements" },
    identity, store, rooms, readState, scheduler: { scheduleTransientFrame: noop }, feedback: { setStatus: noop }, view: {},
    // The view has no request authority; any attempted direct POST fails this test.
    fetchJson: () => { throw new Error("Announcement view bypassed read-state owner"); },
  });
  readState.setRoomUnread(announcement, { unread_count: 1 });
  dom.bindPaneEvents();
  rooms.bindDmEvents();
  return { state, store, rooms, readState, dom, els, requests, statuses, profilesRendered, composerStates };
}

test("announcement click acknowledges the captured message through read state and clears only its unread state", async (t) => {
  const { events } = browser(t);
  const f = fixture();
  const unrelated = { type: "thread", id: "other" };
  f.readState.setRoomUnread(unrelated, { unread_count: 4 });
  const unrelatedUnread = f.state.roomUnread.get(roomKey(unrelated));
  f.els.announcementsRead.dispatch("click");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/chat/read");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { scope_type: "channel", scope_id: "announcements", message_id: "captured" });
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 1);
  assert.equal(f.els.announcementsUnread.hidden, false);
  f.requests[0].resolve({ read_state: { last_read_message_id: "server-later", last_read_at: row("later", 2).created_at } });
  await settle();
  assert.deepEqual(f.state.roomReadState, { last_read_message_id: "captured", last_read_at: row("captured").created_at });
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 0);
  assert.equal(f.state.roomUnread.get(roomKey(unrelated)), unrelatedUnread);
  assert.equal(f.els.announcementsUnread.hidden, true);
  assert.equal(f.state.announcementsBannerVisible, false);
  assert.equal(events.filter((event) => event.type === "apstudy-chat-read-state-change").length, 1);
  f.requests[1].resolve({ rooms: [] });
  await settle();
});

for (const change of ["latest message", "unread summary", "read state", "room switch", "room selection roundtrip"]) {
  test(`announcement completion preserves newer state after ${change}`, async (t) => {
    const { events } = browser(t);
    const f = fixture();
    const beforeRead = f.state.roomReadState;
    f.els.announcementsRead.dispatch("click");
    if (change === "latest message") f.store.mergeRoomMessages(announcement, [row("new-arrival", 2)]);
    if (change === "unread summary") {
      const summary = f.readState.refreshChatSummary();
      f.requests[1].resolve({ rooms: [{ ...announcement, unread_count: 2, has_unread: true }] });
      await summary;
    }
    if (change === "read state") f.state.roomReadState = { last_read_message_id: "newer-boundary", last_read_at: row("later", 2).created_at };
    if (change === "room switch" || change === "room selection roundtrip") {
      const other = { type: "channel", id: "pending" };
      f.state.channels.push({ ...other, kind: "university", approved: false });
      await f.rooms.selectRoom(other);
      if (change === "room selection roundtrip") await f.rooms.selectRoom(announcement);
    }
    const unread = f.state.roomUnread.get(roomKey(announcement));
    const read = f.state.roomReadState;
    f.requests[0].resolve({});
    await settle();
    assert.equal(f.state.roomUnread.get(roomKey(announcement)), unread);
    assert.equal(f.state.roomReadState, read);
    if (change !== "read state") assert.equal(read, beforeRead);
    assert.equal(f.els.announcementsUnread.hidden, false);
    assert.equal(f.state.announcementsBannerVisible, true);
    assert.equal(events.filter((event) => event.type === "apstudy-chat-read-state-change").length, 0);
    assert.equal(f.state.localReadSeq, 0);
  });
}

test("failed announcement acknowledgment retains banner and unread data with feedback", async (t) => {
  browser(t);
  const f = fixture();
  f.els.announcementsRead.dispatch("click");
  f.requests[0].reject(new Error("Read unavailable"));
  await settle();
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 1);
  assert.equal(f.els.announcementsUnread.hidden, false);
  assert.equal(f.state.announcementsBannerVisible, true);
  assert.deepEqual(f.statuses, [["Read unavailable", "error"]]);
});

test("forced read sends its cached boundary and rejects a new unread arrival during the request", async (t) => {
  browser(t);
  const f = fixture();
  const read = f.readState.markRoomRead(announcement, f.store.cacheFor(announcement), { force: true });
  assert.equal(JSON.parse(f.requests[0].options.body).message_id, "captured");
  f.readState.setRoomUnread(announcement, { unread_count: 2 });
  f.requests[0].resolve({});
  await read;
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 2);
  assert.equal(f.els.announcementsUnread.hidden, false);
});

test("failed forced read keeps its unread boundary, banner and summary refresh available", async (t) => {
  const { runTimers } = browser(t);
  const f = fixture();
  f.readState.scheduleUnreadSummaryRefresh();
  const read = f.readState.markRoomRead(announcement, f.store.cacheFor(announcement), { force: true });
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 1);
  f.requests[0].reject(new Error("Read unavailable"));
  await read;
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 1);
  assert.equal(f.state.localReadSeq, 0);
  assert.equal(f.els.announcementsUnread.hidden, false);
  runTimers();
  assert.equal(f.requests[1].url, "/api/chat/summary");
  f.requests[1].resolve({ rooms: [{ ...announcement, unread_count: 1 }] });
  await settle();
});

test("read-state reconciliation caps counts and suppresses unread already cleared locally", async (t) => {
  const { events } = browser(t); const f = fixture();
  f.readState.clearRoomUnread(announcement);
  const summary = f.readState.refreshChatSummary();
  f.requests[0].resolve({ rooms: [
    { ...announcement, unread_count: 2, has_unread: true },
    { type: "thread", id: "other", unread_count: 120 },
    { type: "unknown", id: "ignored", unread_count: 5 },
  ] });
  const reconciled = await summary;
  assert.equal(f.state.roomUnread.get(roomKey(announcement)).unread_count, 0);
  assert.equal(f.state.roomUnread.get("thread:other").unread_count, 99);
  assert.equal(f.state.roomUnread.has("unknown:ignored"), false);
  assert.equal(reconciled.total_unread, 99); assert.equal(reconciled.unread_capped, true);
  assert.equal(events.at(-1).type, "apstudy-chat-summary");
  assert.equal(events.at(-1).detail, reconciled);
});

test("read-state summary started before a local read cannot restore its unread boundary", async (t) => {
  browser(t); const f = fixture();
  const summary = f.readState.refreshChatSummary();
  f.readState.clearRoomUnread(announcement);
  const cleared = f.state.roomUnread.get(roomKey(announcement));
  f.requests[0].resolve({ rooms: [{ ...announcement, unread_count: 5 }] });
  assert.equal(await summary, null);
  assert.equal(f.state.roomUnread.get(roomKey(announcement)), cleared);
  assert.equal(f.state.chatSummaryLoading, false);
});

test("read-state refresh scheduling coalesces work and cancellation leaves no queued request", async (t) => {
  const { runTimers } = browser(t); const f = fixture();
  f.readState.scheduleUnreadSummaryRefresh(); f.readState.scheduleUnreadSummaryRefresh();
  f.readState.cancelUnreadSummaryRefresh(); runTimers(); assert.equal(f.requests.length, 0);
  f.readState.scheduleUnreadSummaryRefresh(); f.readState.scheduleUnreadSummaryRefresh();
  runTimers(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/chat/summary");
  f.requests[0].resolve({ rooms: [] }); await settle();
});

for (const obsoleteOutcome of ["success", "failure"]) {
  test(`DM input guards an old ${obsoleteOutcome} after newer results and after clear`, async (t) => {
    const { runTimers } = browser(t);
    const f = fixture();
    const input = (value) => { f.els.dmSearchInput.value = value; f.els.dmSearchInput.dispatch("input"); runTimers(); };
    input("Old");
    input("New");
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].url, "/api/chat/dm/search?q=New");
    f.requests[1].resolve({ results: [{ id: "new-user", name: "Current User" }] });
    await settle();
    const currentMarkup = f.els.dmResults.innerHTML;
    assert.match(currentMarkup, /Current User/);
    if (obsoleteOutcome === "success") f.requests[0].resolve({ results: [{ id: "old-user", name: "Obsolete User" }] });
    else f.requests[0].reject(new Error("Obsolete failure"));
    await settle();
    assert.equal(f.els.dmResults.innerHTML, currentMarkup);
    input("Waiting");
    input("");
    assert.equal(f.els.dmResults.innerHTML, "");
    if (obsoleteOutcome === "success") f.requests[2].resolve({ results: [{ id: "waiting", name: "Obsolete on clear" }] });
    else f.requests[2].reject(new Error("Obsolete on clear"));
    await settle();
    assert.equal(f.els.dmResults.innerHTML, "");
    assert.equal(f.requests.length, 3);
  });
}

test("DM input invalidates a request before the replacement debounce starts even for the same trimmed query", async (t) => {
  const { runTimers } = browser(t);
  const f = fixture();
  f.els.dmSearchInput.value = "Same";
  f.els.dmSearchInput.dispatch("input");
  runTimers();
  f.els.dmSearchInput.value = "Same ";
  f.els.dmSearchInput.dispatch("input");
  f.requests[0].resolve({ results: [{ id: "old", name: "Obsolete before debounce" }] });
  await settle();
  assert.equal(f.els.dmResults.innerHTML, "");
  assert.equal(f.requests.length, 1);
  runTimers();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ results: [{ id: "current", name: "Current after debounce" }] });
  await settle();
  assert.match(f.els.dmResults.innerHTML, /Current after debounce/);
});

test("composer submit preserves draft, media and retry message on malformed JSON and login HTML success", async (t) => {
  browser(t);
  const window = globalThis.window;
  await importChatModule("../core/http.js");
  for (const [body, contentType] of [["{broken", "application/json"], ["<!doctype html><title>Login</title>", "text/html"]]) {
    const state = { activeRoom: announcement, channels: [announcement], threads: [], user: { id: "me" }, failedMessages: new Map() };
    const store = createTestChatStore(state);
    const els = { composer: control(), input: control(), sendButton: control() };
    els.input.value = "Recoverable draft";
    let cleared = 0;
    const statuses = [];
    window.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": contentType } });
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
    const lifecycle = createChatLifecycle({});
    const composer = createChatComposer({
      state, store, els, identity: { roomKey }, fetchJson: lifecycle.fetchJson,
      extensions: { attachments: { readyIds: () => ["upload"], isBusy: () => false, clear: () => { cleared += 1; } },
        mediaPicker: { selection: () => ({ gif_id: "gif" }), clear: () => { cleared += 1; } } },
      rooms: { activeChannel: () => announcement, channelIsWritable: () => true, activeThread: () => null },
      loading: { currentRoomUrl: () => "/api/chat/messages" }, presence: { clearTypingPresence: noop },
      view: { renderIncomingMessages: noop, patchMessageInDom: noop, renderRemovedMessage: noop },
      scheduler: { schedulePersistentBootstrapSave: noop }, feedback: { setStatus: (...args) => statuses.push(args) },
    });
    composer.bindEvents();
    await els.composer.dispatch("submit", { preventDefault: noop });
    const cached = store.cacheFor(announcement).messages;
    assert.equal(cached.length, 1);
    assert.equal(cached[0].delivery_state, "failed");
    assert.equal(state.failedMessages.size, 1);
    assert.equal(els.input.value, "Recoverable draft");
    assert.equal(cleared, 0);
    assert.equal(state.messageSendInFlight, false);
    assert.equal(els.sendButton.disabled, false);
    assert.deepEqual(statuses, [["Invalid JSON response.", "error"]]);
    await composer.retryMessage(cached[0].id);
    assert.equal(store.cacheFor(announcement).messages[0].delivery_state, "failed");
    assert.equal(state.failedMessages.size, 1);
    assert.equal(els.input.value, "Recoverable draft");
    assert.equal(cleared, 0);
  }
});

test("nullable server delete expiry passes through cache and rendering without a deletion control", (t) => {
  browser(t);
  const f = fixture();
  const pane = control();
  pane.querySelector = () => null;
  const dom = createChatMessagesDom({ state: f.state, els: { messages: pane }, extensions: {},
    config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements" }, store: f.store, identity: {},
    rooms: { activeChannel: () => null }, scheduler: { scheduleTransientFrame: noop },
  });
  const cached = f.store.cacheFor(announcement).messages[0];
  assert.equal(cached.delete_expires_at, null);
  dom.renderMessages([cached]);
  assert.match(pane.innerHTML, /data-message-id="captured"/);
  assert.doesNotMatch(pane.innerHTML, /data-delete-message/);
});

function blockControl(f, blocked) {
  f.els.profilePanel.dispatch("click", { target: { closest: (selector) => selector === "[data-block-user]"
    ? { dataset: { blockUser: "user-a", blocked: String(blocked) } } : null } });
}
function threadFixture() {
  const f = fixture();
  f.state.threads = [
    { id: "thread-a", other_user: { id: "user-a", name: "User A" }, blocked: false },
    { id: "thread-b", other_user: { id: "user-b", name: "User B" }, blocked: false },
  ];
  f.state.activeRoom = { type: "thread", id: "thread-a" };
  return f;
}
for (const blocked of [false, true]) {
  for (const outcome of ["success", "failure"]) {
    test(`${blocked ? "unblock" : "block"} ${outcome} after room switch affects only the captured user`, async (t) => {
      browser(t);
      const document = globalThis.document;
      const f = threadFixture();
      f.state.threads[0].blocked = blocked;
      f.state.threads[1].blocked = !blocked;
      blockControl(f, blocked);
      assert.equal(f.requests[0].url, "/api/chat/blocks/user-a");
      assert.equal(f.requests[0].options.method, blocked ? "DELETE" : "POST");
      document.visibilityState = "hidden";
      await f.rooms.selectRoom({ type: "thread", id: "thread-b" });
      document.visibilityState = "visible";
      const currentComposer = f.composerStates.at(-1);
      const profileCount = f.profilesRendered.length;
      const statusCount = f.statuses.length;
      if (outcome === "success") f.requests[0].resolve({ blocked: !blocked });
      else f.requests[0].reject(new Error("Obsolete block failure"));
      await settle();
      assert.equal(f.state.threads[0].blocked, outcome === "success" ? !blocked : blocked);
      assert.equal(f.state.threads[1].blocked, !blocked);
      assert.equal(f.composerStates.at(-1), currentComposer);
      assert.equal(f.profilesRendered.length, profileCount);
      assert.equal(f.statuses.length, statusCount);
    });
  }
}
for (const oldOutcome of ["success", "failure"]) {
  test(`overlapping block outcomes reject the old ${oldOutcome} after current completion`, async (t) => {
    browser(t);
    const f = threadFixture();
    blockControl(f, false);
    blockControl(f, true);
    f.requests[1].resolve({ blocked: false });
    await settle();
    const renderCount = f.composerStates.length;
    if (oldOutcome === "success") f.requests[0].resolve({ blocked: true });
    else f.requests[0].reject(new Error("Obsolete operation failed"));
    await settle();
    assert.equal(f.state.threads[0].blocked, false);
    assert.equal(f.composerStates.length, renderCount);
    assert.deepEqual(f.statuses, []);
  });
}
