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
const deferred = () => Promise.withResolvers();
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(setImmediate); };
const source = (id = 'old') => ({ spotify_url: `https://open.spotify.com/playlist/${id}`, embed_url: `https://open.spotify.com/embed/playlist/${id}` });

class Node extends EventTarget {
  constructor(tagName = 'div') { super(); this.tagName = tagName; }
  children = [];
  dataset = {};
  style = { setProperty() {}, removeProperty() {} };
  hidden = false;
  classes = new Set();
  classList = { add: (...values) => values.forEach((v) => this.classes.add(v)), remove: (...values) => values.forEach((v) => this.classes.delete(v)), contains: (v) => this.classes.has(v), toggle: () => {} };
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) { return this.children.find((node) => selector.includes(node.tagName) || (selector.includes('focus-spotify-controller') && node.className === 'focus-spotify-controller')) || null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  removeAttribute(name) { if (name === 'data-player-state') delete this.dataset.playerState; }
  hasAttribute() { return false; }
  insertAdjacentElement(_position, node) { this.assist = node; }
  remove() { this.removed = true; }
}

async function harness(kind, { importGate = null, actualPlayer = false } = {}) {
  const host = new Node();
  const body = new Node();
  const timers = new Map();
  const retired = [];
  const calls = [];
  const loads = [];
  let timerId = 0;
  const window = new EventTarget();
  Object.assign(window, {
    innerWidth: 1200, innerHeight: 900, localStorage: { getItem: () => null },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { if (timers.has(id)) retired.push(timers.get(id)); timers.delete(id); },
  });
  const document = {
    body, head: new Node('head'), createComment: () => new Node(), createElement: (tag) => new Node(tag),
    createElementNS: (_namespace, tag) => new Node(tag), querySelectorAll: () => [], getElementById: () => null,
    querySelector(selector) {
      if (selector === '[data-focus-spotify-embed]') return host;
      if (selector === 'link[data-focus-lazy-styles]') return { dataset: { loaded: 'true' }, sheet: {} };
      if (selector === '[data-focus-player-assist]') return host.assist;
      return null;
    },
  };
  const context = vm.createContext({ window, document, URL, AbortController, CustomEvent: globalThis.CustomEvent, console, Date });
  const player = {
    currentUrl: '',
    load(url, embed, options) { const pending = deferred(); loads.push({ ...pending, url, embed, options }); return pending.promise; },
    pause() { calls.push(['pause']); }, resume() { calls.push(['resume']); },
    clear() { calls.push(['clear']); this.currentUrl = ''; }, dispose() { calls.push(['dispose']); },
  };
  const runtime = {
    activate(nextSource, options) { const pending = deferred(); loads.push({ ...pending, source: nextSource, options }); return pending.promise; },
    applyPreferences: (preferences) => calls.push(['preferences', preferences]),
    pause: () => calls.push(['pause']), clear: () => calls.push(['clear']), dispose: () => calls.push(['dispose']),
  };
  const modules = new Map();
  const focusPath = (name) => path.join(root, 'static/js/focus', name);
  function synthetic(name, exports) {
    modules.set(focusPath(name), new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context }));
  }
  if (kind === 'view' && !actualPlayer) synthetic('music-runtime.js', { createMusicRuntime: () => { calls.push(['createRuntime']); return runtime; } });
  if (kind === 'runtime' || (kind === 'view' && actualPlayer)) {
    synthetic('music-layout.js', { createMusicLayout: () => ({ applyPreferences() {}, setLayout() {}, dispose() {} }) });
    if (!actualPlayer) synthetic('music-player.js', { createMusicPlayer: () => { calls.push(['createPlayer']); return player; } });
  }
  async function load(fullPath) {
    if (modules.has(fullPath)) return modules.get(fullPath);
    const module = new vm.SourceTextModule(await readFile(fullPath, 'utf8'), { context, identifier: fullPath,
      importModuleDynamically: async (specifier, owner) => {
        if (importGate) await importGate.promise;
        const dependency = await load(path.resolve(path.dirname(owner.identifier), specifier));
        if (dependency.status === 'unlinked') await dependency.link(link);
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    modules.set(fullPath, module); return module;
  }
  const link = (specifier, owner) => load(path.resolve(path.dirname(owner.identifier), specifier));
  const entry = await load(focusPath(kind === 'runtime' ? 'music-runtime.js' : kind === 'player' ? 'music-player.js' : 'view.js'));
  await entry.link(link); await entry.evaluate();
  const owner = kind === 'runtime' ? entry.namespace.createMusicRuntime({ elements: { playerHost: host } })
    : kind === 'player' ? entry.namespace.createMusicPlayer(host)
      : entry.namespace.createFocusView({ notify: (value) => calls.push(['notify', value]) });
  return { owner, window, host, timers, retired, calls, loads, player,
    runTimers(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
  };
}

if (!vm.SourceTextModule) {
  test('Focus public music activation lifetime contracts', async () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=tap', filename], { env, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /# fail 0/);
  });
} else {
  for (const kind of ['runtime', 'view']) {
    for (const boundary of ['pause', 'clear', 'dispose', 'abort', 'replace']) {
      for (const outcome of ['success', 'rejection']) {
        test(`${kind} public activation late ${outcome} stays inert after ${boundary}`, async () => {
          const h = await harness(kind);
          const controller = new AbortController();
          if (kind === 'view') { h.owner.renderPlaylists(source()); await settle(); }
          const operation = kind === 'view' ? h.owner.activateMusic({ autoplay: true, signal: controller.signal }) : h.owner.activate(source(), { autoplay: true, signal: controller.signal });
          await settle();
          const load = h.loads.at(-1);
          assert.ok(load);
          assert.equal(load.options.signal.aborted, false);
          if (boundary === 'abort') controller.abort();
          else if (boundary === 'replace') {
            if (kind === 'view') h.owner.renderPlaylists(source('new'));
            else void h.owner.activate(source('new'));
            await settle();
          } else h.owner[kind === 'view' ? `${boundary === 'dispose' ? 'dispose' : `${boundary}Music`}` : boundary]();
          assert.equal(load.options.signal.aborted, true);
          const before = h.calls.length;
          const state = h.host.dataset.playerState;
          if (outcome === 'success') load.resolve(true); else load.reject(new Error('obsolete load'));
          assert.equal(await operation, false);
          await settle();
          h.retired.forEach(({ fn }) => fn());
          assert.equal(h.calls.length, before, 'obsolete activation cannot resume or notify');
          assert.equal(h.host.dataset.playerState, state, 'obsolete activation cannot overwrite current host feedback');
        });
      }
    }
    for (const boundary of ['pause', 'clear', 'dispose', 'abort']) {
      test(`${kind} ${boundary} cancels lazy import before a runtime or player is created`, async () => {
        const gate = deferred();
        const h = await harness(kind, { importGate: gate });
        const controller = new AbortController();
        if (kind === 'view') h.owner.renderPlaylists(source());
        const operation = kind === 'view' ? h.owner.activateMusic({ signal: controller.signal }) : h.owner.activate(source(), { signal: controller.signal });
        if (boundary === 'abort') controller.abort();
        else h.owner[kind === 'view' ? (boundary === 'dispose' ? 'dispose' : `${boundary}Music`) : boundary]();
        gate.resolve();
        assert.equal(await operation, false);
        assert.equal(h.loads.length, 0);
        assert.equal(h.calls.some(([name]) => name === 'createPlayer' || name === 'createRuntime'), false);
      });
    }
  }

  test('current view activation retains ready feedback and cancels loading/assist timers on pause', async () => {
    const h = await harness('view');
    h.owner.renderPlaylists(source()); await settle();
    const operation = h.owner.activateMusic({ autoplay: true }); await settle();
    h.runTimers(100);
    assert.equal(h.host.classList.contains('is-player-loading'), true);
    h.loads.at(-1).resolve(true);
    assert.equal(await operation, true);
    assert.equal(h.host.dataset.playerState, 'ready');
    assert.equal(h.host.classList.contains('is-player-loading'), false);
    h.runTimers(1000);
    assert.ok(h.host.assist);
    assert.equal(h.timers.size, 1);
    h.owner.pauseMusic();
    assert.equal(h.timers.size, 0);
    assert.equal(h.host.assist.removed, true);
    const before = h.calls.length;
    h.retired.forEach(({ fn }) => fn());
    assert.equal(h.calls.length, before);
  });

  test('current view loading failure still shows feedback; resumed generation accepts its new activation', async () => {
    const h = await harness('view');
    h.owner.renderPlaylists(source()); await settle();
    h.loads.at(-1).reject(new Error('Current failure')); await settle();
    assert.equal(h.calls.filter(([name]) => name === 'notify').length, 1);
    assert.equal(h.host.dataset.playerState, 'deferred');
    h.owner.pauseMusic();
    h.owner.resumeMusic(); await settle();
    h.loads.at(-1).resolve(true); await settle();
    assert.equal(h.host.dataset.playerState, 'ready');
    assert.equal(h.loads.at(-1).options.autoplay, true);
  });

  for (const kind of ['runtime', 'view']) {
    test(`${kind} caller signal continues to own accepted playback`, async () => {
      const h = await harness(kind);
      const signal = new AbortController();
      if (kind === 'view') { h.owner.renderPlaylists(source()); await settle(); }
      const operation = kind === 'view' ? h.owner.activateMusic({ autoplay: true, signal: signal.signal }) : h.owner.activate(source(), { autoplay: true, signal: signal.signal });
      await settle();
      h.loads.at(-1).resolve(true);
      assert.equal(await operation, true);
      const before = h.calls.filter(([name]) => name === 'pause').length;
      signal.abort();
      assert.equal(h.calls.filter(([name]) => name === 'pause').length, before + 1);
      if (kind === 'view') assert.equal(h.timers.size, 0);
    });
  }

  for (const boundary of ['pause', 'clear', 'dispose', 'abort']) {
    for (const readiness of ['sdk', 'controller']) {
      test(`actual runtime/player delayed ${readiness} is canceled by ${boundary}`, async () => {
        const h = await harness('runtime', { actualPlayer: true });
        const sdk = deferred();
        let controllerReady;
        const api = { createController(_mount, _options, ready) { controllerReady = ready; } };
        h.window.__apstudySpotifyIframeApi = readiness === 'sdk' ? { promise: sdk.promise } : { api };
        const signal = new AbortController();
        const operation = h.owner.activate(source(), { autoplay: true, signal: signal.signal });
        await settle();
        if (boundary === 'abort') signal.abort(); else h.owner[boundary]();
        const children = [...h.host.children];
        let resumes = 0, destroys = 0;
        if (readiness === 'sdk') sdk.resolve(api);
        else controllerReady({ resume() { resumes += 1; }, destroy() { destroys += 1; } });
        assert.equal(await operation, false);
        await settle();
        assert.equal(resumes, 0, 'late Spotify controller cannot autoplay');
        assert.deepEqual(h.host.children, children, 'late SDK does not mount player content');
        assert.equal(h.timers.size, 0, 'controller readiness timeout is canceled');
        if (readiness === 'controller') assert.equal(destroys, 1);
      });
    }
  }

  test('actual runtime/player successful activation pauses and resumes after a cached-page return', { timeout: 5000 }, async () => {
    const h = await harness('runtime', { actualPlayer: true });
    let ready;
    const controllerCreated = deferred();
    let resumes = 0, pauses = 0;
    h.window.__apstudySpotifyIframeApi = { api: { createController(_mount, _options, callback) { ready = callback; controllerCreated.resolve(); } } };
    const operation = h.owner.activate(source(), { autoplay: true });
    await controllerCreated.promise;
    ready({ resume() { resumes += 1; }, pause() { pauses += 1; }, destroy() {} });
    assert.equal(await operation, true);
    assert.equal(resumes, 2, 'accepted controller autoplays and runtime confirms playback');
    h.owner.pause(); assert.equal(pauses, 1);
    assert.equal(h.owner.resume(), true); assert.equal(resumes, 3);
    assert.equal(h.timers.size, 0);
  });

  for (const readiness of ['sdk', 'controller']) {
    test(`actual view/runtime/player cancels delayed ${readiness} and accepts resumed playback`, async () => {
      const h = await harness('view', { actualPlayer: true });
      const sdk = deferred();
      const ready = [];
      let resumes = 0, destroys = 0;
      const api = { createController(_mount, _options, callback) { ready.push(callback); } };
      h.window.__apstudySpotifyIframeApi = readiness === 'sdk' ? { promise: sdk.promise } : { api };
      h.owner.renderPlaylists(source()); await settle();
      const operation = h.owner.activateMusic({ autoplay: true }); await settle();
      const obsoleteReady = ready.at(-1);
      h.owner.pauseMusic();
      assert.equal(await operation, false, 'pause promptly settles a player waiting for SDK or controller');
      if (readiness === 'sdk') {
        h.window.__apstudySpotifyIframeApi = { api };
        sdk.resolve(api);
      } else obsoleteReady({ resume() { resumes += 1; }, destroy() { destroys += 1; } });
      await settle();
      assert.equal(resumes, 0);
      assert.equal(h.calls.filter(([name]) => name === 'notify').length, 0);
      assert.equal(h.host.children.length, 0);
      assert.equal(h.timers.size, 0);
      h.owner.resumeMusic(); await settle();
      ready.at(-1)({ resume() { resumes += 1; }, pause() {}, destroy() { destroys += 1; } });
      await settle();
      assert.equal(resumes, 2);
      assert.equal(h.host.dataset.playerState, 'ready');
      h.owner.dispose();
      h.retired.forEach(({ fn }) => fn());
      assert.equal(h.timers.size, 0);
      assert.ok(destroys >= 1);
    });
  }

  test('actual view/runtime/player can retry the same playlist after a current SDK rejection', async () => {
    const h = await harness('view', { actualPlayer: true });
    const sdk = deferred();
    const sdkRequested = deferred();
    h.window.__apstudySpotifyIframeApi = { get promise() { sdkRequested.resolve(); return sdk.promise; } };
    h.owner.renderPlaylists(source()); await sdkRequested.promise;
    sdk.reject(new Error('SDK unavailable')); await settle();
    assert.equal(h.host.dataset.playerState, 'deferred');
    assert.equal(h.calls.filter(([name]) => name === 'notify').length, 1);
    let ready;
    h.window.__apstudySpotifyIframeApi = { api: { createController(_mount, _options, callback) { ready = callback; } } };
    const operation = h.owner.activateMusic({ autoplay: true }); await settle();
    assert.equal(typeof ready, 'function');
    ready({ resume() {}, destroy() {} });
    assert.equal(await operation, true);
    assert.equal(h.host.dataset.playerState, 'ready');
  });
}
