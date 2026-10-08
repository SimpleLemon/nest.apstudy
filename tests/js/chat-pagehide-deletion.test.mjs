import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createTestChatStore, importChatModule } from "./helpers/chat-modules.mjs";

const { createChatLifecycle } = await importChatModule("lifecycle.js");
const { createChatMessagesDom } = await importChatModule("messages-dom.js");
const noop = () => {};
const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

async function fixture(t, responseStatus = 200) {
  const previous = { window: globalThis.window, document: globalThis.document };
  t.after(() => Object.assign(globalThis, previous));
  const elements = [];
  const listeners = new Map();
  const requests = [];
  function element() {
    const events = new Map();
    const node = {
      innerHTML: "", children: [], className: "", style: { setProperty: noop },
      classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, removeAttribute: noop,
      appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
      prepend(child) { this.children.unshift(child); }, remove: noop, contains: () => false,
      querySelector: () => null, addEventListener: (name, callback) => events.set(name, callback),
      dispatch: (name, event) => events.get(name)?.(event),
    };
    elements.push(node);
    return node;
  }
  const document = { body: element(), addEventListener: noop, visibilityState: "visible",
    createElement: element, createElementNS: element, getElementById: (id) => elements.find((node) => node.id === id) };
  const window = {
    addEventListener(name, callback) { const callbacks = listeners.get(name) || []; callbacks.push(callback); listeners.set(name, callbacks); },
    setTimeout: () => Symbol(), clearTimeout: noop,
    APStudyConfirm: { request: async () => true },
    fetch(url, options) {
      const request = { url, options };
      requests.push(request);
      return new Promise((resolve, reject) => {
        const abort = () => reject(new globalThis.DOMException("Aborted", "AbortError"));
        if (options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener("abort", abort, { once: true });
        request.resolve = () => resolve(new Response(responseStatus === 200 ? "{}" : '{"error":"Deletion forbidden"}', {
          status: responseStatus, headers: { "Content-Type": "application/json" },
        }));
      });
    },
  };
  const context = vm.createContext({ window, document, Error, console, performance: { now: () => 0 }, requestAnimationFrame: (callback) => callback() });
  for (const file of ["escaping.js", "ui-primitives.js", "http.js"]) {
    vm.runInContext(await readFile(new URL(`../../static/js/core/${file}`, import.meta.url), "utf8"), context);
  }
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
  globalThis.window = window;
  globalThis.document = document;
  const room = { type: "channel", id: "general" };
  const state = { activeRoom: room, user: { id: "me" } };
  const store = createTestChatStore(state);
  store.replaceRoomMessages(room, [{ id: "approved-delete", user_id: "me", content: "Confirmed deletion", can_delete: true, created_at: "2026-08-09T12:00:00Z" }]);
  const pane = element();
  const lifecycle = createChatLifecycle({
    readState: { cancelUnreadSummaryRefresh: noop },
    state, store,
    rooms: { cancelRoomSelection: noop,
      closeRoomContextMenu: noop },
    presence: { clearTypingPresence: noop, stopPresenceRefreshTimer: noop },
    realtime: { resetRealtimeConnection: noop, stopRealtimeFallback: noop, clearReconnectTimer: noop },
    view: { closeInlineProfilePopover: noop },
  });
  lifecycle.register();
  const dom = createChatMessagesDom({ state, els: { messages: pane }, extensions: {},
    config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements" }, store, identity: { roomKey },
    rooms: { activeChannel: () => null }, scheduler: { scheduleTransientFrame: noop }, feedback: { setStatus: noop },
    fetchJson: lifecycle.fetchJson,
  });
  dom.renderMessages(store.cacheFor(room).messages);
  dom.bindPaneEvents();
  pane.dispatch("click", { target: { closest: (selector) => selector === "[data-delete-message]" ? { dataset: { deleteMessage: "approved-delete" } } : null } });
  await flush();
  assert.equal(window.APStudyUndo.pendingCount(), 1);
  assert.equal(store.cacheFor(room).messages.length, 0);
  return { lifecycle, requests, store, room, elements, window,
    pagehide: () => listeners.get("pagehide").forEach((callback) => callback()),
  };
}

test("real Undo pagehide deletion survives chat disposal while normal requests still abort", async (t) => {
  const f = await fixture(t);
  const normalLoad = f.lifecycle.fetchJson("/api/chat/channels/general/messages").catch((error) => error);
  const normalSend = f.lifecycle.fetchJson("/api/chat/channels/general/messages", { method: "POST", body: '{"content":"pending"}' }).catch((error) => error);
  const unrelatedKeepalive = f.lifecycle.fetchJson("/api/chat/channels/general/messages", { method: "POST", keepalive: true }).catch((error) => error);
  f.pagehide();
  assert.equal(f.lifecycle.status.disposed, true);
  await flush();
  const deletion = f.requests.find((request) => request.options.method === "DELETE");
  assert.ok(deletion);
  assert.equal(deletion.url, "/api/chat/messages/approved-delete");
  assert.equal(deletion.options.keepalive, true);
  assert.ok(deletion.options.signal instanceof AbortSignal);
  assert.equal(deletion.options.signal.aborted, false);
  for (const request of f.requests.filter((entry) => entry !== deletion)) assert.equal(request.options.signal.aborted, true);
  for (const completion of [normalLoad, normalSend, unrelatedKeepalive]) assert.equal((await completion).name, "AbortError");
  deletion.resolve();
  await flush();
  assert.equal(f.store.cacheFor(f.room).messages.length, 0);
  assert.equal(f.window.APStudyUndo.pendingCount(), 0);
  assert.equal(f.elements.filter((node) => node.className === "apstudy-toast is-error").length, 0);
});

test("durable pagehide deletion still honors server refusal and restores its captured message", async (t) => {
  const f = await fixture(t, 403);
  f.pagehide();
  await flush();
  const deletion = f.requests[0];
  assert.equal(deletion.options.signal.aborted, false);
  deletion.resolve();
  await flush();
  assert.deepEqual(f.store.cacheFor(f.room).messages.map((message) => message.id), ["approved-delete"]);
  assert.equal(f.elements.filter((node) => node.className === "apstudy-toast is-error").length, 1);
});
