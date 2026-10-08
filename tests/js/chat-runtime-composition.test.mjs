import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule, installChatHttpStub } from "./helpers/chat-modules.mjs";

const { startChatRuntime } = await importChatModule("runtime.js");
const elementIds = ["channel-list", "dm-list", "dm-new", "dm-search", "dm-search-input", "dm-results", "room-symbol", "room-name", "room-meta", "status", "history-limited", "announcements-unread", "announcements-read", "join-discord", "messages", "typing-indicator", "new-messages", "members", "member-list", "members-context", "members-count", "members-restore-count", "profile-panel"];

test("real chat composition loads a channel, renders messages, and resumes its lifecycle", async () => {
  const element = () => ({
    dataset: {}, hidden: false, style: {}, value: "", innerHTML: "", textContent: "",
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {},
  });
  const elements = new Map(elementIds.map((id) => [`chat-${id}`, element()]));
  for (const id of ["chat-composer", "chat-message-input"]) elements.set(id, element());
  const root = element();
  root.dataset.currentUserId = "user-1";
  const document = {
    visibilityState: "visible", body: element(),
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => selector === ".chat-app" ? root : null,
    querySelectorAll: () => [], createElement: element, addEventListener() {},
  };
  const timers = new Map();
  const window = {
    document, innerWidth: 1280, location: { search: "" },
    setTimeout(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    cancelAnimationFrame: (id) => timers.delete(id),
    addEventListener() {}, dispatchEvent() {},
  };
  const oldGlobals = new Map(["window", "document", "sessionStorage", "CustomEvent", "EventSource"].map((name) => [name, globalThis[name]]));
  const requests = [];
  const connections = [];
  const configured = [];
  let lifecycle;
  class FakeEventSource {
    constructor(url) { this.url = url; connections.push(this); }
    close() { this.closed = true; }
  }
  Object.assign(globalThis, {
    window,
    document,
    sessionStorage: { getItem: () => null, setItem() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    EventSource: FakeEventSource,
  });
  window.EventSource = FakeEventSource;
  window.APStudyPageLifecycle = { register: (handlers) => { lifecycle = handlers; } };
  const channel = { id: "general", label: "General", approved: true, kind: "nest", online_users: [] };
  installChatHttpStub(window, async (url, options) => {
    requests.push({ url, options });
    if (url === "/api/chat/bootstrap") return { user: { id: "user-1" }, capabilities: { attachments: { available: true } }, sections: { nest: [channel], direct_messages: [] } };
    if (url.startsWith("/api/chat/channels/general/messages")) return { messages: [{ id: "message-1", content: "Loaded through explicit contracts", created_at: "2026-08-09T12:00:00Z", author_name: "Test User" }], channel };
    if (url === "/api/chat/summary") return { rooms: [], total_unread: 0 };
    return {};
  });
  try {
    startChatRuntime({ attachments: { configure: (capabilities) => configured.push(capabilities) } });
    for (let index = 0; index < 30 && !document.getElementById("chat-messages").innerHTML.includes("message-1"); index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(window.NestChat.activeRoom.id, "general");
    assert.equal(window.NestChat.roomCache.get("channel:general").messages[0].id, "message-1");
    assert.match(document.getElementById("chat-messages").innerHTML, /Loaded through explicit contracts/);
    assert.equal(document.getElementById("chat-status").hidden, true);
    assert.equal(configured.length, 1);
    assert.ok(requests.some(({ url }) => url === "/api/chat/read"));
    connections[0].onopen();
    lifecycle.pause();
    assert.equal(connections[0].closed, true);
    assert.equal(window.NestChat.presenceRefreshTimer, null);
    lifecycle.resume();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connections.length, 2);
    assert.notEqual(window.NestChat.presenceRefreshTimer, null);
  } finally {
    lifecycle?.dispose();
    for (const [name, value] of oldGlobals) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});
