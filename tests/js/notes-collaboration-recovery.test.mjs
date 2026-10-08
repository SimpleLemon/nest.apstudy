import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createCollaborationRecovery } from '../../static/js/notes/editor/collaboration/collaboration-recovery.js';
import { createCollaborationDraftStore } from '../../static/js/notes/editor/collaboration/collaboration-draft-store.js';

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const keyFor = (user, generation) => JSON.stringify([user, 'note', generation]);
function setup({ memory = new Map(), store, document = new Y.Doc() } = {}) {
    const records = new Map();
    const statuses = [];
    const pending = [];
    const handlers = new Map();
    const provider = {};
    let ready = false;
    const recovery = createCollaborationRecovery({
        noteId: 'note', document, memory, getProvider: () => provider, getReady: () => ready,
        store: store || {
            read: async (user) => [...records.values()].filter((record) => record.identity === JSON.stringify([user, 'note'])),
            write: async (record) => records.set(record.key, record), remove: async (key) => records.delete(key),
        },
        eventTarget: { addEventListener: (event, fn) => handlers.set(event, fn), removeEventListener: (event) => handlers.delete(event) },
        getDraftContent: () => [{ type: 'paragraph', content: document.getText('title').toString() }],
        onStatus: (status, options) => statuses.push([status, options]), onPendingChanges: (value) => pending.push(value),
    });
    const ack = (doc = document, generation = 'initial') => recovery.acknowledge({
        document_generation: generation, snapshot_base64: base64(Y.encodeSnapshot(Y.snapshot(doc))),
    });
    return { recovery, document, records, memory, statuses, pending, handlers, provider, ack, ready: () => { ready = true; } };
}

test('automatic checkpoint survives reload and replays only for the same admitted user, note and generation', async () => {
    const h = setup();
    await h.recovery.admit('user', 'initial', true);
    h.document.getText('title').insert(0, 'Offline draft');
    await h.recovery.whenStored();
    assert.equal(h.statuses.at(-1)[0], 'offline-local');
    assert.equal(h.records.get(keyFor('user', 'initial')).title, 'Offline draft');
    const reloaded = setup({ store: { read: async () => [...h.records.values()], write: async () => {}, remove: async () => {} } });
    await reloaded.recovery.admit('user', 'initial', true);
    assert.equal(reloaded.document.getText('title').toString(), 'Offline draft');
    assert.equal(reloaded.recovery.hasPendingChanges(), true);
    h.recovery.dispose();
    reloaded.recovery.dispose();
});

test('foreign user drafts stay isolated and replaced-generation drafts remain exportable without replay', async () => {
    const h = setup();
    await h.recovery.admit('owner', 'original', true);
    h.document.getText('title').insert(0, 'Older draft');
    await h.recovery.whenStored();
    const replacement = setup({ memory: h.memory });
    await replacement.recovery.admit('other-user', 'original', true);
    assert.equal(replacement.document.getText('title').toString(), '');
    await replacement.recovery.admit('owner', 'restored', true);
    assert.equal(replacement.document.getText('title').toString(), '');
    assert.equal(replacement.statuses.at(-1)[0], 'draft-blocked');
    const draft = replacement.statuses.at(-1)[1].draft;
    assert.equal(draft.title, 'Older draft');
    assert.equal(draft.generation, 'original');
    assert.deepEqual(draft.content, [{ type: 'paragraph', content: 'Older draft' }]);
    assert.equal(h.memory.has(keyFor('owner', 'original')), true);
    h.recovery.dispose();
    replacement.recovery.dispose();
});

test('viewer admission never replays a draft; fresh editor permission can subsequently recover it', async () => {
    const h = setup();
    await h.recovery.admit('user', 'initial', true);
    h.document.getText('title').insert(0, 'Unsent edit');
    await h.recovery.whenStored();
    const viewer = setup({ memory: h.memory });
    await viewer.recovery.admit('user', 'initial', false);
    assert.equal(viewer.document.getText('title').toString(), '');
    assert.equal(viewer.statuses.at(-1)[0], 'draft-blocked');
    await viewer.recovery.admit('user', 'initial', true);
    assert.equal(viewer.document.getText('title').toString(), 'Unsent edit');
    h.recovery.dispose();
    viewer.recovery.dispose();
});

test('durable ACK must contain inserts and deletions in the current generation before clearing a draft', async () => {
    const h = setup();
    await h.recovery.admit('user', 'initial', true);
    h.document.getText('title').insert(0, 'Delete me');
    const durable = new Y.Doc();
    Y.applyUpdate(durable, Y.encodeStateAsUpdate(h.document));
    h.document.getText('title').delete(0, 9);
    await h.recovery.whenStored();
    assert.deepEqual(Y.encodeStateVector(durable), Y.encodeStateVector(h.document), 'delete-only edits do not advance the vector');
    assert.equal(h.ack(durable), false);
    assert.equal(h.ack(h.document, 'restored'), false);
    assert.equal(h.recovery.acknowledge({ document_generation: 'initial', state_vector_base64: base64(Y.encodeStateVector(h.document)) }), false);
    assert.equal(h.recovery.hasPendingChanges(), true);
    Y.applyUpdate(durable, Y.encodeStateAsUpdate(h.document));
    assert.equal(h.ack(durable), true);
    await h.recovery.whenStored();
    assert.equal(h.recovery.hasPendingChanges(), false);
    assert.equal(h.records.size, 0);
    assert.equal(h.memory.size, 0);
    h.recovery.dispose();
});

test('ACK of an older snapshot leaves newer edits pending and serialized removal cannot erase a subsequent checkpoint', async () => {
    const h = setup();
    await h.recovery.admit('user', 'initial', true);
    h.document.getText('title').insert(0, 'First');
    const durable = new Y.Doc();
    Y.applyUpdate(durable, Y.encodeStateAsUpdate(h.document));
    h.document.getText('title').insert(5, ' second');
    assert.equal(h.ack(durable), false);
    assert.equal(h.ack(), true);
    h.document.getText('title').insert(12, ' third');
    await h.recovery.whenStored();
    assert.equal(h.records.get(keyFor('user', 'initial')).title, 'First second third');
    assert.equal(h.recovery.hasPendingChanges(), true);
    h.recovery.dispose();
});

test('local storage failure retains the in-memory draft and warns before leaving', async () => {
    const h = setup({ store: { read: async () => [], write: async () => { throw new Error('quota'); }, remove: async () => {} } });
    await h.recovery.admit('user', 'initial', true);
    h.document.getText('title').insert(0, 'Keep this');
    await h.recovery.whenStored();
    assert.equal(h.statuses.at(-1)[0], 'local-save-failed');
    assert.equal(h.statuses.at(-1)[1].draft.title, 'Keep this');
    let prevented = false;
    h.handlers.get('beforeunload')({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.memory.get(keyFor('user', 'initial')).title, 'Keep this');
    h.recovery.dispose();
    const reopened = setup({ memory: h.memory });
    await reopened.recovery.admit('user', 'initial', true);
    assert.equal(reopened.document.getText('title').toString(), 'Keep this');
    reopened.recovery.dispose();
});

test('superseded draft lookup cannot inject a stale generation into a newer admission', async () => {
    let resolveRead;
    const h = setup({ store: { read: () => new Promise((resolve) => { resolveRead = resolve; }), write: async () => {}, remove: async () => {} } });
    const old = new Y.Doc();
    old.getText('title').insert(0, 'Stale');
    const admission = h.recovery.admit('user', 'initial', true, () => false);
    resolveRead([{ key: keyFor('user', 'initial'), update: Y.encodeStateAsUpdate(old) }]);
    await admission;
    assert.equal(h.document.getText('title').toString(), '');
    assert.equal(h.recovery.hasPendingChanges(), false);
    h.recovery.dispose();
});

test('IndexedDB local save resolves only on transaction commit and rejects abort after request success', async () => {
    let request;
    let transaction;
    const store = createCollaborationDraftStore({ open() { request = {}; return request; } });
    const write = store.write({ key: 'draft' });
    request.result = { transaction() {
        transaction = { objectStore: () => ({ put: () => ({}) }) };
        return transaction;
    } };
    request.onsuccess();
    await Promise.resolve();
    let committed = false;
    write.then(() => { committed = true; }, () => {});
    await Promise.resolve();
    assert.equal(committed, false);
    transaction.error = new Error('quota exceeded');
    transaction.onabort();
    await assert.rejects(write, /quota exceeded/);
});
