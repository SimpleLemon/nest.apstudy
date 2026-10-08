import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import featureModules from './helpers/feature-modules.cjs';

const sources = await Promise.all(['http', 'csrf', 'pending-mutations'].map(name => readFile(new URL(`../../static/js/core/${name}.js`, import.meta.url), 'utf8')));
function runtime() {
  const window = new EventTarget();
  window.location = { href: 'https://nest.example/focus', origin: 'https://nest.example' };
  const document = { cookie: 'csrf_token=initial%20token', documentElement: { toggleAttribute() {} } };
  class BrowserRequest extends Request {
    constructor(input, options) { super(typeof input === 'string' ? new URL(input, window.location.href) : input, options); }
  }
  const context = vm.createContext({ window, document, URL, Request: BrowserRequest, Headers, FormData, CustomEvent: globalThis.CustomEvent, Error });
  for (const source of sources) vm.runInContext(source, context);
  const pending = window.APStudyCoreServices.pendingMutations.createPendingMutations({ window, document });
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: pending });
  return { window, document, pending, ...featureModules.loadFeatureModule('focus/data.js', context) };
}

test('Focus uses real CSRF retry without owning token headers and preserves request options', async () => {
  const h = runtime();
  const controller = new AbortController();
  const requests = [];
  h.window.fetch = async (input, options) => {
    if (input === '/auth/csrf') {
      assert.equal(options.credentials, 'same-origin'); h.document.cookie = 'csrf_token=refreshed%20token';
      return new Response('{}');
    }
    requests.push(input);
    assert.equal(input.method, 'POST');
    assert.equal(input.credentials, 'include');
    assert.equal(input.cache, 'no-store');
    assert.equal(input.keepalive, true);
    assert.equal(input.headers.get('X-Request-ID'), 'focus-owner');
    assert.equal(input.headers.get('Content-Type'), 'application/json');
    assert.equal(await input.text(), JSON.stringify({ focus_minutes: 25 }));
    assert.equal(input.signal.aborted, false);
    if (requests.length === 1) return new Response('{"error":"CSRF expired"}', { status: 400, headers: { 'X-APStudy-CSRF-Error': '1' } });
    return new Response('{"session":{"id":"saved"}}');
  };
  h.window.APStudyCoreServices.csrf.installCsrfFetch({ window: h.window, document: h.document });
  const result = await h.focusApi.start({ focus_minutes: 25 }, { signal: controller.signal, credentials: 'include', cache: 'no-store', keepalive: true, headers: { 'X-Request-ID': 'focus-owner' } });
  assert.equal(result.session.id, 'saved');
  assert.equal(requests[0].headers.get('X-CSRFToken'), 'initial token');
  assert.equal(requests[1].headers.get('X-CSRFToken'), 'refreshed token');
  assert.equal(h.pending.count(), 0);
});

test('Focus required decoding and fallback retain shared metadata including falsy quota fields', async () => {
  const h = runtime();
  const response = new Response('{"code":"","resource":"","limit":0,"current":0,"requested":0}', { status: 403 });
  Object.defineProperty(response, 'url', { value: 'https://nest.example/api/focus' });
  h.window.fetch = async () => response;
  await assert.rejects(h.request('/api/focus'), error => {
    assert.equal(error.message, 'Focus Mode could not save that change.');
    assert.equal(error.status, 403); assert.equal(error.url, response.url); assert.equal(error.response, response);
    assert.equal(error.code, ''); assert.equal(error.resource, '');
    for (const key of ['limit', 'current', 'requested']) assert.equal(error[key], 0);
    return true;
  });
  h.window.fetch = async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(h.request('/api/focus', { jsonMode: 'optional' }), error => error.status === 200 && error.cause instanceof SyntaxError);
});

test('Focus reads stay outside pending saves and cancellation settles one mutation', async () => {
  const h = runtime();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    let resolve;
    h.window.fetch = () => new Promise(done => { resolve = done; });
    const operation = h.request('/api/focus', { method });
    assert.equal(h.pending.count(), 0);
    resolve(new Response(null, { status: 204 })); await operation;
  }
  const counts = [];
  h.window.addEventListener('apstudy-pending-save-change', event => counts.push(event.detail.pending));
  const controller = new AbortController();
  h.window.fetch = (_url, options) => {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.signal, controller.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const operation = h.focusApi.updateSession('id', 'pause', { signal: controller.signal });
  assert.equal(h.pending.count(), 1); controller.abort();
  await assert.rejects(operation, error => error === controller.signal.reason);
  assert.deepEqual(counts, [1, 0]);
});
