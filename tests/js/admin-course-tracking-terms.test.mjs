import assert from 'node:assert/strict';
import test from 'node:test';
import { trackingTermsRuntime, response, settle } from './helpers/admin-tracking-terms.mjs';

process.env.TZ = 'America/New_York';

const term = (overrides = {}) => ({
  term: 'Fall_2026', label: 'Fall 2026', state: 'upcoming', effective_state: 'upcoming',
  revision: 7, catalog_available: true, active_count: 2, waiting_count: 3, paused_count: 1,
  opens_at: '2026-08-20T13:30:00Z', closes_at: '2026-12-20T22:15:00Z',
  ...overrides,
});
const notice = (form) => form.querySelector('[data-term-notice]');
const body = (request) => JSON.parse(request.options.body);

test('renders New York local times and saves UTC with the initial and subsequent revisions', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const { requests, root } = fixture;
  assert.equal(requests[0].url, '/admin/course-tracking/terms');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.match(root.querySelector('[data-term-timezone]').textContent, /America\/New_York/);
  fixture.initialize();
  assert.equal(requests.length, 1, 'initialization must not duplicate loads or handlers');
  let form = fixture.form();
  assert.equal(form.elements.opens_at.value, '2026-08-20T09:30');
  assert.equal(form.elements.closes_at.value, '2026-12-20T17:15');
  form.elements.state.value = 'open';
  form.elements.opens_at.value = '2026-08-21T10:45';
  form.elements.closes_at.value = '2026-12-21T18:00';
  assert.equal(fixture.emit(form, 'submit').defaultPrevented, true);
  assert.equal(requests[1].url, '/admin/course-tracking/terms/Fall_2026/toggle');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.credentials, 'same-origin');
  assert.equal(requests[1].options.headers['Content-Type'], 'application/json');
  assert.equal(requests[1].options.headers['X-CSRFToken'], 'fixture-csrf');
  assert.deepEqual(body(requests[1]), { state: 'open', opens_at: '2026-08-21T14:45:00.000Z', closes_at: '2026-12-21T23:00:00.000Z', expected_revision: 7 });
  assert.equal(notice(form).textContent, 'Saving…');
  assert.equal(notice(form).hidden, false);
  assert.ok(form.elements.every((control) => control.disabled));
  fixture.emit(form, 'submit');
  assert.equal(requests.length, 2, 'an in-flight save must ignore another submit');
  requests[1].resolve(response({ policy: { state: 'open', effective_state: 'open', revision: 8, polling_enabled: true, opens_at: body(requests[1]).opens_at, closes_at: body(requests[1]).closes_at, updated_at: '2026-08-21T14:00:00Z', updated_by: 'admin@example.test' } }));
  await settle();
  form = fixture.form();
  assert.equal(notice(form).textContent, 'Fall 2026 saved. Tracking is open.');
  assert.equal(notice(form).hidden, false);
  assert.match(form.textContent, /5 active · 0 suspended · 1 paused/);
  assert.match(form.textContent, /Last saved .*admin@example\.test/);
  assert.equal(fixture.document.activeElement, form.querySelector('button'));
  assert.ok(form.elements.every((control) => !control.disabled));
  assert.equal(fixture.savedEvents.length, 1);
  assert.equal(fixture.savedEvents[0].bubbles, true);
  assert.equal(fixture.savedEvents[0].detail.revision, 8);
  fixture.emit(form, 'submit');
  assert.equal(body(requests[2]).expected_revision, 8);
  requests[2].resolve(response({ policy: { revision: 9 } }));
  await settle();
});

test('rejects the spring DST gap without posting or leaving the form disabled', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const form = fixture.form();
  form.elements.opens_at.value = '2026-03-08T02:30';
  fixture.emit(form, 'submit');
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.match(notice(form).textContent, /Choose a valid local date and time.*daylight-saving clock change/);
  assert.equal(notice(form).hidden, false);
  assert.equal(form.dataset.saving, undefined);
  assert.ok(form.elements.every((control) => !control.disabled));
  form.elements.opens_at.value = '2026-03-08T03:30';
  fixture.emit(form, 'submit');
  assert.equal(body(fixture.requests[1]).opens_at, '2026-03-08T07:30:00.000Z');
  fixture.requests[1].reject(new Error('Connection interrupted'));
  await settle();
});

test('409 replaces stale inputs with server policy and permits an editable retry using its revision', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const oldForm = fixture.form();
  oldForm.elements.opens_at.value = '2026-08-22T10:00';
  fixture.emit(oldForm, 'submit');
  fixture.requests[1].resolve(response({ error: 'Another admin changed this schedule. Review and retry.', policy: { state: 'open', effective_state: 'open', revision: 12, opens_at: '2026-08-25T15:00:00Z', closes_at: null, updated_at: '2026-08-24T12:00:00Z', updated_by: 'other-admin' } }, 409));
  await settle();
  const refreshed = fixture.form();
  assert.notEqual(refreshed, oldForm);
  assert.equal(refreshed.elements.state.value, 'open');
  assert.equal(refreshed.elements.opens_at.value, '2026-08-25T11:00');
  assert.equal(refreshed.elements.closes_at.value, '');
  assert.equal(notice(refreshed).textContent, 'Another admin changed this schedule. Review and retry.');
  assert.equal(notice(refreshed).hidden, false);
  assert.equal(fixture.document.activeElement, refreshed.elements.state);
  assert.ok(refreshed.elements.every((control) => !control.disabled));
  assert.equal(refreshed.dataset.saving, undefined);
  assert.equal(fixture.savedEvents.length, 0);
  refreshed.elements.opens_at.value = '2026-08-26T09:00';
  fixture.emit(refreshed, 'submit');
  assert.deepEqual(body(fixture.requests[2]), { state: 'open', opens_at: '2026-08-26T13:00:00.000Z', closes_at: null, expected_revision: 12 });
  fixture.requests[2].resolve(response({ policy: { revision: 13, polling_enabled: true, opens_at: body(fixture.requests[2]).opens_at } }));
  await settle();
  assert.equal(notice(fixture.form()).textContent, 'Fall 2026 saved. Tracking is open.');
  assert.equal(fixture.savedEvents[0].detail.revision, 13);
});

test('closed state clears schedules and restores initially disabled inputs after server and network failures', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const form = fixture.form();
  form.elements.state.value = 'closed';
  fixture.emit(form.elements.state, 'change');
  assert.equal(form.elements.opens_at.value, '');
  assert.equal(form.elements.closes_at.value, '');
  assert.equal(form.elements.opens_at.disabled, true);
  assert.equal(form.elements.closes_at.disabled, true);
  fixture.emit(form, 'submit');
  assert.deepEqual(body(fixture.requests[1]), { state: 'closed', opens_at: null, closes_at: null, expected_revision: 7 });
  fixture.requests[1].resolve(response({ error: 'Schedule permission expired' }, 403));
  await settle();
  assert.equal(fixture.form(), form);
  assert.equal(notice(form).textContent, 'Schedule permission expired');
  assert.equal(form.dataset.saving, undefined);
  assert.equal(form.elements.state.disabled, false);
  assert.equal(form.querySelector('button').disabled, false);
  assert.equal(form.elements.opens_at.disabled, true);
  assert.equal(form.elements.closes_at.disabled, true);
  assert.equal(fixture.savedEvents.length, 0);
  form.elements.state.value = 'upcoming';
  fixture.emit(form.elements.state, 'change');
  assert.equal(form.elements.opens_at.disabled, false);
  assert.equal(form.elements.closes_at.disabled, false);
  fixture.emit(form, 'submit');
  fixture.requests[2].reject(new Error('Connection interrupted'));
  await settle();
  assert.equal(notice(form).textContent, 'Connection interrupted');
  assert.ok(form.elements.every((control) => !control.disabled));
  assert.equal(form.dataset.saving, undefined);
});

test('new-year terms start at revision zero and remain selected after save', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const addYear = fixture.root.querySelector('[data-add-year]');
  addYear.querySelector('input').value = '2027';
  fixture.emit(addYear, 'submit');
  assert.equal(addYear.querySelector('input').value, '');
  const form = fixture.form('Spring_2027');
  assert.equal(form.elements.state.value, 'upcoming');
  assert.match(form.textContent, /Course data unavailable/);
  fixture.emit(form, 'submit');
  assert.deepEqual(body(fixture.requests[1]), { state: 'upcoming', opens_at: null, closes_at: null, expected_revision: 0 });
  fixture.requests[1].resolve(response({ policy: { revision: 1, polling_enabled: false } }));
  await settle();
  assert.equal(notice(fixture.form('Spring_2027')).textContent, 'Spring 2027 saved. Tracking is upcoming.');
  assert.equal(fixture.root.querySelector('[data-term-year]').value, '2027');
});

test('invalid successful term acknowledgments retain the draft and revision for retry', async () => {
  const fixture = await trackingTermsRuntime([term()]);
  const form = fixture.form();
  form.elements.opens_at.value = '2026-08-21T10:45';
  fixture.emit(form, 'submit');
  fixture.requests[1].resolve({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => { throw new SyntaxError('Login HTML'); } });
  await settle();
  assert.equal(fixture.form(), form);
  assert.equal(form.elements.opens_at.value, '2026-08-21T10:45');
  assert.equal(notice(form).textContent, 'Invalid JSON response.');
  assert.ok(form.elements.every((control) => !control.disabled));
  assert.equal(fixture.savedEvents.length, 0);
  fixture.emit(form, 'submit');
  assert.equal(body(fixture.requests[2]).expected_revision, 7);
  fixture.requests[2].resolve(response({}));
  await settle();
  assert.equal(fixture.form(), form);
  assert.equal(notice(form).textContent, 'Invalid term settings response.');
  assert.equal(fixture.savedEvents.length, 0);
});
