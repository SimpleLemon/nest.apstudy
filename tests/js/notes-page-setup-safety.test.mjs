import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement, ok, settle } from './helpers/notes-runtime.mjs';

function setupPage() {
    const harness = createHarness();
    const { createPageSetupRuntime } = harness.load('page-setup.js', ['createPageSetupRuntime']);
    const popover = new FakeElement();
    const page = new FakeElement();
    const errors = [];
    const runtime = createPageSetupRuntime({
        noteId: 'test-note', editorPage: page, pageSetupPopover: popover,
        getCanEdit: () => true, getNoteCollaborationEnabled: () => false,
        setSaveStatus: (...args) => errors.push(args),
    });
    runtime.setLoadedPageSetup({}, {});
    runtime.bind();
    const scope = (value) => {
        const target = new FakeElement({ pageSetupScopeOption: value });
        target.selectors.set('closest:[data-page-setup-scope-option]', [target]);
        popover.dispatch('click', { target, preventDefault() {} });
    };
    const edit = (key, value) => {
        const input = new FakeElement({ pageSetupInput: key });
        input.value = String(value);
        if (key === 'sideMargins') {
            input.selectors.set('closest:[data-page-setup-input="sideMargins"]', [input]);
            popover.dispatch('input', { target: input });
        } else {
            const target = new FakeElement({ pageSetupOption: key, value });
            target.selectors.set('closest:[data-page-setup-option]', [target]);
            popover.selectors.set(`[data-page-setup-input="${key}"]`, [input]);
            popover.dispatch('click', { target, preventDefault() {} });
        }
    };
    return { ...harness, runtime, page, popover, scope, edit, statusErrors: errors };
}

test('switching setup scope before debounce saves both original scopes serially', async () => {
    const h = setupPage();
    h.edit('pageColor', 'paper');
    h.scope('global');
    h.edit('fontType', 'serif');
    h.flushTimers();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/notes/test-note');
    assert.deepEqual(JSON.parse(h.requests[0].options.body), { page_setup_json: { pageColor: 'paper' } });
    h.requests[0].resolve(ok({ page_setup: { pageColor: 'paper' }, global_page_setup: {} }));
    await settle();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].url, '/settings/api/notes-page-setup');
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { page_setup: { fontType: 'serif' } });
    assert.equal(h.runtime.effectivePageSetup().fontType, 'serif', 'note response preserves dirty global settings');
    assert.equal(h.unloadPrevented(), true, 'global scope remains dirty until acknowledged');
    h.requests[1].resolve(ok({ notes_page_setup: { fontType: 'serif' } }));
    await settle();
    assert.equal(h.unloadPrevented(), false);
    h.runtime.dispose();
});

test('setup edits made during a request survive stale response and save latest version', async () => {
    const h = setupPage();
    h.edit('sideMargins', 8);
    const save = h.runtime.savePageSetup();
    h.edit('sideMargins', 15);
    const latest = h.runtime.savePageSetup();
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve(ok({ page_setup: { sideMargins: 8 }, global_page_setup: {} }));
    await settle();
    assert.equal(h.runtime.effectivePageSetup().sideMargins, 15);
    assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[1].options.body).page_setup_json.sideMargins, 15);
    assert.equal(h.unloadPrevented(), true);
    h.requests[1].resolve(ok({ page_setup: { sideMargins: 15 }, global_page_setup: {} }));
    await Promise.all([save, latest]);
    assert.equal(h.unloadPrevented(), false);
    h.runtime.dispose();
});

test('failed or malformed setup response retains current values and dirty scope for retry', async () => {
    for (const response of [{ ok: false }, ok({}), { ok: true, json: async () => { throw new Error('bad JSON'); } }]) {
        const h = setupPage();
        h.edit('pageColor', 'blue');
        const save = h.runtime.savePageSetup();
        h.requests[0].resolve(response);
        await save;
        assert.equal(h.runtime.effectivePageSetup().pageColor, 'blue');
        assert.equal(h.unloadPrevented(), true);
        assert.equal(h.statusErrors[0][0], 'error');
        const retry = h.runtime.savePageSetup();
        h.requests[1].resolve(ok({ page_setup: { pageColor: 'blue' }, global_page_setup: {} }));
        await retry;
        assert.equal(h.unloadPrevented(), false);
        h.runtime.dispose();
    }
});

test('disposing setup removes listeners, aborts writes and ignores late completion', async () => {
    const h = setupPage();
    h.edit('pageColor', 'blue');
    const save = h.runtime.savePageSetup();
    h.edit('pageColor', 'rose');
    h.runtime.dispose();
    assert.equal(h.requests[0].options.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.unloadPrevented(), false);
    h.requests[0].resolve(ok({ page_setup: { pageColor: 'blue' }, global_page_setup: {} }));
    await save;
    assert.equal(h.runtime.effectivePageSetup().pageColor, 'rose');
    h.edit('pageColor', 'green');
    assert.equal(h.runtime.effectivePageSetup().pageColor, 'rose', 'disposed binding cannot accept edits');
    await h.runtime.savePageSetup();
    assert.equal(h.requests.length, 1);
});
