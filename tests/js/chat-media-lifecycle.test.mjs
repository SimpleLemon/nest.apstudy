import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule } from "./helpers/chat-modules.mjs";

const { createAttachmentManager } = await importChatModule("attachments.js");
const { createMediaPicker } = await importChatModule("media-picker.js");
const { createMessageMedia } = await importChatModule("message-media.js");
const { startChatRuntime } = await importChatModule("runtime.js");
const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };
const noop = () => {};
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t) {
  const names = ["window", "document", "fetch", "sessionStorage", "localStorage", "HTMLElement", "setTimeout", "clearTimeout", "navigator", "Response", "CompressionStream"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    lifecycle?.dispose();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  const timers = new Map();
  class Element {
    constructor() {
      this.listeners = new Map(); this.dataset = {}; this.hidden = false; this.style = {}; this.value = "";
      this.innerHTML = ""; this.textContent = ""; this.children = []; this.attributes = new Map();
      this.classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
      this.isConnected = true; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100;
    }
    addEventListener(name, callback) { const callbacks = this.listeners.get(name) || new Set(); callbacks.add(callback); this.listeners.set(name, callbacks); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatch(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback({ target: this, preventDefault: noop, ...event }); }
    countListeners() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, force) { if (force) this.attributes.set(name, ""); else this.attributes.delete(name); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains() { return false; }
    closest() { return null; }
    appendChild() {}
    insertAdjacentHTML(_position, html) { this.innerHTML += html; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 100, top: 100 }; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const ids = ["pending-files", "upload-list", "file-input", "attach-button", "composer", "message-input", "media-button", "media-picker", "media-search", "emoji-tab", "gif-tab", "emoji-categories", "emoji-panel", "gif-panel", "gif-results", "gif-selection", "gif-unavailable", "download-warning", "download-confirm", "virus-total-link", "messages", "status", "room-symbol", "room-name", "room-meta"];
  const elements = new Map(ids.map((id) => [`chat-${id}`, new Element()]));
  elements.get("chat-emoji-tab").parentElement = new Element();
  elements.get("chat-media-picker").hidden = true;
  const root = new Element(); root.dataset.currentUserId = "me";
  const document = Object.assign(new Element(), {
    visibilityState: "visible", body: new Element(), activeElement: null,
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => selector === ".chat-app" ? root : null,
    createElement: () => new Element(),
  });
  const setTimeout = (callback) => { const id = Symbol(); timers.set(id, callback); return id; };
  const clearTimeout = (id) => timers.delete(id);
  let lifecycle;
  const window = Object.assign(new Element(), {
    document, innerWidth: 1280, innerHeight: 800, location: { search: "" },
    setTimeout, clearTimeout, setInterval: setTimeout, clearInterval: clearTimeout,
    requestAnimationFrame: setTimeout, cancelAnimationFrame: clearTimeout,
    dispatchEvent: noop,
    APStudyPageLifecycle: { register: (handlers) => { lifecycle = handlers; } },
    APStudyHttp: { fetchJson: () => new Promise(noop) },
  });
  for (const [name, value] of Object.entries({ window, document, HTMLElement: Element, setTimeout, clearTimeout,
    navigator: { onLine: true }, sessionStorage: { getItem: () => null, setItem: noop }, localStorage: { getItem: () => null, setItem: noop } })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return { window, document, elements, timers, lifecycle: () => lifecycle, el: (id) => elements.get(`chat-${id}`),
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); },
    listenerCount() { return document.countListeners() + window.countListeners() + [...elements.values()].reduce((sum, el) => sum + el.countListeners(), 0) + elements.get("chat-emoji-tab").parentElement.countListeners(); },
  };
}

function attachmentsFixture(t) {
  const f = fixture(t); const requests = [];
  f.window.APStudyHttp.uploadXhr = (_url, options) => { const request = { ...deferred(), options }; requests.push(request); return request.promise; };
  const manager = createAttachmentManager(); let changes = 0;
  manager.init({ state: { activeRoom: { type: "channel", id: "general" } }, onComposerChange: () => { changes += 1; } });
  manager.configure({ attachments: true });
  function addFile(name = "notes.txt") { const file = new Blob(["draft"]); file.name = name; f.el("file-input").files = [file]; f.el("file-input").dispatch("change"); }
  return { ...f, manager, requests, addFile, changes: () => changes };
}

for (const transition of ["pause", "dispose"]) {
  test(`upload preparation interrupted by ${transition} cannot start a request`, async (t) => {
    const f = attachmentsFixture(t); const preparations = [];
    globalThis.CompressionStream = class {};
    f.window.CompressionStream = globalThis.CompressionStream;
    globalThis.Response = class {
      blob() { const preparation = deferred(); preparations.push(preparation); return preparation.promise; }
    };
    const file = new Blob(["draft"]); file.name = "preparing.txt";
    file.stream = () => ({ pipeThrough: () => ({}) });
    f.el("file-input").files = [file]; f.el("file-input").dispatch("change");
    assert.equal(preparations.length, 1); assert.equal(f.requests.length, 0);
    f.manager[transition]();
    const markup = f.el("upload-list").innerHTML; const changes = f.changes();
    assert.equal(f.requests.length, 0); assert.equal(f.manager.hasContent(), true);
    assert.equal(f.el("upload-list").innerHTML, markup); assert.equal(f.changes(), changes);
    f.manager.resume();
    if (transition === "pause") {
      assert.equal(preparations.length, 2);
      // The old preparation finishes after resume, while its replacement is pending.
      preparations[0].resolve(new Blob(["x"])); await flush();
      assert.equal(f.requests.length, 0);
      preparations[1].resolve(new Blob(["x"])); await flush();
      assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.body.get("content_encoding"), "gzip");
      f.requests[0].resolve({ status: 200, response: { attachment: { id: "prepared-after-resume" } } }); await flush();
      assert.deepEqual(f.manager.readyIds(), ["prepared-after-resume"]);
      assert.match(f.el("upload-list").innerHTML, /preparing.txt/);
      f.manager.dispose();
    } else {
      preparations[0].resolve(new Blob(["x"])); await flush();
      assert.equal(f.requests.length, 0); assert.equal(f.el("upload-list").innerHTML, markup); assert.equal(f.changes(), changes);
      assert.equal(preparations.length, 1); assert.equal(f.listenerCount(), 0);
    }
  });

  test(`upload completion after ${transition} cannot mutate content or render`, async (t) => {
    const f = attachmentsFixture(t); f.addFile(); await flush();
    const request = f.requests[0]; assert.ok(request);
    f.manager[transition]();
    assert.equal(request.options.signal.aborted, true);
    const markup = f.el("upload-list").innerHTML; const changes = f.changes();
    request.options.onProgress({ lengthComputable: true, loaded: 9, total: 10 });
    request.resolve({ status: 200, response: { attachment: { id: "late" } } }); await flush();
    assert.deepEqual(f.manager.readyIds(), []); assert.equal(f.el("upload-list").innerHTML, markup); assert.equal(f.changes(), changes);
    assert.equal(f.manager.hasContent(), true);
    if (transition === "pause") {
      f.manager.resume(); await flush(); assert.equal(f.requests.length, 2);
      f.requests[1].resolve({ status: 200, response: { attachment: { id: "resumed" } } }); await flush();
      assert.deepEqual(f.manager.readyIds(), ["resumed"]); assert.match(f.el("upload-list").innerHTML, /notes.txt/);
    } else { f.manager.resume(); f.addFile("ignored.txt"); await flush(); assert.equal(f.requests.length, 1); assert.equal(f.listenerCount(), 0); }
  });
}

test("paused upload rejection stays queued and resumes without losing ready attachments", async (t) => {
  const f = attachmentsFixture(t); f.addFile("ready.txt"); await flush();
  f.requests[0].resolve({ status: 200, response: { attachment: { id: "ready" } } }); await flush();
  f.addFile("queued.txt"); await flush(); f.manager.pause();
  f.requests[1].reject(new globalThis.DOMException("Aborted", "AbortError")); await flush();
  assert.deepEqual(f.manager.readyIds(), ["ready"]); assert.equal(f.manager.isBusy(), true);
  f.manager.resume(); await flush(); assert.equal(f.requests.length, 3);
  assert.deepEqual(f.manager.readyIds(), ["ready"]); assert.doesNotMatch(f.el("upload-list").innerHTML, /Upload cancelled/);
  f.manager.dispose();
});

function pickerFixture(t) {
  const f = fixture(t); const requests = []; let changes = 0;
  globalThis.fetch = (url, options) => { const request = { ...deferred(), url, options }; requests.push(request); return request.promise; };
  const picker = createMediaPicker(); picker.init({ onComposerChange: () => { changes += 1; } });
  picker.configure({ giphy: { available: true, api_key: "test" } });
  return { ...f, picker, requests, changes: () => changes };
}

for (const transition of ["pause", "dispose"]) {
  test(`active GIF fetch aborts directly on ${transition} and ignores late response`, async (t) => {
    const f = pickerFixture(t); f.el("gif-tab").dispatch("click");
    const request = f.requests[0];
    assert.equal(request.options.signal.aborted, false);
    f.picker[transition](); assert.equal(request.options.signal.aborted, true);
    const markup = f.el("gif-results").innerHTML; let jsonCalls = 0;
    request.resolve({ ok: true, json: async () => { jsonCalls += 1; return { data: [] }; } }); await flush();
    assert.equal(jsonCalls, 0); assert.equal(f.el("gif-results").innerHTML, markup);
    f.picker.resume();
    assert.equal(f.requests.length, transition === "pause" ? 2 : 1);
    f.picker.dispose(); assert.equal(f.listenerCount(), 0);
  });

  test(`GIF JSON completion after ${transition} cannot render`, async (t) => {
    const f = pickerFixture(t); f.el("gif-tab").dispatch("click");
    const payload = deferred(); f.requests[0].resolve({ ok: true, json: () => payload.promise }); await flush();
    const requestSignal = f.requests[0].options.signal;
    assert.equal(requestSignal.aborted, false);
    f.picker[transition](); assert.equal(requestSignal.aborted, true);
    const markup = f.el("gif-results").innerHTML;
    payload.resolve({ data: [{ id: "late", title: "Late GIF", images: { fixed_width: { url: "late.gif" } } }] }); await flush();
    assert.equal(f.el("gif-results").innerHTML, markup); assert.equal(f.requests.length, 1);
    if (transition === "pause") { f.picker.resume(); assert.equal(f.requests.length, 2); f.picker.dispose(); }
    else { f.picker.resume(); f.el("gif-tab").dispatch("click"); assert.equal(f.requests.length, 1); }
    assert.equal(f.listenerCount(), 0);
  });

  test(`GIF search debounce clears on ${transition} and preserves its query`, async (t) => {
    const f = pickerFixture(t); f.el("gif-tab").dispatch("click");
    f.requests[0].resolve({ ok: true, json: async () => ({ data: [] }) }); await flush();
    f.el("media-search").value = "cats"; f.el("media-search").dispatch("input");
    assert.equal(f.timers.size, 1);
    f.picker[transition](); assert.equal(f.timers.size, 0);
    f.runTimers(); assert.equal(f.requests.length, 1); assert.equal(f.el("media-search").value, "cats");
    f.picker.resume();
    assert.equal(f.requests.length, transition === "pause" ? 2 : 1);
    if (transition === "pause") assert.equal(new URL(f.requests[1].url).searchParams.get("q"), "cats");
    f.picker.dispose(); assert.equal(f.listenerCount(), 0);
  });
}

test("GIF failure after pause cannot replace results and resumes its request", async (t) => {
  const f = pickerFixture(t); f.el("gif-tab").dispatch("click"); f.picker.pause();
  const markup = f.el("gif-results").innerHTML; f.requests[0].reject(new Error("late failure")); await flush();
  assert.equal(f.el("gif-results").innerHTML, markup);
  f.picker.resume(); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].options.signal.aborted, false);
  f.picker.dispose();
});

test("superseded GIF results cannot overwrite the newest search", async (t) => {
  const f = pickerFixture(t); f.el("gif-tab").dispatch("click");
  f.el("media-search").value = "new"; f.el("media-search").dispatch("input"); f.runTimers();
  assert.equal(f.requests[0].options.signal.aborted, true);
  const response = (title) => ({ ok: true, json: async () => ({ data: [{ id: title, title, images: { fixed_width: { url: `${title}.gif` } } }] }) });
  f.requests[1].resolve(response("Newest")); await flush(); f.requests[0].resolve(response("Obsolete")); await flush();
  assert.match(f.el("gif-results").innerHTML, /Newest/); assert.doesNotMatch(f.el("gif-results").innerHTML, /Obsolete/);
  f.picker.dispose();
});

test("picker pause preserves selected GIF and composer draft and disables document interaction", (t) => {
  const f = pickerFixture(t); f.el("message-input").value = "my draft";
  const tile = { dataset: { gifId: "selected", gifTitle: "Selected", gifPreview: "preview.gif", gifSent: "" }, closest() { return this; } };
  f.el("gif-results").dispatch("click", { target: tile });
  f.picker.pause(); const changes = f.changes();
  f.el("gif-results").dispatch("click", { target: { ...tile, dataset: { ...tile.dataset, gifId: "ignored" } } });
  assert.deepEqual(f.picker.selection(), { gif_id: "selected", gif_query: "" }); assert.equal(f.changes(), changes);
  f.picker.resume(); assert.equal(f.picker.hasSelection(), true); assert.equal(f.el("message-input").value, "my draft");
  f.picker.dispose(); assert.equal(f.listenerCount(), 0);
});

for (const transition of ["pause", "dispose"]) {
  test(`GIF tracking aborts on ${transition} and releases its late rejection`, async (t) => {
    const f = pickerFixture(t);
    const tile = { dataset: { gifId: "selected", gifTitle: "Selected", gifPreview: "preview.gif", gifSent: "https://example.test/sent" }, closest() { return this; } };
    f.el("gif-results").dispatch("click", { target: tile }); f.picker.clear(true);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "https://example.test/sent");
    assert.equal(f.requests[0].options.signal.aborted, false);
    f.picker[transition](); assert.equal(f.requests[0].options.signal.aborted, true);
    const changes = f.changes();
    f.requests[0].reject(new globalThis.DOMException("Aborted", "AbortError")); await flush();
    assert.equal(f.changes(), changes); assert.equal(f.picker.hasSelection(), false);
    f.picker.dispose(); assert.equal(f.listenerCount(), 0);
  });
}

test("emoji trigger hover changes and restores its smile across media lifecycle", (t) => {
  const f = pickerFixture(t); const classes = new Set(["material-symbols-outlined"]);
  const icon = { textContent: "sentiment_satisfied", classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  f.el("media-button").querySelector = (selector) => selector === ".chat-hover-smile" && !classes.has("chat-hover-smile") ? null : icon;
  let sample = 0;
  t.mock.method(Math, "random", () => sample / 5);
  for (const smile of ["😀", "😄", "😊", "🤩", "🥳"]) {
    f.el("media-button").dispatch("pointerenter"); assert.equal(icon.textContent, smile);
    assert.equal(classes.has("material-symbols-outlined"), false); assert.equal(classes.has("chat-hover-smile"), true);
    f.el("media-button").dispatch("pointerleave"); assert.equal(icon.textContent, "sentiment_satisfied");
    assert.equal(classes.has("material-symbols-outlined"), true); assert.equal(classes.has("chat-hover-smile"), false);
    sample += 1;
  }
  sample = 0;
  f.el("media-button").dispatch("pointerenter");
  const firstSmile = icon.textContent;
  f.el("media-button").dispatch("pointerleave"); assert.equal(icon.textContent, "sentiment_satisfied");
  f.el("media-button").dispatch("pointerenter"); assert.notEqual(icon.textContent, firstSmile);
  f.picker.pause(); assert.equal(icon.textContent, "sentiment_satisfied");
  f.el("media-button").dispatch("pointerenter"); assert.equal(icon.textContent, "sentiment_satisfied");
  f.picker.resume(); f.el("media-button").dispatch("pointerenter"); assert.equal(classes.has("chat-hover-smile"), true);
  f.picker.dispose(); assert.equal(icon.textContent, "sentiment_satisfied"); assert.equal(f.listenerCount(), 0);
});

test("message download listeners pause, resume, and are removed on dispose", (t) => {
  const f = fixture(t); const media = createMessageMedia(); media.init();
  const target = { closest: () => ({ dataset: { chatDownload: "/download", chatFilename: "file.pdf" } }) };
  f.el("messages").dispatch("click", { target }); assert.equal(f.el("download-warning").open, true);
  media.pause(); assert.equal(f.el("download-warning").open, false);
  f.el("messages").dispatch("click", { target }); assert.equal(f.el("download-warning").open, false);
  media.resume(); f.el("messages").dispatch("click", { target }); assert.equal(f.el("download-warning").open, true);
  media.dispose(); assert.equal(f.listenerCount(), 0); assert.equal(f.el("download-warning").open, false);
});

test("real runtime owns pending tray visibility from extension state and forwards media lifecycle", async (t) => {
  const f = fixture(t); let context; let hasFiles = false; let hasGif = false; const transitions = [];
  const owner = (name) => ({ init(value) { if (value) context = value; }, pause() { transitions.push(`${name}:pause`); }, resume() { transitions.push(`${name}:resume`); }, dispose() { transitions.push(`${name}:dispose`); } });
  const attachments = { ...owner("attachments"), hasContent: () => hasFiles, isBusy: () => false, readyIds: () => [] };
  const mediaPicker = { ...owner("picker"), hasSelection: () => hasGif };
  startChatRuntime({ attachments, mediaPicker, messageMedia: owner("messages") });
  t.after(() => f.lifecycle()?.dispose());
  const tray = f.el("pending-files");
  for (const [files, gif] of [[false, false], [true, false], [true, true], [false, true], [false, false]]) {
    hasFiles = files; hasGif = gif; context.onComposerChange(); assert.equal(tray.hidden, !files && !gif);
  }
  f.lifecycle().pause(); f.lifecycle().pause(); f.lifecycle().resume(); f.lifecycle().dispose(); f.lifecycle().resume();
  assert.deepEqual(transitions, ["attachments:pause", "picker:pause", "messages:pause", "attachments:resume", "picker:resume", "messages:resume", "attachments:dispose", "picker:dispose", "messages:dispose"]);
  await flush();
});

test("attachment and GIF views leave the shared tray visible until both are empty", async (t) => {
  const f = fixture(t); const upload = deferred();
  f.window.APStudyHttp.uploadXhr = () => upload.promise;
  const attachments = createAttachmentManager(); const mediaPicker = createMediaPicker();
  startChatRuntime({ attachments, mediaPicker }); t.after(() => f.lifecycle()?.dispose());
  f.window.NestChat.activeRoom = { type: "channel", id: "general" };
  attachments.configure({ attachments: true });
  const tile = { dataset: { gifId: "selected", gifTitle: "Selected", gifPreview: "preview.gif", gifSent: "" }, closest() { return this; } };
  f.el("gif-results").dispatch("click", { target: tile }); assert.equal(f.el("pending-files").hidden, false);
  const file = new Blob(["draft"]); file.name = "notes.txt"; f.el("file-input").files = [file]; f.el("file-input").dispatch("change"); await flush();
  mediaPicker.clear(); assert.equal(f.el("pending-files").hidden, false);
  f.el("gif-results").dispatch("click", { target: tile });
  attachments.clear(); assert.equal(f.el("pending-files").hidden, false);
  mediaPicker.clear(); assert.equal(f.el("pending-files").hidden, true);
  upload.resolve({ status: 200, response: { attachment: { id: "removed" } } }); await flush();
  assert.equal(f.el("pending-files").hidden, true);
});
