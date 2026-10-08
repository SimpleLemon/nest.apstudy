import { calendarScript } from "./helpers/calendar-script.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function runtime(options = {}) {
    const window = options.window || {};
    const storage = [];
    const context = vm.createContext({ window, AbortController, DOMException: globalThis.DOMException, Date, URL, URLSearchParams, console: { warn() {}, error() {} }, localStorage: options.localStorage || {
        getItem(key) { storage.push(['read', key]); return null; },
        setItem(key) { storage.push(['write', key]); }, removeItem() {},
    } });
    for (const file of ['state.js', 'preferences.js', 'integrations/data.js', 'core.js']) vm.runInContext(calendarScript(fs.readFileSync(new URL(`../../static/js/calendar/${file}`, import.meta.url), 'utf8'), { 'state.js': 'APStudyCalendarState', 'preferences.js': 'APStudyCalendarPreferences', 'integrations/data.js': 'APStudyCalendarData', 'core.js': 'APStudyCalendarCore' }[file]), context);
    const state = window.APStudyCalendarState.createCalendarState({ defaultDashboardView: 'week', readOnly: true });
    state.calendars.personal = { visible: true, color: '#ffffff' };
    return { window, state, storage };
}

function preferences(r, options = {}) {
    return r.window.APStudyCalendarPreferences.createCalendarPreferences({
        state: r.state, strictLoad: true, authenticatedReadOnly: true,
        constants: { loadRetryCooldownMs: 15000 },
        getSavedCalendarInfo: (prefs, cal) => prefs[cal], renderCalendarMenu() {}, ...options,
    });
}

test('authenticated read-only calendar applies saved filters without local storage or writes', async () => {
    const r = runtime(); let requests = 0;
    const api = preferences(r, { dataAdapter: { async loadPreferences() { requests++; return { response: { ok: true }, payload: { preferences: [{ calendar_name: 'personal', visible: false, color_hex: '#123456' }] } }; } } });
    await api.loadCalendarState();
    assert.equal(r.state.calendars.personal.visible, false);
    assert.equal(r.state.calendars.personal.color, '#123456');
    api.writeCalendarStateToStorage(); api.queueCalendarPreferenceSave('personal');
    assert.equal(r.state.ui.preferenceDirty.size, 0);
    assert.equal(requests, 1); assert.deepEqual(r.storage, []);
});

for (const failure of ['http', 'malformed', 'network']) test(`strict preference ${failure} failures reject and allow immediate retry`, async () => {
    const r = runtime(); let first = true;
    const api = preferences(r, { dataAdapter: { async loadPreferences() {
        if (first) { first = false; if (failure === 'network') throw Error('offline'); return { response: { ok: failure !== 'http' }, payload: {} }; }
        return { response: { ok: true }, payload: { preferences: [] } };
    } } });
    await assert.rejects(api.loadCalendarState());
    assert.equal(r.state.preferences.loaded, false);
    await api.loadCalendarState(); assert.equal(r.state.preferences.loaded, true);
});

test('public share never loads private preferences', async () => {
    const r = runtime(); let requests = 0;
    const api = preferences(r, { authenticatedReadOnly: false, dataAdapter: { loadPreferences() { requests++; } } });
    await api.loadCalendarState(); assert.equal(requests, 0);
});

test('disposed preference response cannot change filters or establish readiness', async () => {
    const r = runtime(); let resolve; let disposed = false;
    const api = preferences(r, { lifecycle: { isDisposed: () => disposed }, dataAdapter: { loadPreferences: () => new Promise(r => { resolve = r; }) } });
    const loading = api.loadCalendarState(); disposed = true;
    resolve({ response: { ok: true }, payload: { preferences: [{ calendar_name: 'personal', visible: false }] } });
    await assert.rejects(loading); assert.equal(r.state.preferences.loaded, false); assert.equal(r.state.calendars.personal.visible, true);
});

for (const fail of ['range', 'preferences', null]) test(`strict initial calendar load ${fail || 'success'} determines readiness`, async () => {
    const r = runtime(); let preferenceLoads = 0;
    const noop = () => {};
    const api = r.window.APStudyCalendarData.createCalendarData({
        state: r.state, strictLoad: true, authenticatedReadOnly: true,
        constants: { calendarBufferDays: 7 },
        dataAdapter: { async loadRange() { if (fail === 'range') throw Error('range failed'); return { events: [], sources: [] }; } },
        getStartOfWeek: date => date, getEventCalendarKey: event => event.calendar_id,
        buildSimulatedMeetingEvents: () => [], ensureSimulatedCalendarPreference: noop,
        hydrateSelectedSimulatedSections: noop, initCalendarState: noop,
        async loadCalendarState() { preferenceLoads++; if (fail === 'preferences') throw Error('preferences failed'); },
        queueCalendarPreferenceSave: noop, render: noop, writeCalendarStateToStorage: noop,
    });
    if (fail) await assert.rejects(api.loadCalendarData()); else await api.loadCalendarData();
    assert.equal(r.state.loadingDashboard, false);
    assert.equal(preferenceLoads, fail === 'range' ? 0 : 1);
    assert.deepEqual(r.storage, []);
});

test('writable extension startup rejects offline data without consulting Canvas local cache', async () => {
    const r = runtime(); r.state.public.readOnly = false;
    const noop = () => {};
    const api = r.window.APStudyCalendarData.createCalendarData({
        state: r.state, strictLoad: true, authenticatedReadOnly: true,
        constants: { calendarBufferDays: 7, eventsCacheKey: 'calendarEventsCache' },
        dataAdapter: { async loadRange() { throw Error('offline'); } },
        getStartOfWeek: date => date, getEventCalendarKey: event => event.calendar_id,
        buildSimulatedMeetingEvents: () => [], ensureSimulatedCalendarPreference: noop,
        hydrateSelectedSimulatedSections: noop, initCalendarState: noop,
        loadCalendarState: noop, queueCalendarPreferenceSave: noop,
        render: noop, writeCalendarStateToStorage: noop,
    });
    await assert.rejects(api.loadCalendarData(), /offline/);
    assert.deepEqual(r.storage, []);
    assert.equal(r.state.loadingDashboard, false);
});

function calendarData(r, options = {}) {
    const noop = () => {};
    return r.window.APStudyCalendarData.createCalendarData({
        state: r.state, constants: { calendarBufferDays: 0 },
        getStartOfWeek: date => date, getEventCalendarKey: event => event.calendar_id,
        buildSimulatedMeetingEvents: () => [], ensureSimulatedCalendarPreference: noop,
        hydrateSelectedSimulatedSections: noop, initCalendarState: noop, loadCalendarState: noop,
        queueCalendarPreferenceSave: noop, render: noop, writeCalendarStateToStorage: noop,
        ...options,
    });
}

const range = (start, end) => ({ start: new Date(start), end: new Date(end) });

for (const initial of [true, false]) test(`${initial ? 'initial' : 'navigation'} calendar load failure retains known data and supports retry`, async () => {
    const r = runtime(); const notices = []; let fail = true, requests = 0;
    r.window.APStudyToast = { show: notice => notices.push(notice) };
    const saved = [{ id: 'saved', startDate: new Date('2025-01-01'), endDate: new Date('2025-01-01') }];
    const sources = [{ id: 'known' }];
    r.state.events = saved; r.state.calendarSources = sources; r.state.feedConfigured = true;
    const api = calendarData(r, { dataAdapter: { loadRange() {
        requests++; if (fail) return { response: { ok: false, status: 503 }, payload: { error: 'offline' } };
        return { events: [], sources: [], feed_configured: false };
    } } });
    const dates = range('2026-01-01', '2026-01-08');
    await (initial ? api.loadCalendarData() : api.ensureEventsForRange(dates));
    assert.equal(r.state.events, saved); assert.equal(r.state.calendarSources, sources); assert.equal(r.state.feedConfigured, true);
    assert.equal(r.state.loadedRanges.length, 0); assert.equal(r.state.pendingRanges.size, 0); assert.equal(r.state.loadingDashboard, false);
    assert.match(r.state.loadError.message, /could not load/); assert.equal(notices.length, 1);
    fail = false; await api.retryCalendarLoad();
    assert.equal(requests, 2); assert.equal(r.state.loadError, null); assert.equal(r.state.feedConfigured, false);
    assert.equal(r.state.loadedRanges.length, 1);
});

test('first load failure has an unavailable state and alert fallback, with no loaded coverage', async () => {
    const r = runtime(); const messages = []; r.window.alert = message => messages.push(message);
    const api = calendarData(r, { dataAdapter: { loadRange() { throw Error('offline'); } } });
    await api.loadCalendarData();
    assert.match(r.state.loadError.message, /Calendar data could not load/);
    assert.equal(r.state.loadError.initial, true); assert.equal(messages.length, 1);
    assert.equal(r.state.events.length, 0); assert.equal(r.state.loadedRanges.length, 0);
});

for (const cancelled of ['abort', 'disposed', 'obsolete']) test(`${cancelled} navigation load cannot publish failure feedback`, async () => {
    const r = runtime(); let reject, disposed = false, notices = 0, count = 0;
    r.window.APStudyToast = { show() { notices++; } };
    const api = calendarData(r, { lifecycle: { isDisposed: () => disposed }, dataAdapter: { loadRange() {
        if (++count > 1) return { events: [], feed_configured: true };
        return new Promise((resolve, no) => { reject = no; });
    } } });
    const pending = api.ensureEventsForRange(range('2026-01-01', '2026-01-08'));
    if (cancelled === 'disposed') disposed = true;
    if (cancelled === 'obsolete') await api.ensureEventsForRange(range('2026-02-01', '2026-02-08'));
    reject(cancelled === 'abort' ? new globalThis.DOMException('cancelled', 'AbortError') : Error('offline'));
    await pending;
    assert.equal(notices, 0); assert.equal(r.state.loadError, null); assert.equal(r.state.pendingRanges.size, 0);
});

test('disjoint loaded calendar ranges still fetch gaps and merge adjacent coverage', async () => {
    const r = runtime(); const requests = [];
    const api = calendarData(r, { dataAdapter: { async loadRange({ range }) { requests.push(range); return { events: [] }; } } });
    const first = range('2026-01-01', '2026-01-08');
    const last = range('2026-01-15', '2026-01-22');
    const gap = range('2026-01-08', '2026-01-15');
    await api.ensureEventsForRange(first);
    await api.ensureEventsForRange(last);
    assert.equal(r.state.loadedRanges.length, 2);
    await api.ensureEventsForRange(gap);
    assert.equal(requests.length, 3);
    assert.equal(r.state.loadedRanges.length, 1);
    await api.ensureEventsForRange(range('2026-01-02', '2026-01-20'));
    assert.equal(requests.length, 3);
});

for (const oldResult of ['failure', 'success']) test(`obsolete calendar reload ${oldResult} preserves the newer successful state`, async () => {
    const r = runtime(); const pending = [];
    const api = calendarData(r, { dataAdapter: { loadRange() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } } });
    const old = api.loadCalendarData();
    const current = api.loadCalendarData();
    pending[1].resolve({ events: [{ id: 'current', start: '2026-10-02T10:00:00Z' }], feed_configured: true });
    await current;
    if (oldResult === 'failure') pending[0].reject(Error('offline')); else pending[0].resolve({ events: [], feed_configured: false });
    await old;
    assert.equal(r.state.events[0].id, 'current');
    assert.equal(r.state.feedConfigured, true);
    assert.equal(r.state.loadingDashboard, false);
});

function preferenceQueue(r, savePreferences, options = {}) {
    r.state.public.readOnly = false;
    const timers = new Map(); let id = 0; const listeners = {};
    const lifecycle = {
        setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
        addEventListener(target, type, fn) { listeners[type] = fn; },
    };
    const api = preferences(r, { lifecycle, dataAdapter: { savePreferences }, constants: {
        batchLimit: 5,
        preferenceSaveDelayMs: 1, preferenceSaveRetryDelaysMs: [1, 2], preferenceSaveWarningCooldownMs: 100,
    }, ...options });
    async function tick() {
        assert.equal(timers.size, 1);
        const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
        await new Promise(resolve => setImmediate(resolve));
    }
    return { api, timers, listeners, tick };
}

test('preference failures exhaust their retry budget and resume on an edit or reconnect', async () => {
    const r = runtime(); let calls = 0; let failure = true;
    const q = preferenceQueue(r, async () => { calls++; if (failure) throw Error('offline'); return { response: { ok: true }, payload: {} }; });
    q.api.queueCalendarPreferenceSave('personal');
    await q.tick(); await q.tick(); await q.tick();
    assert.equal(calls, 3);
    assert.equal(q.timers.size, 0);
    assert.equal(r.state.ui.preferenceRetryPaused, true);
    assert.equal(r.state.ui.preferenceDirty.has('personal'), true);
    assert.match(r.state.ui.preferenceNotice, /kept on this device/);
    q.api.queueCalendarPreferenceSave('personal');
    assert.equal(r.state.ui.preferenceRetryCount, 0);
    await q.tick(); await q.tick(); await q.tick();
    assert.equal(calls, 6); assert.equal(q.timers.size, 0);
    failure = false; q.listeners.online(); await q.tick();
    assert.equal(calls, 7); assert.equal(r.state.ui.preferenceDirty.size, 0);
    assert.equal(r.state.ui.preferenceRetryPaused, false); assert.equal(r.state.ui.preferenceNotice, '');
});

test('item validation errors retain only failed preferences and wait for a new edit', async () => {
    const r = runtime(); r.state.calendars.second = { visible: true, color: '#ffffff' };
    const q = preferenceQueue(r, async () => ({ response: { ok: true }, payload: { errors: [{ calendar_name: 'personal', error: 'Invalid color' }] } }));
    q.api.queueCalendarPreferenceSave('personal'); q.api.queueCalendarPreferenceSave('second');
    await q.tick();
    assert.equal(q.timers.size, 0); assert.equal(r.state.ui.preferenceRetryPaused, true);
    assert.deepEqual([...r.state.ui.preferenceDirty], ['personal']);
});

test('pending preference save and newer edits survive cached and stored preference reloads', async () => {
    const r = runtime({ localStorage: { getItem: () => JSON.stringify({ personal: { visible: true, color: '#ffffff' } }), setItem() {}, removeItem() {} } });
    r.state.preferences.loaded = true;
    r.state.preferences.cache = { personal: { visible: true, color_hex: '#ffffff' }, other: { visible: false, color_hex: '#654321' } };
    r.state.calendars.other = { visible: true, color: '#ffffff' };
    let resolve; const sent = [];
    const q = preferenceQueue(r, request => {
        sent.push(JSON.parse(JSON.stringify(request.payload.preferences)));
        if (sent.length === 1) return new Promise(done => { resolve = done; });
        return { response: { ok: true }, payload: {} };
    }, { strictLoad: false, authenticatedReadOnly: false });
    r.state.calendars.personal = { visible: false, color: '#123456' };
    q.api.queueCalendarPreferenceSave('personal'); await q.tick();
    await q.api.loadCalendarState();
    assert.equal(r.state.calendars.personal.visible, false); assert.equal(r.state.calendars.personal.color, '#123456');
    assert.equal(r.state.calendars.other.visible, false); assert.equal(r.state.calendars.other.color, '#654321');
    r.state.calendars.personal.color = '#abcdef'; q.api.queueCalendarPreferenceSave('personal');
    resolve({ response: { ok: true }, payload: {} }); await new Promise(done => setImmediate(done));
    await q.api.loadCalendarState();
    assert.equal(r.state.calendars.personal.color, '#abcdef'); assert.equal(r.state.ui.preferenceDirty.has('personal'), true);
    await q.tick();
    assert.equal(sent.length, 2); assert.equal(sent[1][0].color_hex, '#abcdef');
    await q.api.loadCalendarState(); assert.equal(r.state.calendars.personal.color, '#abcdef');
});

test('real event refresh rebuild preserves pending preferences and publishes a later edit after acknowledgement', async () => {
    const r = runtime(); r.state.preferences.loaded = true;
    r.state.preferences.cache = { personal: { visible: true, color_hex: '#ffffff' } };
    let resolve; const sent = [];
    const q = preferenceQueue(r, request => {
        sent.push(JSON.parse(JSON.stringify(request.payload.preferences)));
        if (sent.length === 1) return new Promise(done => { resolve = done; });
        return { response: { ok: true }, payload: {} };
    });
    const core = r.window.APStudyCalendarCore.createCalendarCore({ state: r.state,
        constants: { defaultLocalCalendarId: 'personal', defaultLocalCalendarName: 'Personal', simulatedCalendarName: 'Simulated' },
        callbacks: { buildSimulatedMeetingEvents: () => [], getCurrentViewCountRange: () => range('2026-01-01', '2026-01-08') },
    });
    const api = calendarData(r, { initCalendarState: core.initCalendarState, loadCalendarState: q.api.loadCalendarState });
    r.state.calendars.personal = { visible: false, color: '#123456' };
    q.api.queueCalendarPreferenceSave('personal'); await q.tick();
    const payload = { events: [], sources: [{ id: 'personal', color_hex: '#ffffff' }, { id: 'new', color_hex: '#fedcba' }] };
    await api.applyEventsPayload(payload);
    assert.equal(r.state.calendars.personal.visible, false); assert.equal(r.state.calendars.personal.color, '#123456');
    assert.equal(r.state.calendars.new.visible, true); assert.equal(r.state.calendars.new.color, '#fedcba');
    r.state.calendars.personal.color = '#abcdef'; q.api.queueCalendarPreferenceSave('personal');
    resolve({ response: { ok: true }, payload: {} }); await new Promise(done => setImmediate(done));
    await api.applyEventsPayload(payload);
    assert.equal(r.state.calendars.personal.color, '#abcdef'); assert.equal(r.state.ui.preferenceDirty.has('personal'), true);
    await q.tick(); assert.equal(sent[1][0].color_hex, '#abcdef');
    await api.applyEventsPayload(payload); assert.equal(r.state.calendars.personal.color, '#abcdef');
});

for (const failure of ['request', 'validation']) test(`failed pending preference ${failure} preserves edited values during reload`, async () => {
    const r = runtime(); r.state.preferences.loaded = true;
    r.state.preferences.cache = { personal: { visible: true, color_hex: '#ffffff' } };
    let settle;
    const q = preferenceQueue(r, () => new Promise((resolve, reject) => { settle = failure === 'request' ? reject : resolve; }));
    r.state.calendars.personal = { visible: false, color: '#123456' };
    q.api.queueCalendarPreferenceSave('personal'); await q.tick();
    settle(failure === 'request' ? Error('offline') : { response: { ok: true }, payload: { errors: [{ calendar_name: 'personal', error: 'validation' }] } });
    await new Promise(done => setImmediate(done)); await q.api.loadCalendarState();
    assert.equal(r.state.calendars.personal.visible, false); assert.equal(r.state.calendars.personal.color, '#123456');
    assert.equal(r.state.ui.preferenceDirty.has('personal'), true);
});

for (const failure of ['getter', 'read', 'cleanup']) test(`optional calendar storage ${failure} failure preserves remote loading and cleanup`, async () => {
    const window = {};
    const broken = {
        getItem() { if (failure === 'read') throw Error('SecurityError'); return '{invalid'; },
        removeItem() { throw Error('cleanup refused'); },
        setItem() { throw Error('QuotaExceededError'); },
    };
    if (failure === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw Error('SecurityError'); } });
    else window.localStorage = broken;
    const r = runtime({ window }); r.state.public.readOnly = false;
    let ranges = 0, prefs = 0, renders = 0;
    const pref = preferences(r, { authenticatedReadOnly: false, strictLoad: false,
        dataAdapter: { loadPreferences() { prefs++; return { response: { ok: true }, payload: { preferences: [] } }; } },
    });
    const api = calendarData(r, { dataAdapter: { loadRange() { ranges++; return { events: [] }; } },
        loadCalendarState: pref.loadCalendarState, render() { renders++; },
    });
    await api.loadCalendarData();
    assert.equal(ranges, 1); assert.equal(prefs, 1);
    assert.equal(r.state.loadingDashboard, false); assert.ok(renders >= 2);
});

test('failed local preference writes still queue remote color and visibility saves and render', async () => {
    const r = runtime({ localStorage: { getItem() { return null; }, setItem() { throw Error('quota'); }, removeItem() {} } });
    r.state.public.readOnly = false;
    const sent = []; const q = preferenceQueue(r, request => {
        sent.push(request.payload.preferences);
        return { response: { ok: true }, payload: {} };
    });
    let renders = 0;
    const api = calendarData(r, { writeCalendarStateToStorage: q.api.writeCalendarStateToStorage,
        queueCalendarPreferenceSave: q.api.queueCalendarPreferenceSave, render() { renders++; },
    });
    api.setCalendarColor('personal', '#123456');
    api.toggleCalendarVisibility('personal');
    await q.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0].color_hex, '#123456'); assert.equal(sent[0][0].visible, false);
    assert.equal(renders, 2); assert.equal(r.state.ui.preferenceDirty.size, 0);
    q.api.saveCalendarState(); await q.tick(); assert.equal(sent.length, 2);
});

for (const failure of ['http', 'network']) test(`calendar refresh ${failure} rejects contextually, reports manual failure, and permits retry`, async () => {
    const r = runtime(); r.state.public.readOnly = false;
    const feedback = []; r.window.APStudyToast = { show(options) { feedback.push(options); } };
    let fail = true, fetches = 0, released = 0;
    const api = calendarData(r, { lifecycle: { trackAbortController: () => new AbortController(), releaseAbortController() { released++; } },
        dataAdapter: {
            refresh() { if (fail && failure === 'network') throw Error('offline'); return { response: { ok: !fail, status: fail ? 503 : 200 }, payload: { error: 'Upstream unavailable' } }; },
            loadRange() { fetches++; return { events: [] }; },
        },
    });
    await assert.rejects(api.refreshCalendarFeed(), error => /Calendar feed refresh failed/.test(error.message) && (failure === 'http' ? error.status === 503 : error.cause.message === 'offline'));
    await api.runManualRefresh(range('2026-01-01', '2026-01-08'));
    assert.equal(fetches, 0); assert.equal(feedback.length, 1);
    assert.match(feedback[0].message, /Try Refresh again/);
    assert.equal(r.state.refreshInFlight, false);
    fail = false; await api.runManualRefresh(range('2026-01-01', '2026-01-08'));
    assert.equal(fetches, 1); assert.equal(feedback.length, 1); assert.equal(released, 4);
});

test('stale background refresh failure retains events, releases its lock, and retries on a later load', async () => {
    const r = runtime(); r.state.public.readOnly = false;
    let fail = true, refreshes = 0, fetches = 0;
    const api = calendarData(r, { dataAdapter: {
        refresh() { refreshes++; return { response: { ok: !fail, status: fail ? 503 : 200 }, payload: {} }; },
        loadRange() { fetches++; return { events: [{ id: 'saved', start: '2026-01-01T10:00:00Z' }], feed_configured: true, refresh_interval_minutes: 1 }; },
    } });
    await api.loadCalendarData(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetches, 1); assert.equal(refreshes, 1); assert.equal(r.state.events[0].id, 'saved');
    assert.equal(r.state.refreshInFlight, false);
    fail = false; await api.loadCalendarData(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetches, 3); assert.equal(refreshes, 2); assert.equal(r.state.refreshInFlight, false);
});

test('toggle refresh failure remains pending for reconnect without an automatic retry loop', async () => {
    const r = runtime(); r.state.public.readOnly = false;
    r.state.calendars.personal.kind = 'external'; r.state.calendars.personal.visible = false;
    const timers = new Map(), listeners = {}; let id = 0, fail = true, fetches = 0;
    const lifecycle = {
        setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
        addEventListener(target, type, fn) { listeners[type] = fn; },
    };
    const api = calendarData(r, { lifecycle, dataAdapter: {
        refresh() { return { response: { ok: !fail, status: fail ? 503 : 200 }, payload: {} }; },
        loadRange() { fetches++; return { events: [] }; },
    } });
    async function tick() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); await new Promise(resolve => setImmediate(resolve)); }
    api.toggleCalendarVisibility('personal'); await tick();
    assert.equal(timers.size, 0); assert.equal(fetches, 0);
    assert.equal(r.state.ui.toggleRefreshNeedsFeed, true); assert.equal(r.state.refreshInFlight, false);
    fail = false; listeners.online(); await tick();
    assert.equal(fetches, 1); assert.equal(r.state.ui.toggleRefreshNeedsFeed, false);
});

test('disposed calendar refresh cannot fetch, display a failure notice, or leak its controller', async () => {
    const r = runtime(); r.state.public.readOnly = false;
    let resolve, disposed = false, released = 0, fetches = 0, notices = 0;
    r.window.APStudyToast = { show() { notices++; } };
    const api = calendarData(r, { lifecycle: {
        isDisposed: () => disposed, trackAbortController: () => new AbortController(), releaseAbortController() { released++; },
    }, dataAdapter: {
        refresh: () => new Promise(done => { resolve = done; }), loadRange() { fetches++; return { events: [] }; },
    } });
    const manual = api.runManualRefresh(range('2026-01-01', '2026-01-08')); disposed = true;
    resolve({ response: { ok: true, status: 200 }, payload: {} }); await manual;
    assert.equal(fetches, 0); assert.equal(notices, 0); assert.equal(released, 1);
    assert.equal(r.state.refreshInFlight, false);
});

test('range failures preserve HTTP response, URL, payload and server message', async () => {
    const r = runtime(); let released = 0;
    const response = { ok: false, status: 429, url: 'https://nest.example/api/calendar/events' };
    const payload = { error: 'Calendar provider temporarily unavailable', retry_after: 30 };
    const api = calendarData(r, { lifecycle: { trackAbortController: () => new AbortController(), releaseAbortController() { released++; } },
        dataAdapter: { loadRange: () => ({ response, payload }) },
    });
    await assert.rejects(api.fetchEventsForRange(range('2026-01-01', '2026-01-08')), error => {
        assert.match(error.message, /HTTP 429.*Calendar provider temporarily unavailable/);
        assert.equal(error.status, 429); assert.equal(error.url, response.url);
        assert.equal(error.response, response); assert.equal(error.payload, payload); return true;
    });
    assert.equal(released, 1);
});

for (const failure of ['transport', 'decoding', 'abort']) test(`range ${failure} failure retains its original cause or cancellation`, async () => {
    const r = runtime(); const cause = failure === 'abort' ? new globalThis.DOMException('cancelled', 'AbortError') : new Error(failure);
    const api = calendarData(r, { dataAdapter: { fetch: async () => {
        if (failure !== 'decoding') throw cause;
        return { ok: true, status: 200, json: async () => { throw cause; } };
    } } });
    await assert.rejects(api.fetchEventsForRange(range('2026-01-01', '2026-01-08')), error => {
        if (failure === 'abort') assert.equal(error, cause);
        else if (failure === 'decoding') { assert.match(error.message, /invalid JSON/); assert.equal(error.cause.cause, cause); }
        else { assert.match(error.message, /Unable to fetch calendar events/); assert.equal(error.cause, cause); }
        return true;
    });
});

test('normal date parsing preserves all-day local midnight and timed instants', async () => {
    const r = runtime({ window: { APStudyDate: { format: () => 'formatted' } } });
    const api = calendarData(r);
    await api.applyEventsPayload({ events: [{ start: '2026-02-01', end: '2026-02-02', all_day: true }, { start: '2026-02-01T15:30:00Z' }] });
    const allDay = r.state.events.find(event => event.isAllDay);
    assert.equal(allDay.startDate.getFullYear(), 2026); assert.equal(allDay.startDate.getMonth(), 1);
    assert.equal(allDay.startDate.getDate(), 1); assert.equal(allDay.startDate.getHours(), 0);
    const timed = r.state.events.find(event => !event.isAllDay);
    assert.equal(timed.startDate.toISOString(), '2026-02-01T15:30:00.000Z');
});
