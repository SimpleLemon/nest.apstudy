import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { loadFeatureModule } from './helpers/feature-modules.cjs';

async function installThemeHttp(window) {
  const source = await readFile(new URL('../../static/js/core/http.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window });
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: window.APStudyPendingMutations });
}

test('theme UI imports its portable core before exposing or consuming the API', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nest-theme-modules-'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'APStudyTheme');
  delete globalThis.APStudyTheme;
  try {
    await cp(new URL('../../static/js/community-themes/', import.meta.url), directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const { core, paint } = await import(pathToFileURL(path.join(directory, 'ui.js')));
    assert.equal(core, globalThis.APStudyTheme);
    assert.equal(typeof core.paletteValid, 'function');
    const palette = Object.fromEntries(core.paletteKeys.map((key) => [key, '#123456']));
    assert.equal(core.paletteValid(palette), true);
    const properties = new Map();
    const node = { style: { setProperty: (key, value) => properties.set(key, value) }, dataset: {} };
    paint(node, { light_preset: palette, custom_font: { family: 'Newsreader' }, cardRoundness: 12,
      cardPadding: 8, cardSpacing: 6, condensed_cards: true, wide_course_cards: false }, 'light');
    assert.equal(properties.get('--tp-background-0'), '#123456');
    assert.equal(properties.get('--preview-font'), 'Newsreader,serif');
    assert.equal(properties.get('--tp-radius'), '12px');
    assert.equal(node.dataset.condensed, 'true');
    for (const name of ['community_themes', 'admin_themes']) {
      const template = await readFile(new URL(`../../templates/${name}.html`, import.meta.url), 'utf8');
      assert.match(template, /type="module"[^>]+js\/community-themes\/app\.js/);
      assert.doesNotMatch(template, /js\/community-themes\/core\.js/);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'APStudyTheme', previous);
    else delete globalThis.APStudyTheme;
    await rm(directory, { recursive: true, force: true });
  }
});

test('theme writes track response decoding and settle pending state on success or failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nest-theme-requests-'));
  const names = ['window', 'document', 'fetch', 'APStudyTheme'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let pending = 0;
  const labels = [];
  let response;
  Object.assign(globalThis, {
    window: { APStudyPendingMutations: { track(operation, label) {
      labels.push(label);
      pending += 1;
      return operation.finally(() => { pending -= 1; });
    } } },
    document: { querySelector: () => ({ content: 'csrf-token' }) },
    fetch: async () => response,
  });
  try {
    window.fetch = (...args) => globalThis.fetch(...args);
    await installThemeHttp(window);
    await cp(new URL('../../static/js/community-themes/', import.meta.url), directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const { api } = await import(pathToFileURL(path.join(directory, 'ui.js')));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const started = Promise.withResolvers();
      const decoded = Promise.withResolvers();
      response = new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
      response.json = () => { started.resolve(); return decoded.promise; };
      const operation = api('/api/themes/example', method, {});
      await started.promise;
      assert.equal(pending, 1);
      decoded.resolve({ ok: true });
      assert.deepEqual(await operation, { ok: true });
      assert.equal(pending, 0);
    }
    assert.deepEqual(labels, Array(4).fill('themes-save'));
    response = new Response('{"ok":true}');
    await api('/api/themes');
    assert.equal(labels.length, 4);
    response = new Response('{"error":{"message":"Access denied"}}', { status: 403 });
    await assert.rejects(api('/api/themes/example', 'POST', {}), /Access denied/);
    assert.equal(pending, 0);
    response = new Response('bad body');
    await assert.rejects(api('/api/themes/example', 'POST', {}), /request failed/);
    assert.equal(pending, 0);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(api('/api/themes/example', 'POST', {}), /offline/);
    assert.equal(pending, 0);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('theme response policies preserve early sign-in failures, envelope context and transport options', async () => {
  const requests = [];
  let response;
  const window = { fetch: async (url, options) => { requests.push({ url, options }); return response; } };
  const document = { querySelector: () => ({ content: 'theme-csrf' }) };
  await installThemeHttp(window);
  const ui = loadFeatureModule('community-themes/ui.js', { window, document, AbortSignal, Error });
  for (const kind of ['unauthorized', 'redirected']) {
    response = new Response('<html>Login</html>', { status: kind === 'unauthorized' ? 401 : 200 });
    if (kind === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
    let decoded = false;
    response.json = () => { decoded = true; throw new Error('Login body must not be decoded'); };
    await assert.rejects(ui.api('/api/themes'), error => {
      assert.equal(error.message, 'Sign in to Nest, then try again.');
      assert.equal(error.status, response.status);
      assert.equal(error.response, response);
      assert.equal(error.url, '/api/themes');
      return true;
    });
    assert.equal(decoded, false);
  }
  for (const [status, body, message] of [
    [403, 'invalid', 'Admin access is required.'],
    [200, '{"ok":false,"error":{"message":"Revision changed"},"code":"conflict"}', 'Revision changed'],
    [200, 'null', 'The request failed. Reload and try again.'],
    [200, 'invalid', 'The request failed. Reload and try again.'],
  ]) {
    response = new Response(body, { status });
    await assert.rejects(ui.api('/api/themes/example', 'PUT', { expectedRevision: 4 }), error => {
      assert.equal(error.message, message);
      assert.equal(error.status, status);
      assert.equal(error.response, response);
      assert.equal(error.url, '/api/themes/example');
      if (body === 'invalid') assert.ok(error.cause instanceof SyntaxError);
      if (body.includes('conflict')) assert.equal(error.code, 'conflict');
      return true;
    });
  }
  const { options } = requests.at(-1);
  assert.equal(options.method, 'PUT');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(options.headers['X-CSRFToken'], 'theme-csrf');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.body, '{"expectedRevision":4}');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal('validateResponse' in options, false);
  assert.equal('validatePayload' in options, false);
  const offline = new Error('offline');
  window.fetch = async () => { throw offline; };
  await assert.rejects(ui.api('/api/themes'), error => error === offline);
});

test('theme clipboard errors preserve their cause and do not relabel status rendering failures', async () => {
  const permissionError = new Error('Clipboard permission denied');
  const statusNode = { textContent: '', dataset: {} };
  const navigator = { clipboard: { writeText: async () => { throw permissionError; } } };
  const context = { navigator, document: { querySelector: () => statusNode }, Error };
  const ui = loadFeatureModule('community-themes/ui.js', context);
  await assert.rejects(ui.copy('Theme link'), error => error.cause === permissionError && /Clipboard access failed/.test(error.message));
  assert.equal(statusNode.textContent, '');
  const copied = [];
  navigator.clipboard.writeText = async value => { copied.push(value); };
  await ui.copy('Theme link');
  assert.deepEqual(copied, ['Theme link']);
  assert.equal(statusNode.textContent, 'Copied to clipboard.');
  const renderingError = new Error('Status surface unavailable');
  context.document.querySelector = () => { throw renderingError; };
  await assert.rejects(ui.copy('Theme link'), error => error === renderingError);
});
