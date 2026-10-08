import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import featureModules from './helpers/feature-modules.cjs';

const { loadFeatureModule } = featureModules;
const httpSource = await readFile(new URL('../../static/js/core/http.js', import.meta.url), 'utf8');
const pendingSource = await readFile(new URL('../../static/js/core/pending-mutations.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function runtime(modulePath) {
  const window = new EventTarget();
  const attributes = new Set();
  const document = {
    documentElement: { toggleAttribute(name, enabled) { if (enabled) attributes.add(name); else attributes.delete(name); } },
    querySelector: () => ({ content: 'csrf-token' }),
  };
  const context = vm.createContext({ window, document, URL, FormData, CustomEvent: globalThis.CustomEvent, AbortSignal, Error });
  vm.runInContext(httpSource, context);
  vm.runInContext(pendingSource, context);
  const pending = window.APStudyCoreServices.pendingMutations.createPendingMutations({ window, document });
  window.APStudyPendingMutations = pending;
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: pending });
  context.fetch = (...args) => window.fetch(...args);
  return { window, pending, attributes, exports: loadFeatureModule(modulePath, context) };
}

test('settings escaping works before the shared UI shell is installed', () => {
  const { window, exports: { escapeHtml } } = runtime('settings/utils.js');
  assert.equal(window.APStudyUIPrimitives, undefined);
  assert.equal(escapeHtml('<profile & "name">'), '&lt;profile &amp; &quot;name&quot;&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(window.APStudyUIPrimitives, undefined);
});

for (const [name, path, exportName] of [
  ['settings', 'settings/utils.js', 'fetchJson'],
  ['notes list', 'notes/list/utils.js', 'apiJson'],
  ['dashboard', 'dashboard/utils.js', 'fetchJson'],
]) {
  test(`${name} JSON API rejects login HTML and malformed success with the real shared HTTP service`, async () => {
    const { window, exports } = runtime(path);
    const request = exports[exportName];
    for (const [body, contentType] of [['<html>Sign in</html>', 'text/html'], ['{"saved":', 'application/json'], ['', 'text/plain']]) {
      const response = new Response(body, { headers: { 'Content-Type': contentType } });
      Object.defineProperty(response, 'url', { value: 'https://nest.example/login' });
      window.fetch = async () => response;
      await assert.rejects(request('/api/example', { method: 'POST', jsonMode: 'optional' }), (error) => {
        assert.equal(error.message, 'Invalid JSON response.');
        assert.equal(error.status, 200);
        assert.equal(error.url, 'https://nest.example/login');
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      });
    }
    window.fetch = async () => new Response('{"saved":true}', { headers: { 'Content-Type': 'text/plain' } });
    assert.deepEqual(plain(await request('/api/example')), { saved: true });
    for (const [method, status] of [['POST', 204], ['POST', 205], ['HEAD', 200]]) {
      window.fetch = async () => ({ ok: true, status, headers: new Headers(), json() { assert.fail('Bodyless success must not decode'); } });
      assert.deepEqual(plain(await request('/api/example', { method })), {});
    }
  });

  test(`${name} preserves HTTP errors, cancellation and pending saves through decoding`, async () => {
    const { window, exports, pending, attributes } = runtime(path);
    const request = exports[exportName];
    const decoded = Promise.withResolvers();
    const started = Promise.withResolvers();
    const controller = new AbortController();
    window.fetch = async (url, options) => {
      assert.equal(url, '/api/example');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.headers['X-Request-ID'], 'save-1');
      assert.equal(options.headers['Content-Type'], 'application/json');
      return { ok: true, status: 200, headers: new Headers(), json() { started.resolve(); return decoded.promise; } };
    };
    const operation = request('/api/example', { method: 'PATCH', body: '{}', signal: controller.signal, headers: { 'X-Request-ID': 'save-1' }, pendingLabel: 'save-example' });
    await started.promise;
    assert.equal(pending.count(), 1);
    assert.equal(attributes.has('data-pending-save'), true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, true);
    decoded.resolve({ saved: true });
    assert.deepEqual(plain(await operation), { saved: true });
    assert.equal(pending.count(), 0);
    assert.equal(attributes.has('data-pending-save'), false);
    const failedDecode = Promise.withResolvers();
    const decoding = Promise.withResolvers();
    window.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json() { decoding.resolve(); return failedDecode.promise; } });
    const invalidSave = request('/api/example', { method: 'POST', pendingLabel: 'save-example' });
    await decoding.promise;
    assert.equal(pending.count(), 1);
    const decodeCause = new SyntaxError('Truncated save response');
    failedDecode.reject(decodeCause);
    await assert.rejects(invalidSave, (error) => error.cause === decodeCause);
    assert.equal(pending.count(), 0);
    for (const [body, message, cause] of [['{"error":"Save rejected"}', 'Save rejected', false], ['<html>Gateway failed</html>', 'Bad Gateway', true]]) {
      const response = new Response(body, { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } });
      window.fetch = async () => response;
      await assert.rejects(request('/api/example', { method: 'POST' }), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.status, 502);
        assert.equal(error.response, response);
        assert.equal(error.url, '/api/example');
        assert.equal(Boolean(error.cause), cause);
        return true;
      });
      assert.equal(pending.count(), 0);
    }
    window.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const cancelled = request('/api/example', { method: 'POST', signal: controller.signal, pendingLabel: 'save-example' });
    assert.equal(pending.count(), 1);
    controller.abort();
    await assert.rejects(cancelled, (error) => error === controller.signal.reason);
    assert.equal(pending.count(), 0);
  });
}

test('dashboard defaults pending-save tracking for mutations and preserves explicit labels and read methods', async () => {
  const { window, exports: { fetchJson }, pending, attributes } = runtime('dashboard/utils.js');
  for (const [method, options, expectedCount] of [
    ['POST', {}, 1], ['PATCH', { pendingLabel: 'layout-save' }, 1],
    ['DELETE', { pendingLabel: null }, 0], ['GET', {}, 0], ['HEAD', {}, 0], ['OPTIONS', {}, 0],
  ]) {
    const response = Promise.withResolvers();
    window.fetch = () => response.promise;
    const request = fetchJson('/api/dashboard', { method, ...options });
    assert.equal(pending.count(), expectedCount, method);
    assert.equal(attributes.has('data-pending-save'), expectedCount === 1, method);
    response.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    await request;
    assert.equal(pending.count(), 0);
  }
});

test('settings form uploads retain FormData and require JSON before resolving the save', async () => {
  const { window, exports: { fetchFormData }, pending } = runtime('settings/utils.js');
  const form = new FormData();
  form.append('name', 'Taylor');
  window.fetch = async (url, options) => {
    assert.equal(url, '/api/settings/profile');
    assert.equal(options.body, form);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], undefined);
    return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
  };
  await assert.rejects(fetchFormData('/api/settings/profile', form), /Invalid JSON response/);
  assert.equal(pending.count(), 0);
});

test('community theme API retains feature messages plus response and decoding failure details', async () => {
  const { window, exports: { api }, pending } = runtime('community-themes/ui.js');
  for (const [status, body, message, parseFailure] of [
    [403, '{"error":{"message":"Access denied"}}', 'Access denied', false],
    [403, '<html>Forbidden</html>', 'Admin access is required.', true],
    [502, '<html>Gateway failure</html>', 'The request failed. Reload and try again.', true],
    [200, '<html>Sign in</html>', 'The request failed. Reload and try again.', true],
    [200, '{"ok":false}', 'The request failed. Reload and try again.', false],
  ]) {
    const response = new Response(body, { status });
    Object.defineProperty(response, 'url', { value: 'https://nest.example/api/themes' });
    window.fetch = async () => response;
    await assert.rejects(api('/api/themes', 'POST', {}), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.status, status);
      assert.equal(error.url, response.url);
      assert.equal(error.response, response);
      assert.equal(Boolean(error.cause), parseFailure);
      return true;
    });
    assert.equal(pending.count(), 0);
  }
  for (const response of [
    { ok: false, status: 401, url: '/login', json() { assert.fail('Authentication rejection must not decode'); } },
    { ok: true, status: 200, redirected: true, url: '/login', json() { assert.fail('Redirect rejection must not decode'); } },
  ]) {
    window.fetch = async () => response;
    await assert.rejects(api('/api/themes'), (error) => {
      assert.equal(error.message, 'Sign in to Nest, then try again.');
      assert.equal(error.response, response);
      assert.equal(error.status, response.status);
      assert.equal(error.url, '/login');
      return true;
    });
  }
  const cause = new Error('offline');
  window.fetch = async () => { throw cause; };
  await assert.rejects(api('/api/themes', 'POST', {}), (error) => error === cause);
  assert.equal(pending.count(), 0);
});
