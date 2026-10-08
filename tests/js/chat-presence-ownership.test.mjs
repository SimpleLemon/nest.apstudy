import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule } from "./helpers/chat-modules.mjs";

const { createChatPresence } = await importChatModule("presence.js");
const { createChatRooms } = await importChatModule("rooms.js");
const { dmPresenceStatus, dmPresenceMarkup, presenceStatusLabel, normalizeLocalPresenceStatus, staleChannelPresence, staleThreadPresence } = await importChatModule("presentation.js");
const noop = () => {};
const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function fixture(t) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { APStudyPresenceHeartbeat: { setChatRoom: noop } };
  globalThis.document = { visibilityState: "visible" };
  t.after(() => Object.assign(globalThis, previous));
  const state = {
    user: { id: "me" }, activeRoom: { type: "channel", id: "general" },
    channels: [{ id: "general", online_users: [{ id: "old", name: "Old", online: true }], online_count: 1 }],
    threads: [{ id: "dm", other_user: { id: "friend", name: "Friend", online: false } }],
    knownUsers: new Map(), presenceRecords: new Map(),
  };
  const requests = []; const updates = [];
  const presence = createChatPresence({ state, els: {}, config: {}, lifecycle: { paused: false, disposed: false },
    identity: { roomKey, currentUserId: () => "me" }, onUpdate: (update) => updates.push(update),
    fetchJson: (url) => new Promise((resolve) => requests.push({ url, resolve })),
  });
  const rooms = createChatRooms({ state, root: {}, els: {}, config: {}, identity: { roomKey },
    onRoomChange: noop, onRecordsChange: noop,
  });
  return { state, requests, updates, presence, rooms };
}

test("presence presentation functions format records without a controller or mutations", () => {
  const thread = { id: "dm", presence_status: "busy", other_user: { online: true } };
  assert.equal(dmPresenceStatus(thread), "busy");
  assert.equal(presenceStatusLabel("busy"), "Busy");
  assert.equal(normalizeLocalPresenceStatus("unknown"), "offline");
  assert.match(dmPresenceMarkup("focus"), /Focus mode/);
  assert.equal(staleThreadPresence(thread).other_user.online, false);
  assert.equal(thread.other_user.online, true);
  const channel = { id: "general", online_count: 2, online_users: [{ id: "a" }] };
  assert.deepEqual(staleChannelPresence(channel).online_users, []);
  assert.equal(channel.online_users.length, 1);
});

test("initial presence owns records and reports once without mutating room or known-user records", async (t) => {
  const f = fixture(t); const before = structuredClone({ channels: f.state.channels, threads: f.state.threads });
  const load = f.presence.loadInitialPresences();
  f.requests[0].resolve({ users: [{ id: "friend", name: "Friend", presence_status: "focus" }] });
  await load;
  assert.equal(f.state.presenceRecords.get("friend").presence_status, "focus");
  assert.equal(f.updates.length, 1); assert.equal(f.state.knownUsers.size, 0);
  assert.deepEqual({ channels: f.state.channels, threads: f.state.threads }, before);
  f.rooms.applyPresenceRecords(f.state.presenceRecords);
  assert.equal(f.state.threads[0].presence_status, "focus");
  assert.equal(f.state.threads[0].other_user.online, true);
  assert.equal(f.state.knownUsers.get("friend").presence_status, "focus");
});

test("targeted presence reports a completed batch once and leaves room reconciliation to rooms", async (t) => {
  const f = fixture(t);
  f.presence.refreshViewingPresence();
  assert.deepEqual(f.requests.map(({ url }) => url), ["/api/presence/statuses", "/api/presence/room"]);
  f.requests[1].resolve({ online_users: [{ id: "new", name: "New", presence_status: "active" }] });
  await settle(); assert.equal(f.updates.length, 0);
  assert.equal(f.state.channels[0].online_users[0].id, "old");
  f.requests[0].resolve({ statuses: { friend: "busy" } }); await settle();
  assert.equal(f.updates.length, 1);
  assert.deepEqual(f.updates[0].room, f.state.activeRoom);
  assert.equal(f.state.channels[0].online_users[0].id, "old");
  f.rooms.applyPresenceRecords(f.state.presenceRecords, f.updates[0]);
  assert.deepEqual(f.state.channels[0].online_users.map(({ id }) => id), ["new"]);
  assert.equal(f.state.channels[0].online_count, 1);
  assert.equal(f.state.threads[0].presence_status, "busy");
});

test("a room-presence response from an old selection cannot mutate the newly selected room", async (t) => {
  const f = fixture(t); f.presence.refreshViewingPresence();
  f.state.activeRoom = { type: "channel", id: "other" };
  f.state.channels.push({ id: "other", online_users: [], online_count: 0 });
  f.requests[1].resolve({ online_users: [{ id: "old-result", presence_status: "active" }] });
  f.requests[0].resolve({ statuses: {} }); await settle();
  assert.equal(f.state.presenceRecords.has("old-result"), false);
  assert.equal(f.updates.length, 1); assert.equal(f.updates[0], undefined);
  f.rooms.applyPresenceRecords(f.state.presenceRecords, f.updates[0]);
  assert.deepEqual(f.state.channels[1].online_users, []);
});
