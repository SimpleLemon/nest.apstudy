import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { beforeEach, afterEach } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const httpSource = await readFile(path.join(repoRoot, 'static/js/core/http.js'), 'utf8');
let originalWindow;
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = { fetch: (...args) => globalThis.fetch(...args), FormData };
  vm.runInNewContext(httpSource, { window, URL, FormData, Error });
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({
    window,
  });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
});

async function importSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('focus requests require JSON except for HTTP bodyless success', async () => {
  const { request } = await importSource('static/js/focus/data.js');
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { cookie: '' }, configurable: true });
  try {
    globalThis.fetch = async () => new Response('{"session":{"id":"focus-1"}}');
    assert.deepEqual(await request('/api/focus'), { session: { id: 'focus-1' } });
    for (const body of ['{"session":', '<html>proxy error</html>', '   ', '']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(request('/api/focus'), (error) => {
        assert.match(error.message, /Invalid JSON/);
        assert.equal(error.status, 200);
        assert.equal(error.url, '/api/focus');
        assert.ok(error.response instanceof Response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      });
    }
    for (const status of [204, 205]) {
      globalThis.fetch = async () => new Response(null, { status });
      assert.deepEqual(JSON.parse(JSON.stringify(await request('/api/focus'))), {}, `empty HTTP ${status} response`);
    }
    globalThis.fetch = async () => new Response(null);
    assert.deepEqual(JSON.parse(JSON.stringify(await request('/api/focus', { method: 'head' }))), {});
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});

test('focus HTTP errors preserve server messages and entitlement details', async () => {
  const { request } = await importSource('static/js/focus/data.js');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'Playlist limit reached', code: 'tier_limit', resource: 'playlists', limit: 3, current: 3, requested: 4,
    }), { status: 403 });
    await assert.rejects(request('/api/focus'), (error) => {
      assert.equal(error.message, 'Playlist limit reached');
      assert.equal(error.code, 'tier_limit');
      assert.equal(error.resource, 'playlists');
      assert.equal(error.limit, 3);
      assert.equal(error.current, 3);
      assert.equal(error.requested, 4);
      assert.equal(error.status, 403);
      assert.equal(error.url, '/api/focus');
      assert.ok(error.response instanceof Response);
      assert.equal(error.cause, undefined);
      return true;
    });
    for (const body of ['<html>Bad gateway</html>', 'null', '']) {
      globalThis.fetch = async () => new Response(body, { status: 502 });
      await assert.rejects(request('/api/focus'), (error) => {
        assert.match(error.message, /Focus Mode could not save that change/);
        assert.equal(error.status, 502);
        assert.equal(error.url, '/api/focus');
        assert.ok(error.response instanceof Response);
        if (body !== 'null') assert.ok(error.cause instanceof SyntaxError);
        return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('focus break suggestions are optional, evidence-based, and personalized', async () => {
  const { suggestedBreaks, buildFocusTimeSuggestions } = await importSource('static/js/focus/data.js');
  assert.deepEqual(suggestedBreaks(8), []);
  assert.deepEqual(suggestedBreaks(12), [3, 5]);
  assert.deepEqual(suggestedBreaks(24), [6, 5]);
  assert.deepEqual(suggestedBreaks(25), [5]);
  assert.deepEqual(suggestedBreaks(50, [{ focus_minutes: 50, break_minutes: 8 }]), [8, 10]);
  assert.deepEqual(
    buildFocusTimeSuggestions([]).map(({ focus_minutes, break_minutes, cycles, fromRecent }) => (
      { focus_minutes, break_minutes, cycles, fromRecent }
    )),
    [
      { focus_minutes: 25, break_minutes: 5, cycles: 1, fromRecent: false },
      { focus_minutes: 50, break_minutes: 10, cycles: 1, fromRecent: false },
      { focus_minutes: 90, break_minutes: 15, cycles: 1, fromRecent: false },
    ],
  );
  assert.deepEqual(
    buildFocusTimeSuggestions([
      { focus_minutes: 25, break_minutes: 5, cycles: 1 },
      { focus_minutes: 25, break_minutes: 5, cycles: 1 },
      { focus_minutes: 40, break_minutes: 8, cycles: 1 },
    ]).map(({ focus_minutes, break_minutes, cycles, fromRecent }) => (
      { focus_minutes, break_minutes, cycles, fromRecent }
    )),
    [
      { focus_minutes: 25, break_minutes: 5, cycles: 1, fromRecent: true },
      { focus_minutes: 40, break_minutes: 8, cycles: 1, fromRecent: true },
      { focus_minutes: 50, break_minutes: 10, cycles: 1, fromRecent: false },
      { focus_minutes: 90, break_minutes: 15, cycles: 1, fromRecent: false },
    ],
  );
});

test('focus playlist links normalize safely for Spotify, YouTube, and YouTube Music', async () => {
  const { normalizePlaylist, playlistEmbedUrl, playlistProvider } = await importSource('static/js/focus/data.js');
  assert.equal(normalizePlaylist('https://open.spotify.com/playlist/abc123?si=demo'), 'https://open.spotify.com/playlist/abc123');
  assert.match(playlistEmbedUrl('https://open.spotify.com/playlist/abc123'), /\/embed\/playlist\/abc123/);
  assert.equal(
    normalizePlaylist('https://youtuBE.com/watch?v=nope'),
    '',
  );
  assert.equal(
    normalizePlaylist('https://www.youtube.com/playlist?list=PL1234567890abc&feature=share'),
    'https://www.youtube.com/playlist?list=PL1234567890abc',
  );
  assert.equal(playlistProvider('https://music.youtube.com/playlist?list=PLabcdefghijk'), 'youtube_music');
  assert.match(playlistEmbedUrl('https://www.youtube.com/playlist?list=PL1234567890abc'), /youtube-nocookie\.com\/embed\/videoseries/);
  assert.equal(normalizePlaylist('https://example.com/playlist/abc123'), '');
});

test('focus timer formatting and progress use stable timestamp math', async () => {
  const timer = await importSource('static/js/focus/timer.js');
  assert.equal(timer.formatTimer(1500), '25:00');
  assert.equal(timer.formatTimer(3661), '1:01:01');
  assert.equal(timer.progressRatio({ phase_duration_seconds: 100 }, 25), 0.75);
  assert.equal(timer.nextPhaseLabel({
    phase: 'focus', completed_focus_cycles: 0, total_cycles: 4,
    break_seconds: 300, long_break_seconds: 900,
  }), 'Break next · 5 min');
  assert.equal(timer.nestStage(0), 0);
  assert.equal(timer.nestStage(0.5), 4);
  assert.equal(timer.nestStage(0.92), 8);
  assert.equal(timer.eggCrackLevel(0.69), 0);
  assert.equal(timer.eggCrackLevel(0.94), 3);
});

test('focus page keeps resource-light and accessibility contracts wired', async () => {
  const template = await readFile(path.join(repoRoot, 'templates/focus.html'), 'utf8');
  const styles = await readFile(path.join(repoRoot, 'static/css/focus.css'), 'utf8');
  const lazyStyles = await readFile(path.join(repoRoot, 'static/css/focus-lazy.css'), 'utf8');
  const controller = await readFile(path.join(repoRoot, 'static/js/focus/index.js'), 'utf8');
  const view = await readFile(path.join(repoRoot, 'static/js/focus/view.js'), 'utf8');
  const musicRuntime = await readFile(path.join(repoRoot, 'static/js/focus/music-runtime.js'), 'utf8');
  const settingsPanel = await readFile(path.join(repoRoot, 'static/js/focus/settings-panel.js'), 'utf8');
  const musicPlayer = await readFile(path.join(repoRoot, 'static/js/focus/music-player.js'), 'utf8');
  const completion = await readFile(path.join(repoRoot, 'static/js/focus/completion.js'), 'utf8');
  const service = await readFile(path.join(repoRoot, 'services/focus_mode.py'), 'utf8');
  const blueprint = await readFile(path.join(repoRoot, 'blueprints/focus.py'), 'utf8');
  const notifications = await readFile(path.join(repoRoot, 'static/js/core/notifications.js'), 'utf8');
  const navbar = await readFile(path.join(repoRoot, 'static/js/core/navbar.js'), 'utf8');
  assert.match(template, /data-focus-break-suggestions aria-live="polite"/);
  assert.doesNotMatch(template, /data-focus-form-status/);
  assert.match(musicPlayer, /removeAttribute\('allowfullscreen'\)/);
  assert.match(template, /<dialog class="focus-options-dialog"[^>]+data-focus-options/);
  assert.match(template, /aria-label="Focus Settings"/);
  assert.match(template, />Focus Settings<\/h2>/);
  assert.doesNotMatch(template, /focus-settings-trigger[^>]*>[\s\S]*?>Focus Settings<\/span>/);
  assert.match(template, /data-focus-active-summary/);
  assert.match(template, /data-focus-inactive-settings/);
  assert.doesNotMatch(template, /Advanced settings|focus-volume|focus-help|data-tooltip/);
  assert.doesNotMatch(template, /<button\b[^>]*\btitle=/);
  assert.match(template, /data-focus-egg/);
  assert.match(template, /data-focus-egg-result/);
  assert.equal((template.match(/class="focus-nest-branch /g) || []).length, 8);
  assert.match(template, /value="below"/);
  assert.match(template, /value="beside"/);
  assert.match(template, /value="floating"/);
  assert.match(template, /<h1 id="focus-setup-title" class="sr-only">Focus Mode<\/h1>/);
  assert.doesNotMatch(template, /Set a focus timer|Choose a length and begin/);
  assert.doesNotMatch(template, /id="focus-page-title"|id="focus-page-subtitle"/);
  assert.doesNotMatch(template, /left_panel_open|play_arrow|logout/);
  assert.doesNotMatch(template, /data-focus-reopen-sidebar|data-focus-prepare-next/);
  assert.match(musicPlayer, /autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture/);
  assert.equal((template.match(/id="focus-spotify-url"/g) || []).length, 1);
  assert.match(template, /data-focus-playlist-apply hidden disabled/);
  assert.match(template, /data-focus-playlist-remove hidden/);
  assert.match(template, /data-focus-playlist-toggle/);
  assert.match(template, /data-focus-active-playlist-url/);
  assert.match(template, /data-focus-player-frame/);
  assert.match(template, /data-focus-panel-resize/);
  assert.match(template, />Music<\/h2>/);
  assert.match(template, /YouTube Music playlist/);
  assert.doesNotMatch(template, /data-focus-save-context/);
  assert.match(template, /data-focus-routine-combobox/);
  assert.match(template, /data-focus-combobox-trigger/);
  assert.match(template, /data-focus-routine-create/);
  assert.doesNotMatch(template, /focus-routine-picker focus-field[\s\S]*?<select/);
  assert.match(template, /focus-routine-name-row/);
  assert.doesNotMatch(template, />bookmark_add<\/span>/);
  assert.match(template, /data-focus-exit-label/);
  assert.match(template, /data-focus-history-region hidden/);
  assert.doesNotMatch(template, /css\/tailwind\.css/);
  assert.match(styles, /\.focus-options-dialog::backdrop/);
  assert.match(styles, /focus-options-panel-in/);
  assert.match(styles, /\.focus-options-dialog\.is-closing/);
  assert.match(styles, /\.focus-egg\[data-nest-stage="8"\] \.focus-nest-branch/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.focus-panel-resize-handle/);
  assert.match(styles, /data-spotify-custom-size/);
  assert.match(lazyStyles, /focus-player-placeholder/);
  assert.match(view, /import\('\.\/music-runtime\.js'\)/);
  assert.match(view, /import\('\.\/history-view\.js'\)/);
  assert.match(view, /import\('\.\/settings-panel\.js'\)/);
  assert.match(settingsPanel, /is-closing/);
  assert.match(musicRuntime, /import\('\.\/music-player\.js'\)/);
  assert.doesNotMatch(controller, /^import .*completion\.js/m);
  assert.doesNotMatch(controller, /^import .*playlist-gestures\.js/m);
  assert.match(controller, /phase changes|focusApi\.updateSession|scheduleTick/);
  assert.match(controller, /focusApi\.setPlaylist/);
  assert.match(controller, /restorePlaylist/);
  assert.match(controller, /Changes saved to/);
  assert.match(controller, /view\.openOptions/);
  assert.match(controller, /shellActive/);
  assert.match(controller, /hideSidebarForFocus/);
  assert.match(controller, /sessionActionInFlight/);
  assert.match(controller, /duration = 3500/);
  assert.match(controller, /playlistToast[\s\S]*?1000/);
  assert.match(controller, /completedSession/);
  assert.match(musicPlayer, /controller\?\.pause|controller\.pause/);
  assert.match(musicPlayer, /controller\?\.resume|controller\.resume/);
  assert.match(completion, /showNotification|new Notification/);
  assert.match(completion, /playPianoCue/);
  assert.match(controller, /if \(document\.hidden\) tick\(\)/);
  assert.doesNotMatch(controller, /state\.session\.state !== 'running' \|\| document\.hidden/);
  assert.doesNotMatch(controller, /setInterval/);
  assert.match(notifications, /focus_mode_active/);
  assert.match(navbar, /focusSidebarWasCollapsed/);
  assert.match(service, /state IN \('running','paused'\)/);
  assert.match(service, /action == "set_playlist"/);
  assert.match(service, /action == "restore_playlist"/);
  assert.match(blueprint, /private, no-store, no-transform/);
  assert.match(styles, /\.focus-combobox-trigger/);
  assert.match(styles, /\.focus-routine-create/);
  assert.match(controller, /onRoutineSelect/);
  assert.match(controller, /onRoutineCreate/);
  assert.match(view, /createRoutinePicker/);
  assert.match(view, /fillRoutine\(routine, \{ updatePicker/);
  assert.match(controller, /updatePicker: false/);
  assert.doesNotMatch(styles, /focus-setup-options-open|focus-help/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?data-spotify-layout/);
});

test('focus playlist library APIs persist account playlists across reloads', async () => {
  const data = await readFile(path.join(repoRoot, 'static/js/focus/data.js'), 'utf8');
  const controller = await readFile(path.join(repoRoot, 'static/js/focus/index.js'), 'utf8');
  const view = await readFile(path.join(repoRoot, 'static/js/focus/view.js'), 'utf8');
  const blueprint = await readFile(path.join(repoRoot, 'blueprints/focus.py'), 'utf8');
  const service = await readFile(path.join(repoRoot, 'services/focus_mode.py'), 'utf8');

  assert.match(data, /addPlaylist:[\s\S]*?\/api\/focus\/playlists/);
  assert.match(data, /removePlaylist:[\s\S]*?method: 'DELETE'/);
  assert.match(data, /setActivePlaylist:[\s\S]*?\/api\/focus\/playlists\/active/);

  assert.match(controller, /playlist_entitlements/);
  assert.match(controller, /playlistSourceFromLibrary/);
  assert.match(controller, /applyLibraryResponse/);
  assert.match(controller, /showPlaylistError/);
  assert.match(controller, /tier_limit/);
  assert.match(controller, /focusApi\.addPlaylist/);
  assert.match(controller, /focusApi\.removePlaylist/);
  assert.match(controller, /focusApi\.setActivePlaylist/);
  assert.match(controller, /active_playlist_url/);

  assert.match(view, /Playlist limit reached/);
  assert.match(view, /playlistToggle\.disabled = atLimit/);

  assert.match(blueprint, /add_focus_playlist/);
  assert.match(blueprint, /remove_focus_playlist/);
  assert.match(blueprint, /set_active_focus_playlist/);
  assert.match(blueprint, /playlist_entitlements/);
  assert.match(service, /def add_user_playlist/);
  assert.match(service, /def playlist_entitlements/);
  assert.match(service, /active_playlist_url/);
});


test('focus mutations participate in shared pending saves until decoding settles', async () => {
  const { request, focusApi } = await importSource('static/js/focus/data.js');
  const source = await readFile(path.join(repoRoot, 'static/js/core/pending-mutations.js'), 'utf8');
  const window = new EventTarget();
  let pendingAttribute = false;
  const document = { cookie: '', documentElement: { toggleAttribute(_name, pending) { pendingAttribute = pending; } } };
  vm.runInNewContext(source, { window, CustomEvent: globalThis.CustomEvent, Date });
  const pending = window.APStudyCoreServices.pendingMutations.createPendingMutations({ window, document });
  const originals = new Map(['document', 'fetch', 'APStudyPendingMutations'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'APStudyPendingMutations', { value: pending, configurable: true });
  globalThis.window.APStudyHttp = globalThis.window.APStudyCoreServices.http.createHttpService({ window: globalThis.window, pendingMutations: pending });
  try {
    let resolveFetch;
    let resolveBody;
    let capturedOptions;
    globalThis.fetch = (_url, options) => {
      capturedOptions = options;
      return new Promise((resolve) => { resolveFetch = resolve; });
    };
    const mutation = focusApi.start({ focus_minutes: 25 });
    assert.equal(pending.count(), 1);
    assert.equal(pendingAttribute, true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, true);
    resolveFetch({ ok: true, status: 200, url: '/api/focus/sessions', headers: new Headers(), json: () => new Promise((resolve) => { resolveBody = resolve; }) });
    await new Promise(setImmediate);
    assert.equal(pending.count(), 1, 'response decoding belongs to the save operation');
    resolveBody({ session: { id: 'saved' } });
    assert.equal((await mutation).session.id, 'saved');
    assert.equal(pending.count(), 0);
    assert.equal(pendingAttribute, false);
    assert.equal(capturedOptions.method, 'POST');

    const read = request('/api/focus');
    assert.equal(pending.count(), 0);
    resolveFetch(new Response('{}'));
    await read;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return new Response(null, { status: 204 });
    };
    await focusApi.deleteRoutine('routine-1', { keepalive: true });
    assert.equal(capturedOptions.keepalive, true);
    assert.equal(pending.count(), 0);

    globalThis.fetch = async () => new Response('{', { status: 200 });
    await assert.rejects(focusApi.saveRoutine({}), /Invalid JSON/);
    assert.equal(pending.count(), 0);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(focusApi.updateSession('session-1', 'pause'), /offline/);
    assert.equal(pending.count(), 0);
    assert.equal(pendingAttribute, false);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('music player controls both Spotify and YouTube through the provider-neutral API', async () => {
  const { createMusicPlayer } = await importSource('static/js/focus/music-player.js');
  const host = {
    children: [], hidden: false,
    querySelector(tag) { return this.children.find((node) => node.tagName === tag) || null; },
    replaceChildren(...nodes) { this.children = nodes; },
  };
  const browserWindow = { setTimeout: () => 1, clearTimeout() {} };
  const browserDocument = {
    createElement(tagName) { return { tagName, contentWindow: { postMessage() {} }, hasAttribute: () => false }; },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: browserDocument, configurable: true });
  try {
    const player = createMusicPlayer(host);
    const youtubeUrl = 'https://www.youtube.com/playlist?list=PL1234567890';
    const youtubeEmbed = 'https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890';
    assert.equal(await player.load(youtubeUrl, youtubeEmbed), true);
    assert.equal(host.querySelector('iframe').src, youtubeEmbed);
    assert.equal(player.currentUrl, youtubeUrl);
    const commands = [];
    host.querySelector('iframe').contentWindow.postMessage = (command) => commands.push(JSON.parse(command).func);
    player.pause(); player.resume();
    assert.deepEqual(commands, ['pauseVideo', 'playVideo']);
    let pauses = 0;
    let resumes = 0;
    let destroys = 0;
    browserWindow.__apstudySpotifyIframeApi = { api: { createController(_mount, options, ready) {
      assert.equal(options.url, 'https://open.spotify.com/playlist/abc123');
      ready({ pause() { pauses += 1; }, resume() { resumes += 1; }, destroy() { destroys += 1; } });
    } } };
    player.pause();
    assert.equal(await player.load('https://open.spotify.com/playlist/abc123', 'https://open.spotify.com/embed/playlist/abc123'), true);
    player.pause(); player.resume();
    assert.equal(pauses, 1);
    assert.equal(resumes, 1);
    player.clear();
    assert.equal(destroys, 1);
    assert.equal(host.hidden, true);
    player.dispose();
    assert.equal(await player.load(youtubeUrl, youtubeEmbed), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});

test('music panel reads the generic player host to apply provider-specific height rules', async () => {
  const { createMusicLayout } = await importSource('static/js/focus/music-layout.js');
  const styles = new Map();
  const style = { setProperty: (key, value) => styles.set(key, value), removeProperty: (key) => styles.delete(key) };
  const body = { style, dataset: {} };
  const browserWindow = { innerWidth: 1280, innerHeight: 900, localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {} };
  const originalGlobals = new Map(['window', 'document', 'requestAnimationFrame'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { body }, configurable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: () => 0, configurable: true });
  let layout;
  try {
    const playerHost = { dataset: {} };
    layout = createMusicLayout({ elements: {
      utilities: { style, getBoundingClientRect: () => ({ width: 400, height: 400 }) }, playerHost, layoutInputs: [],
    } });
    for (const [provider, height] of [['youtube', '400px'], ['spotify', '282px']]) {
      playerHost.dataset.playlistProvider = provider;
      layout.applyPreferences({ layout: 'beside', panel_width: 400, panel_height: 400 });
      assert.equal(styles.get('--focus-player-height'), height);
      assert.equal(body.dataset.spotifyLayout, 'beside', 'legacy DOM contract remains supported');
    }
  } finally {
    layout?.dispose();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('all Focus request owners forward lifecycle cancellation through fetch', async () => {
  const { focusApi } = await importSource('static/js/focus/data.js');
  const originals = new Map(['fetch', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'document', { value: { cookie: '' }, configurable: true });
  try {
    for (const operation of [
      (signal) => focusApi.state({ signal }),
      (signal) => focusApi.start({ focus_minutes: 25 }, { signal }),
      (signal) => focusApi.updateSession('focus-1', 'advance', { signal }),
      (signal) => focusApi.setPlaylist('focus-1', 'playlist', { signal }),
      (signal) => focusApi.removeSessionPlaylist('focus-1', 'playlist', { signal }),
      (signal) => focusApi.addPlaylist('playlist', { signal }),
      (signal) => focusApi.removePlaylist('playlist', { signal }),
      (signal) => focusApi.setActivePlaylist('playlist', { signal }),
      (signal) => focusApi.restorePlaylist('focus-1', 'playlist', 'active', { signal }),
      (signal) => focusApi.previewPlaylist('playlist', { signal }),
      (signal) => focusApi.saveRoutine({ name: 'routine' }, '', { signal }),
      (signal) => focusApi.saveRoutine({ name: 'routine' }, 'routine-1', { signal }),
      (signal) => focusApi.deleteRoutine('routine-1', { signal }),
      (signal) => focusApi.savePlayerPreferences({ volume: 50 }, { signal }),
    ]) {
      const controller = new AbortController();
      globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        assert.equal(signal, controller.signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const pending = operation(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('Focus mutation options reach fetch while methods and payloads retain feature ownership', async () => {
  const { focusApi } = await importSource('static/js/focus/data.js');
  const originals = new Map(['fetch', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'document', { value: { cookie: 'csrf_token=csrf%20token' }, configurable: true });
  const sessionUrl = '/api/focus/sessions/session%2F1';
  const playlist = 'https://open.spotify.com/playlist/example';
  const cases = [
    [(options) => focusApi.start({ focus_minutes: 25 }, options), '/api/focus/sessions', 'POST', { focus_minutes: 25 }],
    [(options) => focusApi.updateSession('session/1', 'pause', options), sessionUrl, 'PATCH', { action: 'pause' }],
    [(options) => focusApi.setPlaylist('session/1', playlist, options), sessionUrl, 'PATCH', { action: 'set_playlist', spotify_url: playlist }],
    [(options) => focusApi.removeSessionPlaylist('session/1', playlist, options), sessionUrl, 'PATCH', { action: 'remove_playlist', spotify_url: playlist }],
    [(options) => focusApi.addPlaylist(playlist, options), '/api/focus/playlists', 'POST', { spotify_url: playlist }],
    [(options) => focusApi.removePlaylist(playlist, options), '/api/focus/playlists', 'DELETE', { spotify_url: playlist }],
    [(options) => focusApi.setActivePlaylist(playlist, options), '/api/focus/playlists/active', 'PATCH', { spotify_url: playlist }],
    [(options) => focusApi.restorePlaylist('session/1', playlist, 'active', options), sessionUrl, 'PATCH', { action: 'restore_playlist', spotify_url: playlist, active_spotify_url: 'active' }],
    [(options) => focusApi.previewPlaylist(playlist, options), '/api/focus/playlists/preview', 'POST', { spotify_url: playlist }],
    [(options) => focusApi.saveRoutine({ name: 'Routine' }, '', options), '/api/focus/routines', 'POST', { name: 'Routine' }],
    [(options) => focusApi.saveRoutine({ name: 'Routine' }, 'routine/1', options), '/api/focus/routines/routine%2F1', 'PATCH', { name: 'Routine' }],
    [(options) => focusApi.savePlayerPreferences({ volume: 50 }, options), '/api/focus/player-preferences', 'PATCH', { volume: 50 }],
  ];
  try {
    const controller = new AbortController();
    for (const [invoke, expectedUrl, expectedMethod, expectedBody] of cases) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, expectedUrl);
        assert.equal(options.method, expectedMethod);
        assert.deepEqual(JSON.parse(options.body), expectedBody);
        assert.equal(options.signal, controller.signal);
        assert.equal(options.headers['X-Request-ID'], 'owner-1');
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.credentials, 'include');
        assert.equal(options.keepalive, true);
        return new Response('{}');
      };
      await invoke({ method: 'GET', body: 'wrong', signal: controller.signal, headers: { 'X-Request-ID': 'owner-1' }, cache: 'no-store', credentials: 'include', keepalive: true });
    }
    for (const [keepalive, normalized] of [[true, true], ['true', false], [undefined, false]]) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/focus/routines/routine%2F1');
        assert.equal(options.method, 'DELETE');
        assert.equal(options.signal, controller.signal);
        assert.equal(options.headers['X-Request-ID'], 'owner-1');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.keepalive, normalized);
        return new Response(null, { status: 204 });
      };
      await focusApi.deleteRoutine('routine/1', { signal: controller.signal, headers: { 'X-Request-ID': 'owner-1' }, cache: 'no-store', keepalive });
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('completion notifications ignore registration results after cancellation or disposal', async () => {
  const { createCompletionEffects } = await importSource('static/js/focus/completion.js');
  const originals = new Map(['window', 'document', 'navigator', 'Notification'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let notificationCount = 0;
  class Notification {
    static permission = 'granted';
    constructor() { notificationCount += 1; }
  }
  const browserWindow = { Notification };
  Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });
  Object.defineProperty(globalThis, 'Notification', { value: Notification, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true });
  try {
    for (const boundary of ['abort', 'dispose']) {
      let settleRegistration;
      const registration = new Promise((resolve) => { settleRegistration = resolve; });
      Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { getRegistration: () => registration } }, configurable: true });
      const effects = createCompletionEffects();
      const controller = new AbortController();
      await effects.prepare({ signal: controller.signal });
      effects.complete('focus', { signal: controller.signal });
      if (boundary === 'abort') controller.abort();
      else effects.dispose();
      settleRegistration({ showNotification() { notificationCount += 1; return Promise.resolve(); } });
      await new Promise(setImmediate);
      effects.complete('break', { signal: controller.signal });
      assert.equal(notificationCount, 0);
      effects.dispose();
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
