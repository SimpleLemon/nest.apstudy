import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '../..');
const settle = async () => { for (let index = 0; index < 30; index += 1) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

// Native VM modules keep the actual entry, imports and closure intact. The view
// boundary models animation settlement and records observable effects.
class Events {
  listeners = new Map();
  value = '25';
  hidden = false;
  children = [];
  dataset = {};
  attributes = new Map();
  isConnected = true;
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  before() {}
  after(node) { node.isConnected = true; }
  remove() { this.isConnected = false; }
  querySelectorAll() { return []; }
  addEventListener(type, listener, { signal } = {}) {
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    signal?.addEventListener('abort', () => this.listeners.get(type).delete(listener), { once: true });
  }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  querySelector() { return null; }
}

async function harness({ realView = false, startEntry = true, reducedMotion = false } = {}) {
  const window = new Events();
  const document = new Events();
  document.body = new Events();
  document.getElementById = () => null;
  document.createComment = () => new Events();
  document.cookie = '';
  const calls = [];
  const requests = [];
  const animations = [];
  const timers = new Map();
  const retiredTimers = [];
  const frames = new Map();
  const retiredFrames = [];
  let timerId = 0;
  Object.assign(window, {
    matchMedia: () => ({ matches: reducedMotion }),
    location: { href: 'https://nest.example/focus', origin: 'https://nest.example' },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (timers.has(id)) retiredTimers.push(timers.get(id)); timers.delete(id); },
    APStudyToast: { show: (value) => calls.push(['toast', value]) },
    confirm: () => true,
  });
  const elements = Object.fromEntries(['form', 'focusMinutes', 'cycles', 'deleteRoutine', 'toggle', 'completePhase', 'end', 'loading', 'setup'].map((key) => [key, new Events()]));
  Object.assign(elements, { optionsOpen: [], layoutInputs: [], saveRoutines: [] });
  if (!realView) {
    for (const key of ['playlistApply', 'playlistRemove', 'playlistUrlInput', 'playlistList', 'routineSelect', 'routineName', 'breakMinutes', 'longBreakMinutes']) elements[key] = new Events();
    elements.routineSelect.value = '';
    elements.routineName.value = 'My routine';
    elements.saveRoutines = [new Events()];
    const layout = new Events();
    layout.value = 'floating'; layout.checked = true;
    elements.layoutInputs = [layout];
    elements.playlistList.children = [{}];
  }
  elements.submit = new Events();
  elements.form.querySelector = () => elements.submit;
  class Notification {
    static permission = 'granted';
    constructor(title) { calls.push(['notification', title]); }
  }
  window.Notification = Notification;
  let view = { elements };
  if (realView) {
    for (const name of ['session', 'egg', 'countdown', 'eggResult', 'time', 'announcer']) elements[name] = new Events();
    const nodes = new Map(Object.entries(elements).map(([name, element]) => [`[data-focus-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`, element]));
    nodes.set('[data-focus-complete-phase]', elements.completePhase);
    nodes.set('[data-focus-delete-routine]', elements.deleteRoutine);
    document.querySelector = (selector) => nodes.get(selector) || null;
    document.getElementById = (id) => ({ 'focus-minutes': elements.focusMinutes, 'focus-cycles': elements.cycles })[id] || null;
  }
  for (const name of ['showMode', 'renderHistory', 'renderRecent', 'renderRoutines', 'renderSuggestions', 'syncTimeSuggestionPressed', 'syncRhythmVisibility', 'renderPlaylists', 'renderSession', 'renderTick', 'resetEgg', 'pauseMusic', 'resumeMusic', 'announce', 'setBusy', 'setSessionBusy', 'dispose', 'applyPlayerPreferences', 'setPlaylistBusy', 'activateMusic', 'fillRoutine', 'setSettingsStatus']) {
    view[name] = (...args) => calls.push([name, ...args]);
  }
  view.playEggOpening = (phase) => { calls.push(['playEggOpening', phase]); const animation = deferred(); animations.push(animation); return animation.promise; };
  view.syncPlaylistControls = () => 'https://open.spotify.com/playlist/new';
  const preferenceSaves = [];
  let viewOptions;
  view.setMusicLayout = (layout) => {
    const operation = viewOptions.savePlayerPreferences({ layout });
    preferenceSaves.push(operation);
    operation.catch((error) => calls.push(['preferenceError', error]));
  };
  class FormData {
    get(name) { return ({ name: elements.routineName?.value, focus_minutes: '25', cycles: '1' })[name] || ''; }
  }
  const context = vm.createContext({ window, document, console, URL, AbortController, queueMicrotask,
    FormData, Headers, Error,
    performance: { now: () => 1000 }, Date, Notification,
    requestAnimationFrame: (callback) => { const id = ++timerId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => { if (frames.has(id)) retiredFrames.push(frames.get(id)); frames.delete(id); },
    fetch: (url, options) => { const pending = deferred(); requests.push({ ...pending, url, options }); return pending.promise; },
  });
  window.fetch = context.fetch;
  vm.runInContext(await readFile(path.join(root, 'static/js/core/http.js'), 'utf8'), context);
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
  vm.runInContext(await readFile(path.join(root, 'static/js/core/global-chrome.js'), 'utf8'), context);
  const modules = new Map();
  const viewPath = path.join(root, 'static/js/focus/view.js');
  if (!realView) modules.set(viewPath, new vm.SyntheticModule(['createFocusView'], function () { this.setExport('createFocusView', (options) => { viewOptions = options; return view; }); }, { context }));
  async function load(fullPath) {
    if (modules.has(fullPath)) return modules.get(fullPath);
    const module = new vm.SourceTextModule(await readFile(fullPath, 'utf8'), {
      context, identifier: fullPath,
      importModuleDynamically: async (specifier, owner) => {
        const dependency = await load(path.resolve(path.dirname(owner.identifier), specifier));
        if (dependency.status === 'unlinked') await dependency.link(link);
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    modules.set(fullPath, module);
    return module;
  }
  async function link(specifier, owner) { return load(path.resolve(path.dirname(owner.identifier), specifier)); }
  const entry = await load(startEntry ? path.join(root, 'static/js/focus/index.js') : viewPath);
  await entry.link(link);
  await entry.evaluate();
  if (!startEntry) view = entry.namespace.createFocusView();
  const respond = (request, payload) => request.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => payload });
  return { window, document, calls, requests, animations, timers, retiredTimers, frames, retiredFrames, elements, respond, view, preferenceSaves,
    hide(persisted) { window.emit('pagehide', { persisted }); },
    show() { window.emit('pageshow', { persisted: true }); },
  };
}

const session = (overrides = {}) => ({ id: 'focus-1', phase: 'focus', state: 'running', remaining_seconds: 60, playlists: [], ...overrides });
const snapshot = (active_session) => ({ active_session, history: [], recent_selections: [] });
const completion = (next) => ({ active: Boolean(next), session: next });

if (!vm.SourceTextModule) {
  test('focus registered lifecycle and phase behavior', async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=tap', filename], { env, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /# fail 0/);
  });
} else {
  const oldPlaylist = 'https://open.spotify.com/playlist/original';
  const newPlaylist = 'https://open.spotify.com/playlist/new';
  const routine = { id: 'routine-1', name: 'Original routine', focus_minutes: 25, cycles: 1 };
  const library = (url = oldPlaylist) => ({ spotify_url: url, playlists: [{ spotify_url: url, title: 'Playlist' }] });
  const pageSnapshot = (active = false) => ({
    ...snapshot(active ? session({ ...library() }) : null),
    routines: [routine], playlists: library().playlists, active_playlist_url: oldPlaylist,
  });
  const drivers = {
    'playlist apply': async (h) => h.elements.playlistApply.emit('click'),
    'playlist removal': async (h) => h.elements.playlistRemove.emit('click', { detail: 0 }),
    'playlist selection': async (h) => {
      h.document.emit('focus:playlist-list-rendered', { detail: { hasItems: true } });
      const deadline = Date.now() + 2000;
      while (!h.elements.playlistList.listeners.get('click')?.size && Date.now() < deadline) await new Promise(setImmediate);
      assert.ok(h.elements.playlistList.listeners.get('click')?.size, 'lazy gesture owner installed its public listener');
      h.elements.playlistList.emit('click', { target: { closest: (selector) => selector === '[data-spotify-playlist]' ? { dataset: { spotifyPlaylist: newPlaylist } } : null } });
    },
    'routine create': async (h) => h.elements.saveRoutines[0].emit('click'),
    'routine update': async (h) => { h.elements.routineSelect.value = routine.id; h.elements.saveRoutines[0].emit('click'); },
    'routine deletion': async (h) => { h.elements.routineSelect.value = routine.id; h.elements.deleteRoutine.emit('click'); },
    'player preferences': async (h) => h.elements.layoutInputs[0].emit('change'),
    'playlist undo': async (h) => {
      h.elements.playlistRemove.emit('click', { detail: 0 });
      await settle();
      h.respond(h.requests.at(-1), { ...library(newPlaylist), session: session({ ...library(newPlaylist) }) });
      await settle();
      h.calls.filter(([name]) => name === 'toast').at(-1)[1].action.onClick();
    },
    'new routine undo': async (h) => {
      h.elements.saveRoutines[0].emit('click');
      await settle();
      h.respond(h.requests.at(-1), { routine: { ...routine, id: 'new-routine' } });
      await settle();
      h.calls.filter(([name]) => name === 'toast').at(-1)[1].action.onClick();
    },
    'updated routine undo': async (h) => {
      h.elements.routineSelect.value = routine.id;
      h.elements.saveRoutines[0].emit('click');
      await settle();
      h.respond(h.requests.at(-1), { routine: { ...routine, name: 'Updated routine' } });
      await settle();
      h.calls.filter(([name]) => name === 'toast').at(-1)[1].action.onClick();
    },
  };

  for (const [owner, invoke] of Object.entries(drivers)) {
    test(`actual ${owner} accepts current results and forwards its lifetime signal`, async () => {
      const h = await harness();
      h.respond(h.requests[0], pageSnapshot());
      await settle();
      await invoke(h);
      await settle();
      const request = h.requests.at(-1);
      assert.equal(request.options.signal, h.requests[0].options.signal);
      assert.equal(request.options.signal.aborted, false);
      assert.equal(request.options.credentials, 'same-origin');
      assert.equal(request.options.headers['X-CSRFToken'], undefined, 'the shared CSRF owner omits an absent token');
      const before = h.calls.length;
      h.respond(request, { ...library(owner === 'playlist undo' ? oldPlaylist : newPlaylist), routine: { ...routine, name: 'Saved routine' }, layout: 'floating' });
      await settle();
      if (owner === 'player preferences') {
        assert.equal((await h.preferenceSaves.at(-1)).layout, 'floating');
      } else if (owner !== 'routine deletion') {
        assert.ok(h.calls.length > before, 'current accepted results still update the page');
      }
      assert.equal(h.requests.length, owner.endsWith('undo') ? 3 : 2);
    });
    for (const active of owner.startsWith('playlist') ? [true, false] : [false]) {
      for (const persisted of [true, false]) {
        for (const outcome of ['success', 'rejection']) {
          test(`actual ${owner} ${active ? 'session' : 'library'} late ${outcome} is inert after ${persisted ? 'BFCache restore' : 'disposal'}`, async () => {
            const h = await harness();
            h.respond(h.requests[0], pageSnapshot(active));
            await settle();
            await invoke(h);
            await settle();
            const pending = h.requests.at(-1);
            assert.notEqual(pending, h.requests[0], 'the installed public handler starts a mutation');
            assert.equal(pending.options.signal.aborted, false);
            h.hide(persisted);
            assert.equal(pending.options.signal.aborted, true, 'page lifetime owns the mutation signal');
            if (persisted) {
              h.show();
              h.respond(h.requests.at(-1), pageSnapshot(active));
              await settle();
              h.elements.playlistApply.emit('click');
              await settle();
              assert.equal(h.requests.at(-1).options.signal.aborted, false);
            }
            const before = h.calls.length;
            const requestCount = h.requests.length;
            if (outcome === 'rejection') pending.reject(new Error('obsolete mutation failure'));
            else h.respond(pending, { ...library(), session: session(), routine: { ...routine, name: 'Obsolete response' } });
            await settle();
            assert.equal(h.calls.length, before, 'late results do not render, activate music, toast, or clear restored busy state');
            assert.equal(h.requests.length, requestCount, 'late results do not start chained requests');
            if (persisted) {
              h.respond(h.requests.at(-1), { ...library(newPlaylist), session: session({ ...library(newPlaylist) }) });
              await settle();
              assert.ok(h.calls.length > before, 'the restored generation still accepts its current mutation');
            }
          });
        }
      }
    }
  }

  for (const undo of [false, true]) {
    for (const persisted of [false, true]) {
      for (const outcome of ['success', 'rejection']) {
        test(`playlist ${undo ? 'restore' : 'add'} chained activation ${outcome} stays inert after ${persisted ? 'restore' : 'dispose'}`, async () => {
          const h = await harness();
          h.respond(h.requests[0], pageSnapshot());
          await settle();
          if (undo) await drivers['playlist undo'](h);
          else h.elements.playlistApply.emit('click');
          await settle();
          const first = h.requests.at(-1);
          h.respond(first, library('https://open.spotify.com/playlist/other'));
          await settle();
          const second = h.requests.at(-1);
          assert.notEqual(second, first);
          assert.equal(second.url, '/api/focus/playlists/active');
          assert.equal(second.options.signal, first.options.signal);
          assert.equal(JSON.parse(second.options.body).spotify_url, undo ? oldPlaylist : newPlaylist);
          h.hide(persisted);
          assert.equal(second.options.signal.aborted, true);
          if (persisted) {
            h.show(); h.respond(h.requests.at(-1), pageSnapshot()); await settle();
          }
          const before = h.calls.length;
          if (outcome === 'rejection') second.reject(new Error('late activation'));
          else h.respond(second, library());
          await settle();
          assert.equal(h.calls.length, before);
        });
      }
    }
  }

  for (const owner of ['playlist removal', 'routine create', 'routine update']) {
    test(`${owner} Undo callback cannot mutate a later BFCache generation`, async () => {
      const h = await harness();
      h.respond(h.requests[0], pageSnapshot()); await settle();
      await drivers[owner](h); await settle();
      h.respond(h.requests.at(-1), { ...library(newPlaylist), routine: { ...routine, id: owner === 'routine create' ? 'new-routine' : routine.id } });
      await settle();
      const undo = h.calls.filter(([name]) => name === 'toast').at(-1)[1].action;
      assert.equal(undo.label, 'Undo');
      h.hide(true); h.show(); h.respond(h.requests.at(-1), pageSnapshot()); await settle();
      const before = h.calls.length;
      const requestCount = h.requests.length;
      undo.onClick(); await settle();
      assert.equal(h.calls.length, before);
      assert.equal(h.requests.length, requestCount);
    });
  }

  for (const persisted of [true, false]) {
    test(`routine deletion confirmation is canceled by ${persisted ? 'BFCache pause' : 'disposal'}`, async () => {
      const h = await harness();
      h.respond(h.requests[0], pageSnapshot()); await settle();
      const confirm = deferred();
      h.window.APStudyConfirm = { request: () => confirm.promise };
      h.elements.routineSelect.value = routine.id;
      h.elements.deleteRoutine.emit('click');
      h.hide(persisted);
      const before = h.calls.length;
      confirm.resolve(true); await settle();
      assert.equal(h.calls.length, before);
      assert.equal(h.requests.length, 1);
    });
  }

  test('staged routine deletion keeps pagehide commit durable while stale restore stays inert', async () => {
    const h = await harness();
    h.respond(h.requests[0], pageSnapshot()); await settle();
    let staged;
    h.window.APStudyUndo = { stage: (options) => { staged = options; } };
    h.elements.routineSelect.value = routine.id;
    h.elements.deleteRoutine.emit('click'); await settle();
    assert.equal(h.requests.length, 1, 'deletion stays staged during its Undo window');
    h.hide(false);
    const before = h.calls.length;
    staged.restore();
    assert.equal(h.calls.length, before);
    const committed = staged.commit({ reason: 'pagehide' });
    assert.equal(h.requests.at(-1).options.keepalive, true);
    assert.equal(h.requests.at(-1).options.signal, undefined, 'durable pagehide flush cannot use an aborted page signal');
    h.respond(h.requests.at(-1), {}); await committed; await settle();
    assert.equal(h.calls.length, before);
  });

  test('current player preference failure is reported; obsolete failures stay silent', async () => {
    const h = await harness();
    h.respond(h.requests[0], pageSnapshot()); await settle();
    h.elements.layoutInputs[0].emit('change');
    h.requests.at(-1).reject(new Error('Account sync failed')); await settle();
    assert.equal(h.calls.filter(([name]) => name === 'toast').at(-1)[1].title, 'Couldn’t save player preferences');
    assert.equal(h.calls.filter(([name]) => name === 'preferenceError').length, 0, 'installed change handler does not leave an unhandled rejection');
  });

  for (const persisted of [true, false]) {
    for (const outcome of ['success', 'rejection']) {
      test(`late initial load ${outcome} is inert after ${persisted ? 'pause' : 'dispose'}`, async () => {
        const h = await harness();
        const request = h.requests[0];
        h.hide(persisted);
        assert.equal(request.options.signal.aborted, true);
        const before = h.calls.length;
        if (outcome === 'success') h.respond(request, snapshot(session()));
        else request.reject(new Error('offline'));
        await settle();
        assert.equal(h.calls.length, before);
        assert.equal(h.timers.size, 0);
      });
    }
  }

  for (const action of ['advance', 'complete_phase']) {
    for (const boundary of ['request', 'animation', 'history']) {
      for (const persisted of [true, false]) {
        for (const outcome of ['success', 'rejection']) {
          test(`${action} late ${boundary} ${outcome} cannot act after ${persisted ? 'pause' : 'dispose'}`, async () => {
            const h = await harness();
            h.respond(h.requests[0], snapshot(session({ remaining_seconds: action === 'advance' ? 0 : 60 })));
            await settle();
            if (action === 'complete_phase') h.elements.completePhase.emit('click');
            await settle();
            assert.equal(JSON.parse(h.requests[1].options.body).action, action);
            let pending = h.requests[1];
            if (boundary !== 'request') {
              h.respond(pending, completion(session({ phase: 'break' })));
              await settle();
              pending = h.animations[0];
            }
            if (boundary === 'history') {
              pending.resolve();
              await settle();
              pending = h.requests[2];
            }
            const oldTick = [...h.retiredTimers, ...h.timers.values()];
            h.hide(persisted);
            const before = h.calls.length;
            if (outcome === 'rejection') pending.reject(new Error('late failure'));
            else if (boundary === 'animation') pending.resolve();
            else h.respond(pending, boundary === 'request' ? completion(null) : snapshot(null));
            await settle();
            oldTick.forEach(({ callback }) => callback());
            h.window.emit('online');
            h.document.hidden = true;
            h.document.emit('visibilitychange');
            await settle();
            assert.equal(h.calls.length, before, 'late work does not render, announce, resume music, or clear newer busy state');
            assert.equal(h.timers.size, 0, 'late rejection cannot create the 15 second retry');
            assert.equal(h.requests.length, boundary === 'history' ? 3 : 2);
          });
        }
      }
    }
  }

  for (const boundary of ['request', 'animation']) {
    for (const outcome of ['success', 'rejection']) {
      test(`BFCache restore reconciles server state while obsolete ${boundary} ${outcome} stays inert`, async () => {
        const h = await harness();
        h.respond(h.requests[0], snapshot(session({ remaining_seconds: 0 })));
        await settle();
        let pending = h.requests[1];
        if (boundary === 'animation') {
          h.respond(pending, completion(session({ phase: 'break' })));
          await settle();
          pending = h.animations[0];
        }
        h.hide(true);
        h.show();
        await settle();
        const restoredRequest = h.requests.at(-1);
        assert.equal(restoredRequest.options.signal.aborted, false);
        h.respond(restoredRequest, snapshot(session({ id: 'restored', phase: 'break' })));
        await settle();
        const before = h.calls.length;
        if (outcome === 'rejection') pending.reject(new Error('obsolete'));
        else if (boundary === 'animation') pending.resolve();
        else h.respond(pending, completion(null));
        await settle();
        assert.equal(h.calls.length, before);
        assert.equal(h.timers.size, 1);
        assert.equal(h.calls.filter(([name]) => name === 'renderSession').at(-1)[1].id, 'restored');
      });
    }
  }

  for (const next of [null, session({ phase: 'break', state: 'paused' }), session({ phase: 'break' }), session({ phase: 'focus' })]) {
    test(`automatic and manual completion share accepted ${next ? `${next.phase}/${next.state}` : 'completed'} effects`, async () => {
      const results = [];
      for (const action of ['advance', 'complete_phase']) {
        const h = await harness();
        h.respond(h.requests[0], snapshot(session({ remaining_seconds: action === 'advance' ? 0 : 60 })));
        await settle();
        if (action === 'complete_phase') h.elements.completePhase.emit('click');
        await settle();
        h.elements.submit.emit('pointerdown');
        await settle();
        const before = h.calls.length;
        h.respond(h.requests[1], completion(next));
        await settle();
        assert.equal(h.animations.length, 1);
        assert.equal(h.calls.filter(([name]) => name === 'notification').length, 1, 'accepted phase plays the prepared completion cue');
        assert.equal(h.timers.size, 0, 'the next phase does not tick during completion animation');
        h.animations[0].resolve();
        await settle();
        h.respond(h.requests[2], { history: [{ id: 'completed-phase' }], recent_selections: [{ focus_minutes: 25 }] });
        await settle();
        const effects = h.calls.slice(before).filter(([name]) => ['pauseMusic', 'resumeMusic', 'playEggOpening', 'resetEgg', 'announce', 'renderHistory', 'renderRecent', 'notification'].includes(name));
        results.push(JSON.parse(JSON.stringify(effects)));
        assert.equal(h.calls.filter(([name]) => name === 'resumeMusic').length, next?.phase === 'focus' && next.state === 'running' ? 1 : 0);
        assert.equal(h.timers.size, next?.state === 'running' ? 1 : 0);
        const rendered = h.calls.filter(([name]) => name === 'renderSession').at(-1)[1];
        assert.equal(rendered.state, next?.state || 'completed');
      }
      assert.deepEqual(results[0], results[1]);
    });
  }

  test('automatic failure retries; manual failure reports immediately without phase retry', async () => {
    for (const action of ['advance', 'complete_phase']) {
      const h = await harness();
      h.respond(h.requests[0], snapshot(session({ remaining_seconds: action === 'advance' ? 0 : 60 })));
      await settle();
      if (action === 'complete_phase') h.elements.completePhase.emit('click');
      await settle();
      h.requests[1].reject(new Error('offline'));
      await settle();
      assert.equal(h.calls.filter(([name]) => name === 'toast').at(-1)[1].title, action === 'advance' ? 'Couldn’t sync this phase' : 'Couldn’t update the timer');
      assert.equal([...h.timers.values()].some(({ delay }) => delay === 15000), action === 'advance');
      assert.equal(h.timers.size, 1, 'a manual failure retains the ordinary timer');
      const staleRetry = [...h.timers.values()];
      h.hide(true);
      staleRetry.forEach(({ callback }) => callback());
      await settle();
      assert.equal(h.requests.length, 2);
      assert.equal(h.timers.size, 0);
    }
  });
  for (const persisted of [true, false]) {
    test(`actual view opening cancels its frame and timeout on registered ${persisted ? 'pause' : 'dispose'}`, async () => {
      const h = await harness({ realView: true });
      h.respond(h.requests[0], snapshot(session({ remaining_seconds: 0 })));
      await settle();
      h.respond(h.requests[1], completion(session({ phase: 'break' })));
      await settle();
      assert.equal(h.elements.egg.dataset.eggState, 'opening');
      assert.equal(h.frames.size, 1);
      assert.equal([...h.timers.values()].filter(({ delay }) => delay === 3000).length, 1);
      h.hide(persisted);
      await settle();
      assert.equal(h.frames.size, 0);
      assert.equal(h.timers.size, 0);
      assert.equal(h.elements.egg.dataset.eggState, 'closed');
      const afterPause = h.elements.egg.dataset.eggState;
      h.retiredFrames.forEach((callback) => callback());
      h.retiredTimers.forEach(({ callback }) => callback());
      await settle();
      assert.equal(h.elements.egg.dataset.eggState, afterPause);
      assert.equal(h.requests.length, 2, 'cancelled animation does not refresh history');
      if (persisted) {
        h.show();
        h.respond(h.requests[2], snapshot(session({ phase: 'break' })));
        await settle();
        assert.equal(h.elements.egg.dataset.eggState, 'closed');
        assert.equal(h.timers.size, 1);
        assert.equal(h.document.title, '01:00 · Break');
      }
    });
  }

  test('actual view completion retains opening timeout and finished display', async () => {
    const h = await harness({ realView: true });
    h.respond(h.requests[0], snapshot(session({ remaining_seconds: 0 })));
    await settle();
    h.respond(h.requests[1], completion(null));
    await settle();
    const [[frameId, frame]] = h.frames;
    h.frames.delete(frameId); frame();
    assert.equal(h.elements.egg.dataset.eggState, 'open');
    const [timerId, animation] = [...h.timers].find(([, { delay }]) => delay === 3000);
    h.timers.delete(timerId); animation.callback();
    await settle();
    assert.equal(h.elements.session.getAttribute('data-session-state'), 'completed');
    assert.equal(h.document.title, 'Focus complete - Nest');
    assert.equal(h.elements.egg.dataset.eggState, 'open');
    h.respond(h.requests[2], snapshot(null));
    await settle();
    // Run the announcer's existing delayed live-region update.
    for (const [id, { callback }] of h.timers) { h.timers.delete(id); callback(); }
    assert.equal(h.elements.announcer.textContent, 'Focus routine complete.');
    assert.equal(h.timers.size, 0);
  });

  for (const reducedMotion of [false, true]) {
    test(`actual public view countdown preserves ${reducedMotion ? 'reduced' : 'normal'} motion and cancellation`, async () => {
      const h = await harness({ realView: true, startEntry: false, reducedMotion });
      const controller = new AbortController();
      const pending = h.view.startCountdown({ signal: controller.signal });
      assert.equal(h.elements.countdown.textContent, '3');
      assert.equal([...h.timers.values()][0].delay, reducedMotion ? 120 : 380);
      controller.abort();
      await pending;
      assert.equal(h.elements.countdown.hidden, true);
      assert.equal(h.elements.egg.dataset.eggState, 'closed');
      assert.equal(h.timers.size, 0);
      h.retiredTimers.forEach(({ callback }) => callback());
      assert.equal(h.elements.countdown.textContent, '');
      const normal = h.view.startCountdown();
      while (h.timers.size) {
        const [[id, { callback }]] = h.timers;
        h.timers.delete(id); callback();
      }
      await normal;
      assert.equal(h.elements.egg.dataset.eggState, 'closed');
      assert.equal(h.elements.countdown.hidden, true);
      const opening = h.view.playEggOpening('break');
      h.view.dispose();
      await opening;
      assert.equal(h.timers.size, 0);
      assert.equal(h.frames.size, 0);
      await h.view.playEggOpening('focus');
      assert.equal(h.timers.size, 0);
    });
  }

  for (const persisted of [true, false]) {
    test(`actual completed display announcement and history are canceled on ${persisted ? 'pause' : 'dispose'}`, async () => {
      const h = await harness({ realView: true });
      h.respond(h.requests[0], snapshot(session({ remaining_seconds: 0 })));
      await settle();
      h.respond(h.requests[1], completion(null));
      await settle();
      const [id, animation] = [...h.timers].find(([, { delay }]) => delay === 3000);
      h.timers.delete(id); animation.callback();
      await settle();
      assert.equal(h.frames.size, 0, 'animation timeout is the fallback when no frame arrives');
      assert.equal([...h.timers.values()].some(({ delay }) => delay === 20), true);
      h.hide(persisted);
      h.respond(h.requests[2], { history: [{ id: 'late-history' }] });
      h.retiredFrames.forEach((callback) => callback());
      h.retiredTimers.forEach(({ callback }) => callback());
      await settle();
      assert.equal(h.elements.announcer.textContent, '');
      assert.equal(h.elements.egg.dataset.eggState, persisted ? 'open' : 'closed');
      assert.equal(h.timers.size, 0);
    });
  }

  for (const action of ['pause', 'resume']) {
    for (const outcome of ['success', 'rejection']) {
      test(`timer ${action} ${outcome} keeps its ordinary action policy`, async () => {
        const h = await harness();
        const previousState = action === 'resume' ? 'paused' : 'running';
        h.respond(h.requests[0], snapshot(session({ state: previousState })));
        await settle();
        h.elements.toggle.emit('click');
        await settle();
        assert.equal(JSON.parse(h.requests[1].options.body).action, action);
        assert.equal(h.timers.size, 0, 'ordinary session actions stop ticks while pending');
        if (outcome === 'rejection') h.requests[1].reject(new Error('offline'));
        else h.respond(h.requests[1], completion(session({ state: action === 'pause' ? 'paused' : 'running' })));
        await settle();
        assert.equal(h.animations.length, 0);
        const expectedState = outcome === 'rejection' ? previousState : action === 'pause' ? 'paused' : 'running';
        assert.equal(h.timers.size, expectedState === 'running' ? 1 : 0);
        assert.equal(h.calls.filter(([name]) => name === 'toast').at(-1)[1].title,
          outcome === 'rejection' ? 'Couldn’t update the timer' : action === 'pause' ? 'Timer paused' : 'Timer resumed');
      });
    }
  }

}
