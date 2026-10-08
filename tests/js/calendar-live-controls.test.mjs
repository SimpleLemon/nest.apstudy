import assert from 'node:assert/strict';
import test from 'node:test';
import featureModules from './helpers/feature-modules.cjs';
import { createCalendarDOM, deferred, settle } from './helpers/calendar-dom.mjs';
const { loadFeatureModule } = featureModules;
const connection = { id: 'account-1', label: 'Student', provider: 'google', status: 'active', pending: 0,
    calendars: [{ id: 'cal-a', name: 'School', selected: true, writable: true }, { id: 'cal-b', name: 'Other', selected: false, writable: true }], export_sources: ['personal'], conflicts: 0 };
function payload(item = connection, enabled = true) { return { window: { start: '2026-01-01', end: '2026-12-31' }, capabilities: { providers: { google: enabled } }, connections: [item] }; }
async function connections(request) {
    const dom = createCalendarDOM(); loadFeatureModule('calendar/connections.js', dom.context);
    const host = dom.document.createElement('div'); dom.document.body.append(host);
    const api = dom.window.APStudyCalendarConnections.mount(host, { request }); await settle();
    const button = label => host.querySelectorAll('button').find(node => node.textContent === label);
    return { ...dom, host, api, button };
}

test('connection controls send selected calendars, consent and explicit cleanup choices', async () => {
    const requests = [];
    const f = await connections(async (path, body) => { requests.push({ path, body }); return payload(); });
    const calendars = f.host.querySelectorAll('[name="calendar"]'); calendars[0].checked = false; calendars[1].checked = true;
    const sources = f.host.querySelectorAll('[name="source"]'); sources[1].checked = true;
    f.button('Save synchronization choices').click(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1])), { path: '/connections/account-1/configure', body: { calendar_ids: ['cal-b'], export_sources: ['personal', 'canvas'], consent_version: 1 } });
    f.button('Disconnect').click(); await settle();
    assert.equal(requests.find(item => item.path.endsWith('/disconnect')).body.cleanup, false);
    f.host.querySelector('details').querySelector('input').checked = true;
    f.button('Disconnect').click(); await settle();
    assert.equal(requests.filter(item => item.path.endsWith('/disconnect'))[1].body.cleanup, true);
    f.api.dispose();
});

test('connection failures preserve conflict resolution idempotency across refresh and retry', async () => {
    const requests = []; let attempts = 0;
    const conflict = { id: 'conflict-1', revision: 'revision-7', local_body: null, remote_body: null };
    const f = await connections(async (path, body) => {
        requests.push({ path, body });
        if (path.endsWith('/resolve')) { if (++attempts === 1) throw Error('provider_unavailable'); return {}; }
        if (path === '/calendar-conflicts') return { conflicts: [conflict] };
        return payload({ ...connection, conflicts: 1 });
    });
    f.button('Keep APStudy version').click(); await settle();
    assert.match(f.host.querySelector('[role="status"]').textContent, /provider is unavailable/);
    await f.api.refresh(); f.button('Keep APStudy version').click(); await settle();
    const writes = requests.filter(item => item.path.endsWith('/resolve'));
    assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body);
    assert.equal(writes[0].body.revision, 'revision-7'); assert.equal(writes[0].body.choice, 'local');
    assert.ok(writes[0].body.idempotency_key);
    f.api.dispose();
});

test('connections expose provider review choices and suppress unavailable connect buttons', async () => {
    const calls = [];
    const f = await connections(async (path, body) => {
        calls.push({ path, body });
        if (path === '/calendar-conflicts') return { conflicts: [{ id: 'review-1', revision: 'v2', reason: 'provider_review_required', source_url: 'https://calendar.google.com/calendar/event?id=abc' }] };
        return payload({ ...connection, conflicts: 1 }, false);
    });
    assert.equal(f.button('Connect Google').disabled, true); assert.equal(f.button('Keep APStudy version'), undefined);
    assert.equal(f.host.querySelector('a').getAttribute('href'), 'https://calendar.google.com/calendar/event?id=abc');
    f.button('Recheck provider changes').click(); await settle();
    assert.equal(calls.find(item => item.path.endsWith('/resolve')).body.choice, 'retry'); f.api.dispose();
});

for (const pendingType of ['load', 'configure']) test(`disposed connections ignore pending ${pendingType} responses and do not start follow-up loads`, async () => {
    const pending = deferred(); const calls = [];
    const f = await connections(path => {
        calls.push(path);
        return pendingType === 'load' || path.endsWith('/configure') ? pending.promise : payload();
    });
    if (pendingType === 'configure') f.button('Save synchronization choices').click();
    f.api.dispose(); pending.resolve(payload()); await settle();
    assert.equal(f.host.children.length, 0);
    assert.equal(calls.length, pendingType === 'load' ? 1 : 2);
    f.window.dispatchEvent(f.event('focus')); await settle();
    assert.equal(calls.length, pendingType === 'load' ? 1 : 2);
});

const event = { event_ref: 'user:event-1', source: 'personal', title: 'Study' };
const source = { source_ref: 'canvas:account-1', label: 'Student Canvas', destination: 'Personal', state: 'applied', linked: false, allowed: true };
function mirrorPayload({ linked = false, allowed = true, pending_id = null, caps = true, revision = 'r1' } = {}) {
    return { item: { event_ref: event.event_ref, title: event.title, expected_revision: revision, sources: [{ ...source, linked, allowed, pending_id }] }, capabilities: { calendar_two_way_writeback: caps, calendar_mirroring: caps } };
}
const result = (payload, ok = true) => ({ response: { ok, status: ok ? 200 : 503 }, payload });
async function mirrors({ loadMirrors = () => result(mirrorPayload()), changeMirror = () => result({ result: { state: 'queued' } }), deferDialogCloseEvents = false } = {}) {
    const dom = createCalendarDOM({ deferDialogCloseEvents }); let reloads = 0;
    const api = loadFeatureModule('calendar/events/mirrors.js', dom.context).createCalendarMirrors({ document: dom.document, view: dom.window, lifecycle: dom.lifecycle, adapter: { loadMirrors, changeMirror }, reload: () => reloads++ });
    const opener = dom.document.createElement('button'); dom.document.body.append(opener);
    assert.equal(api.open({ event, opener }), true); await settle();
    const dialog = dom.document.querySelector('dialog');
    return { ...dom, api, dialog, opener, q: selector => dialog.querySelector(selector), reloads: () => reloads };
}

test('mirror controller accepts personal items only and requires confirmation plus provider capability', async () => {
    const f = await mirrors({ loadMirrors: () => result(mirrorPayload({ linked: true, caps: false })) });
    assert.equal(f.api.open({ event: { event_ref: 'canvas:assignment-1' } }), false);
    assert.equal(f.api.open({ event: { ...event, source: 'simulated' } }), false);
    assert.equal(f.q('[data-action="mirror"]').disabled, true);
    assert.equal(f.q('[data-action="unlink"]').disabled, false);
    assert.equal(f.q('[data-action="delete_local"]').disabled, true);
    f.q('[data-confirm]').checked = true; f.dialog.dispatchEvent(f.event('change'));
    assert.equal(f.q('[data-action="delete_local"]').disabled, false);
    assert.equal(f.q('[data-action="delete_both"]').disabled, true);
    f.api.close(); assert.equal(f.document.activeElement, f.opener); assert.equal(f.controllers.size, 0);
});

test('mirror mutation uses the selected account and current revision and refreshes queued state', async () => {
    const writes = []; let loads = 0;
    const f = await mirrors({ loadMirrors: () => result(mirrorPayload({ revision: ++loads === 1 ? 'r1' : 'r2', pending_id: loads > 1 ? 'pending-1' : null })), changeMirror: request => { writes.push(request); return result({ result: { state: 'queued' } }); } });
    f.q('[data-action="mirror"]').click(); await settle();
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].payload)), { event_ref: 'user:event-1', source_ref: 'canvas:account-1', action: 'mirror', expected_revision: 'r1' });
    assert.match(f.q('[data-status]').textContent, /Queued/);
    assert.equal(f.q('[data-action="mirror"]').disabled, true); assert.equal(f.q('[data-action="unlink"]').disabled, false);
    f.api.close(); assert.equal(f.timers.size, 0); assert.equal(f.controllers.size, 0);
});

test('failed mirror deletion refreshes revision, clears destructive confirmation, and never reloads the page', async () => {
    let loads = 0; const writes = [];
    const f = await mirrors({ loadMirrors: () => result(mirrorPayload({ linked: true, revision: `r${++loads}` })), changeMirror: request => { writes.push(request); return result({ error: 'conflict' }, false); } });
    f.q('[data-confirm]').checked = true; f.dialog.dispatchEvent(f.event('change'));
    f.q('[data-action="delete_both"]').click(); await settle();
    assert.equal(writes[0].payload.expected_revision, 'r1'); assert.equal(loads, 2);
    assert.equal(f.q('[data-confirm]').checked, false); assert.equal(f.q('[data-action="delete_both"]').disabled, true);
    assert.match(f.q('[data-status]').textContent, /not confirmed/); assert.equal(f.reloads(), 0); f.api.close();
});

for (const stage of ['load', 'write']) test(`closing mirror dialog aborts pending ${stage} and ignores its eventual response`, async () => {
    const pending = deferred(); let signal, loads = 0;
    const f = await mirrors({
        loadMirrors: request => { loads++; if (stage === 'load') { signal = request.signal; return pending.promise; } return result(mirrorPayload()); },
        changeMirror: request => { signal = request.signal; return pending.promise; },
    });
    if (stage === 'write') f.q('[data-action="mirror"]').click();
    f.lifecycle.dispose(); assert.equal(signal.aborted, true);
    pending.resolve(stage === 'load' ? result(mirrorPayload()) : result({ result: { state: 'deleted_local' } })); await settle();
    assert.equal(f.document.querySelector('dialog'), null); assert.equal(f.reloads(), 0); assert.equal(loads, 1);
    assert.equal(f.controllers.size, 0); assert.equal(f.timers.size, 0);
});

for (const action of ['route-display', 'display-override']) test(`extension ${action} dispatch preserves compatibility source and destination fields`, async () => {
    const dom = createCalendarDOM(); const calls = [];
    const panel = dom.document.createElement('section'); dom.document.body.append(panel);
    panel.setAttribute('data-calendar-extension-panel', '');
    const root = dom.document.createElement('div'); dom.document.body.append(root);
    const adapter = action === 'route-display' ? { setCanvasRouting: request => { calls.push(request); return { ok: true }; } }
        : { setDisplayOverride: request => { calls.push(request); return { ok: true }; } };
    const ui = loadFeatureModule('calendar/extension-ui.js', dom.context).createCalendarExtensionUi({
        root, state: { events: [{ source_type: 'canvas', event_ref: 'canvas:event-1' }] }, adapter,
        capabilities: { contractVersion: 1, readOnly: false, actions: { routeDisplayOverride: true }, data: {
            source: { source_id: 'compat-source', account_label: 'Student Canvas' },
            routing: { destination_calendar_id: 'local:compat', fallback_calendar_id: 'local:fallback' },
            writebacks: [{ state: 'retryable_failed', error_message: 'Check connection' }],
        } }, lifecycle: dom.lifecycle,
    });
    const control = root.querySelector(`[data-calendar-extension-action="${action}"]`);
    assert.ok(control); assert.equal(control.disabled, false);
    control.click(); await settle();
    assert.equal(calls.length, 1);
    if (action === 'route-display') { assert.equal(calls[0].sourceId, 'compat-source'); assert.equal(calls[0].destinationCalendarId, 'local:compat'); assert.equal(calls[0].fallbackCalendarId, 'local:fallback'); }
    else { assert.equal(calls[0].eventRef, 'canvas:event-1'); assert.equal(calls[0].calendarId, 'local:compat'); }
    ui.dispose();
});

for (const dismissal of ['api', 'replacement', 'native', 'native_replacement', 'escape', 'form']) test(`mirror ${dismissal} dismissal rejects late deletion before its deferred close event`, async () => {
    const pending = deferred(); let signal;
    const releases = [];
    const f = await mirrors({ deferDialogCloseEvents: true,
        loadMirrors: ({ eventRef }) => result({ ...mirrorPayload(), item: { ...mirrorPayload().item, event_ref: eventRef } }),
        changeMirror: request => { signal = request.signal; return pending.promise; },
    });
    f.q('[data-confirm]').checked = true; f.dialog.dispatchEvent(f.event('change'));
    f.q('[data-action="delete_local"]').click();
    assert.equal(signal.aborted, false); assert.equal(f.timers.size, 1);
    const originalRelease = f.lifecycle.releaseAbortController;
    f.lifecycle.releaseAbortController = controller => { releases.push(controller); originalRelease(controller); };
    let newer;
    if (dismissal === 'replacement' || dismissal === 'native_replacement') {
        if (dismissal === 'native_replacement') f.dialog.close();
        f.api.open({ event: { ...event, event_ref: 'user:event-2', title: 'Second item' } });
        await settle(); newer = f.document.querySelector('dialog');
        assert.notEqual(newer, f.dialog); assert.equal(newer.open, true);
        newer.querySelector('[data-refresh]').focus();
    } else if (dismissal === 'native') f.dialog.close();
    else if (dismissal === 'escape') f.dialog.dispatchEvent(f.event('cancel'));
    else if (dismissal === 'form') f.q('form').dispatchEvent(f.event('submit', { bubbles: true }));
    else f.api.close();
    assert.equal(f.closeEvents.length, 1);
    if (dismissal !== 'native') {
        assert.equal(signal.aborted, true);
        assert.equal(f.timers.size, 0);
        assert.equal(f.controllers.size, newer ? 1 : 0);
    }
    pending.resolve(result({ result: { state: 'deleted_local' } })); await settle();
    assert.equal(f.reloads(), 0);
    if (newer) { assert.equal(newer.isConnected, true); assert.equal(newer.open, true); }
    const focusBefore = f.document.activeElement;
    f.flushCloseEvents();
    assert.equal(f.document.querySelector('dialog'), newer || null);
    if (newer) assert.equal(f.document.activeElement, focusBefore);
    const releaseCount = releases.length;
    f.dialog.dispatchEvent(f.event('close')); assert.equal(releases.length, releaseCount);
    f.lifecycle.dispose(); f.flushCloseEvents();
    assert.equal(f.controllers.size, 0); assert.equal(f.timers.size, 0);
});

test('late mirror load cannot repopulate a closed dialog while its close event is queued', async () => {
    const pending = deferred(); let signal;
    const f = await mirrors({ deferDialogCloseEvents: true, loadMirrors: request => { signal = request.signal; return pending.promise; } });
    f.api.close(); assert.equal(signal.aborted, true);
    assert.equal(f.controllers.size, 0); assert.equal(f.timers.size, 0);
    pending.resolve(result(mirrorPayload())); await settle();
    assert.equal(f.q('[data-account]').children.length, 0);
    assert.equal(f.document.querySelector('dialog'), null);
    f.flushCloseEvents(); assert.equal(f.controllers.size, 0);
});
