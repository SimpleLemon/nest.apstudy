import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function runtime() {
    const window = {};
    const storage = [];
    const context = vm.createContext({ window, AbortController, Date, console: { warn() {}, error() {} }, localStorage: {
        getItem(key) { storage.push(['read', key]); return null; },
        setItem(key) { storage.push(['write', key]); }, removeItem() {},
    } });
    for (const file of ['state.js', 'preferences.js', 'integrations/data.js']) vm.runInContext(fs.readFileSync(new URL(`../../static/js/calendar/${file}`, import.meta.url), 'utf8'), context);
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
