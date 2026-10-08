import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement, ok, settle } from './helpers/notes-runtime.mjs';

function setupSave(overrides = {}) {
    const harness = createHarness();
    const { createNoteSaveRuntime } = harness.load('save.js', ['createNoteSaveRuntime']);
    const title = new FakeElement();
    title.value = 'First title';
    const status = new FakeElement();
    const retry = new FakeElement();
    let document = [{ type: 'paragraph', content: 'First content' }];
    const runtime = createNoteSaveRuntime({
        noteId: 'test-note', titleInput: title, saveStatus: status, saveRetry: retry,
        getCanEdit: () => true, getEditor: () => ({}), getNoteCollaborationEnabled: () => false,
        getCurrentDocumentSnapshot: () => document, getTopLevelBlockCount: () => document.length,
        ...overrides,
    });
    return { ...harness, runtime, title, status, retry, edit: (content) => { document = [{ type: 'paragraph', content }]; } };
}

test('autosave does not write or schedule without permission, identity, editor or in collaboration mode', async () => {
    for (const overrides of [
        { getCanEdit: () => false }, { noteId: '' }, { titleInput: null },
        { getEditor: () => null }, { getNoteCollaborationEnabled: () => true },
    ]) {
        const h = setupSave(overrides);
        await h.runtime.saveNote();
        h.runtime.triggerDebouncedSave();
        assert.equal(h.requests.length, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.runtime.hasPendingChanges(), false);
        assert.equal(h.unloadPrevented(), false);
        h.runtime.dispose();
    }
});

test('local draft status explains durability and exports a replaced-generation draft without a save request', () => {
    const h = setupSave({ getNoteCollaborationEnabled: () => true });
    h.runtime.setSaveStatus('offline-local');
    assert.equal(h.status.textContent, 'Saved on this device — reconnecting');
    h.runtime.setSaveStatus('local-save-failed');
    assert.equal(h.status.textContent, 'Local save failed — keep this page open');
    h.runtime.setSaveStatus('draft-blocked', { draft: {
        title: 'Recovered title', content: [{ type: 'paragraph', content: 'Keep this content' }],
        generation: 'older', noteId: 'test-note', updatedAt: 1000, update: new Uint8Array([1, 2, 3]),
    } });
    assert.equal(h.retry.hidden, false);
    assert.equal(h.retry.textContent, 'Export draft');
    let payload;
    let clicked = false;
    h.context.Blob = class { constructor(parts) { payload = JSON.parse(parts[0]); } };
    h.context.URL = { createObjectURL: () => 'blob:recovery', revokeObjectURL() {} };
    h.context.document.createElement = () => ({ click() { clicked = true; } });
    assert.equal(h.runtime.exportRecoveryDraft(), true);
    assert.equal(clicked, true);
    assert.equal(payload.title, 'Recovered title');
    assert.equal(payload.document_generation, 'older');
    assert.deepEqual(payload.yjs_update, [1, 2, 3]);
    assert.equal(h.requests.length, 0);
    h.runtime.setSaveStatus('saved');
    assert.equal(h.runtime.exportRecoveryDraft(), false);
    assert.equal(h.retry.hidden, true);
    h.runtime.dispose();
});

test('acknowledging an older save keeps edits dirty and warns before unload', async () => {
    const h = setupSave();
    const save = h.runtime.saveNote();
    h.edit('Edited while saving');
    h.title.value = 'New title';
    h.runtime.triggerDebouncedSave();
    h.requests[0].resolve(ok());
    await save;
    assert.equal(h.runtime.hasPendingChanges(), true);
    assert.equal(h.status.classes.has('save-status-saved'), false);
    assert.equal(h.unloadPrevented(), true);
    h.flushTimers();
    assert.equal(h.requests.length, 2);
    assert.equal(JSON.parse(h.requests[1].options.body).title, 'New title');
    assert.match(JSON.parse(h.requests[1].options.body).content, /Edited while saving/);
    h.requests[1].resolve(ok());
    await settle();
    assert.equal(h.runtime.hasPendingChanges(), false);
    assert.equal(h.unloadPrevented(), false);
    h.runtime.dispose();
});

test('overlapping saves serialize requests and write the latest snapshot', async () => {
    const h = setupSave();
    const first = h.runtime.saveNote();
    h.edit('Second content');
    const second = h.runtime.saveNote();
    h.edit('Latest content');
    const third = h.runtime.saveNote();
    assert.equal(h.requests.length, 1);
    assert.equal(first, second);
    assert.equal(first, third);
    h.requests[0].resolve(ok());
    await settle();
    assert.equal(h.requests.length, 2);
    assert.match(JSON.parse(h.requests[1].options.body).content, /Latest content/);
    assert.equal(h.runtime.hasPendingChanges(), true);
    h.requests[1].resolve(ok());
    await third;
    assert.equal(h.runtime.hasPendingChanges(), false);
    assert.equal(h.status.classes.has('save-status-saved'), true);
    await h.runtime.saveNote();
    assert.equal(h.requests.length, 2, 'unchanged content skips a redundant write');
    h.runtime.dispose();
});

test('HTTP and network failures retain dirty content and allow a retry', async () => {
    for (const failure of ['http', 'network']) {
        const h = setupSave();
        const saving = h.runtime.saveNote();
        if (failure === 'http') h.requests[0].resolve({ ok: false });
        else h.requests[0].reject(new Error('offline'));
        await saving;
        assert.equal(h.runtime.hasPendingChanges(), true);
        assert.equal(h.unloadPrevented(), true);
        assert.equal(h.retry.hidden, false);
        const retrying = h.runtime.saveNote();
        h.requests[1].resolve(ok());
        await retrying;
        assert.equal(h.runtime.hasPendingChanges(), false);
        h.runtime.dispose();
    }
});

test('save displays actionable server, permission and expired-session errors without clearing edits', async () => {
    const failures = [
        { response: { ok: false, status: 413, json: async () => ({ error: 'This note exceeds the size limit.', code: 'note_too_large' }) }, message: 'This note exceeds the size limit.' },
        { response: { ok: false, status: 403, json: async () => ({}) }, message: 'You no longer have permission to edit this note.' },
        { response: { ok: false, status: 401, json: async () => { throw new Error('HTML login page'); } }, message: 'Sign in again to save this note.' },
        { response: { ok: true, redirected: true }, message: 'Sign in again to save this note.' },
    ];
    for (const failure of failures) {
        const h = setupSave();
        const saving = h.runtime.saveNote();
        h.requests[0].resolve(failure.response);
        await saving;
        assert.equal(h.status.textContent, failure.message);
        assert.equal(h.runtime.hasPendingChanges(), true);
        assert.equal(h.retry.hidden, false);
        h.runtime.dispose();
    }
});

test('autosave rechecks permission before a queued retry runs', async () => {
    let canEdit = true;
    const h = setupSave({ getCanEdit: () => canEdit });
    const saving = h.runtime.saveNote();
    h.edit('Unsaved update');
    h.runtime.saveNote();
    canEdit = false;
    h.requests[0].resolve(ok());
    await saving;
    assert.equal(h.requests.length, 1);
    assert.equal(h.runtime.hasPendingChanges(), true);
    h.runtime.triggerDebouncedSave();
    assert.equal(h.timers.size, 0);
    h.runtime.dispose();
});

test('collaboration migration stops incompatible PATCH retries and retains the dirty draft for recovery', async () => {
    const h = setupSave();
    const saving = h.runtime.saveNote();
    h.edit('Latest unsaved draft');
    h.title.value = 'Unsaved title';
    h.runtime.triggerDebouncedSave();
    h.runtime.saveNote();
    h.requests[0].resolve({ ok: false, status: 409, json: async () => ({
        error: 'This note uses live collaboration.', code: 'collaboration_required',
    }) });
    await saving;
    assert.match(h.status.textContent, /Copy your unsaved changes, then reload to reconnect/);
    assert.equal(h.retry.hidden, true);
    assert.equal(h.runtime.hasPendingChanges(), true);
    assert.equal(h.unloadPrevented(), true);
    assert.equal(h.title.value, 'Unsaved title');
    await h.runtime.saveNote();
    h.runtime.triggerDebouncedSave();
    h.flushTimers();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 0);
    h.runtime.dispose();
});

test('disposing a save aborts the request, timers, unload guard and late UI updates', async () => {
    const h = setupSave();
    const saving = h.runtime.saveNote();
    h.runtime.triggerDebouncedSave();
    const before = h.status.textContent;
    h.runtime.dispose();
    assert.equal(h.requests[0].options.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.unloadPrevented(), false);
    h.requests[0].resolve(ok());
    await saving;
    assert.equal(h.status.textContent, before);
    await h.runtime.saveNote();
    h.runtime.triggerDebouncedSave();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 0);
});
