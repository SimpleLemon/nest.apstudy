import assert from 'node:assert/strict';
import test from 'node:test';
import { adminPanelRuntime, response, settle } from './helpers/admin-panel.mjs';

async function runtime() {
  const fixture = await adminPanelRuntime({ scripts: ['admin-apswiftly.js'], html: `<body>
    <input id="admin-apswiftly-csrf-token" value="fixture-csrf">
    <input id="restart-confirm" value="RESTART">
    <button data-apswiftly-action="restart" data-apswiftly-confirm-input="restart-confirm" data-apswiftly-confirm-value="RESTART">Restart</button>
    <span data-apswiftly-role="service-state"></span><span data-apswiftly-role="api-state"></span><span data-apswiftly-role="checked-at"></span>
  </body>` });
  fixture.requests[0].resolve(response({ service_state: 'active', api_reachable: true }));
  await settle();
  return { ...fixture, button: fixture.document.querySelector('[data-apswiftly-action]'), confirmation: fixture.document.getElementById('restart-confirm') };
}

test('APSwiftly confirmation rejects unmatched text before starting the shared POST', async () => {
  const fixture = await runtime();
  fixture.confirmation.value = 'wrong';
  fixture.emit(fixture.button, 'click');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.confirmation.value, 'wrong');
  assert.equal(fixture.notices.at(-1).message, 'Type RESTART to confirm this action.');
  assert.equal(fixture.notices.at(-1).type, 'error');
});

test('APSwiftly command invalid JSON preserves confirmation and restores the actual action control', async () => {
  const fixture = await runtime();
  const { button, confirmation, requests, notices } = fixture;
  fixture.emit(button, 'click');
  assert.equal(button.disabled, true);
  assert.equal(requests[1].url, '/admin/apswiftly/restart');
  assert.equal(requests[1].options.headers['X-CSRFToken'], 'fixture-csrf');
  assert.deepEqual(JSON.parse(requests[1].options.body), { confirm: 'RESTART' });
  fixture.emit(button, 'click');
  assert.equal(requests.length, 2, 'pending command ignores additional clicks');
  requests[1].resolve({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => { throw new SyntaxError('Login HTML'); } });
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(confirmation.value, 'RESTART');
  assert.equal(notices.at(-1).type, 'error');
  assert.equal(notices.at(-1).message, 'Invalid JSON response.');
  assert.equal(requests.length, 2, 'failed command does not trigger successful status refresh');
  fixture.emit(button, 'click');
  requests[2].resolve(response({ message: 'Command permission expired', error: 'Lower-priority code' }, 403));
  await settle();
  assert.equal(confirmation.value, 'RESTART');
  assert.equal(notices.at(-1).message, 'Command permission expired');
  assert.equal(button.disabled, false);
});

test('accepted APSwiftly command clears confirmation only after JSON acknowledgment and refreshes status', async () => {
  const fixture = await runtime();
  fixture.emit(fixture.button, 'click');
  fixture.requests[1].resolve(response({ message: 'Restart accepted' }));
  await settle();
  assert.equal(fixture.confirmation.value, '');
  assert.equal(fixture.notices.at(-1).message, 'Restart accepted');
  assert.equal(fixture.requests[2].url, '/admin/apswiftly/status');
  assert.equal(fixture.button.disabled, true, 'command remains pending during status refresh');
  fixture.requests[2].resolve(response({ service_state: 'restarting', api_reachable: false }));
  await settle();
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.document.querySelector('[data-apswiftly-role="service-state"]').textContent, 'Restarting');
});

test('intentional bodyless APSwiftly acknowledgment skips decoding through the shared contract', async () => {
  const fixture = await runtime();
  fixture.emit(fixture.button, 'click');
  let decoded = false;
  fixture.requests[1].resolve({ ok: true, status: 204, headers: { get: () => 'application/json' }, json: async () => { decoded = true; throw new SyntaxError('No body'); } });
  await settle();
  assert.equal(decoded, false);
  assert.equal(fixture.notices.at(-1).message, 'APSwiftly command completed.');
  assert.equal(fixture.confirmation.value, '');
  fixture.requests[2].resolve(response({ service_state: 'active' }));
  await settle();
  assert.equal(fixture.button.disabled, false);
});
