import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../static/js/core/http.js', import.meta.url), 'utf8');
function service(fetch) {
  const window = { fetch };
  vm.runInNewContext(source, { window, URL, Error });
  return window.APStudyCoreServices.http.createHttpService({ window });
}
const response = (payload, status = 200) => ({ ok: status < 400, status, url: '/admin/action', headers: { get: () => 'application/json' }, json: async () => payload });

test('shared admin command POST preserves JSON, explicit CSRF and same-origin request semantics', async () => {
  const calls = [];
  const http = service(async (url, options) => { calls.push({ url, options }); return response({ accepted: true }); });
  const post = http.postJson;
  assert.equal((await post('/admin/action', { confirm: 'RESTART' }, 'page-token')).accepted, true);
  assert.equal(calls[0].url, '/admin/action');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'page-token' },
    body: '{"confirm":"RESTART"}', credentials: 'same-origin',
  });
  for (const body of [undefined, null, false, 0, '']) {
    await post('/admin/action', body);
    assert.equal(calls.at(-1).options.body, '{}');
    assert.equal(calls.at(-1).options.headers['X-CSRFToken'], '');
  }
});

for (const [payload, message] of [
  [{ message: 'Readable admin rejection', error: 'Error code' }, 'Readable admin rejection'],
  [{ message: '', error: 'Server rejected action' }, 'Server rejected action'],
  [{}, 'Request failed.'],
]) {
  test(`shared command rejection keeps admin message precedence: ${message}`, async () => {
    const rejected = response(payload, 403);
    const http = service(async () => rejected);
    await assert.rejects(http.postJson('/admin/action', {}, 'token'), (error) => {
      assert.equal(error.message, message); assert.equal(error.status, 403);
      assert.equal(error.response, rejected); assert.equal(error.url, '/admin/action');
      return true;
    });
  });
}

test('shared command acknowledgments require JSON and preserve decoding errors and intentional empty success', async () => {
  const parseError = new SyntaxError('Login HTML');
  const malformed = { ...response(null), headers: { get: () => 'text/html' }, json: async () => { throw parseError; } };
  const http = service(async () => malformed);
  await assert.rejects(http.postJson('/admin/action'), (error) => {
    assert.equal(error.message, 'Invalid JSON response.'); assert.equal(error.cause, parseError);
    assert.equal(error.status, 200); assert.equal(error.response, malformed);
    return true;
  });
  malformed.status = 403; malformed.ok = false;
  await assert.rejects(http.postJson('/admin/action'), (error) => {
    assert.equal(error.message, 'Request failed.'); assert.equal(error.cause, parseError);
    assert.equal(error.status, 403);
    return true;
  });
  for (const status of [204, 205]) {
    const empty = service(async () => ({ ...response(null, status), json() { assert.fail('Empty acknowledgment must not decode'); } }));
    assert.equal(Object.keys(await empty.postJson('/admin/action')).length, 0);
  }
  const offline = new Error('Connection interrupted');
  const failing = service(async () => { throw offline; });
  await assert.rejects(failing.postJson('/admin/action'), (error) => error === offline);
});
