import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { createDocumentPersistence } from '../../collaboration/document-persistence.mjs';
import { createCollaborationShutdown } from '../../collaboration/shutdown.mjs';

function deferred() {
    let resolve;
    const promise = new Promise((complete) => { resolve = complete; });
    return { promise, resolve };
}

async function lifecycleFixture(store, timeoutMs = 1000) {
    const persistence = createDocumentPersistence({ store, noteIdFor: (name) => name.slice(6) });
    let destroyed = 0;
    let retriesStopped = 0;
    const server = new Hocuspocus({ quiet: true,
        onLoadDocument: ({ document }) => persistence.loaded(document, 0),
        onChange: ({ document }) => persistence.changed(document),
        extensions: [{
            beforeUnloadDocument: ({ documentName }) => persistence.beforeUnload(server.documents.get(documentName)),
        }],
        onDestroy: () => { destroyed += 1; },
    });
    const document = await server.createDocument('notes:shutdown', {}, 'fixture', {}, {});
    const shutdown = createCollaborationShutdown({ server, persistence, timeoutMs, retryMs: 5,
        stopRetries: () => { retriesStopped += 1; } });
    async function edit(title) {
        document.getText('title').insert(document.getText('title').length, title);
        // Hocuspocus dispatches its public onChange hook asynchronously.
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { document, server, persistence, shutdown, edit,
        get destroyed() { return destroyed; }, get retriesStopped() { return retriesStopped; } };
}

test('shutdown retries a failed durable flush and resolves the actual server unload waiter', async () => {
    const failed = deferred();
    const recovery = deferred();
    let attempts = 0;
    let stored;
    const fixture = await lifecycleFixture(async (noteId, document, revision) => {
        assert.equal(noteId, 'shutdown');
        assert.equal(revision, 0);
        attempts += 1;
        if (attempts === 1) { failed.resolve(); throw new Error('temporary outage'); }
        await recovery.promise;
        stored = Y.encodeStateAsUpdate(document);
        return { durable_revision: 1 };
    });
    await fixture.edit('Durable after recovery');
    const shuttingDown = fixture.shutdown.shutdown();
    const unloading = fixture.server.unloadDocument(fixture.document);
    await failed.promise;
    assert.equal(fixture.retriesStopped, 0);
    assert.equal(fixture.server.documents.size, 1);
    assert.throws(fixture.shutdown.requireAvailable, /shutting down/);
    recovery.resolve();
    await Promise.all([shuttingDown, unloading]);
    const durable = new Y.Doc();
    Y.applyUpdate(durable, stored);
    assert.equal(durable.getText('title').toString(), 'Durable after recovery');
    assert.equal(attempts, 2);
    assert.equal(fixture.server.documents.size, 0);
    assert.equal(fixture.destroyed, 1);
    assert.equal(fixture.retriesStopped, 1);
    assert.equal(fixture.shutdown.shutdown(), shuttingDown);
    durable.destroy();
});

test('shutdown persists a final admitted revision while its earlier durable snapshot is pending', async () => {
    const submitted = deferred();
    const release = deferred();
    const titles = [];
    const revisions = [];
    const fixture = await lifecycleFixture(async (noteId, document, revision) => {
        revisions.push(revision);
        titles.push(document.getText('title').toString());
        if (titles.length === 1) { submitted.resolve(); await release.promise; }
        return { durable_revision: revision + 1 };
    });
    await fixture.edit('First');
    const shuttingDown = fixture.shutdown.shutdown();
    const unloading = fixture.server.unloadDocument(fixture.document);
    await submitted.promise;
    await fixture.edit(' plus final revision');
    assert.equal(fixture.retriesStopped, 0);
    release.resolve();
    await Promise.all([shuttingDown, unloading]);
    assert.deepEqual(titles, ['First', 'First plus final revision']);
    assert.deepEqual(revisions, [0, 1]);
    assert.equal(fixture.destroyed, 1);
    assert.equal(fixture.retriesStopped, 1);
});

test('deadline rejects a stalled PUT without resolving dirty unload or treating repeated shutdown as success', async () => {
    const release = deferred();
    const fixture = await lifecycleFixture(async () => {
        await release.promise;
        return { durable_revision: 1 };
    }, 30);
    await fixture.edit('Still dirty');
    let unloaded = false;
    const shuttingDown = fixture.shutdown.shutdown();
    const unloading = fixture.server.unloadDocument(fixture.document).then(() => { unloaded = true; });
    assert.equal(fixture.shutdown.shutdown(), shuttingDown);
    await assert.rejects(shuttingDown, /exceeded 30ms.*notes:shutdown/);
    assert.equal(unloaded, false);
    assert.equal(fixture.destroyed, 0);
    assert.equal(fixture.server.documents.size, 1);
    assert.equal(fixture.retriesStopped, 1);
    await assert.rejects(fixture.shutdown.shutdown(), /exceeded 30ms/);
    // Recover the fixture's real pending PUT so no test server is leaked.
    release.resolve();
    await unloading;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.destroyed, 1);
});

test('public flush reports failure and keeps beforeUnload pending until a durable retry succeeds', async () => {
    let available = false;
    const persistence = createDocumentPersistence({ noteIdFor: (name) => name,
        store: async () => {
            if (!available) throw new Error('unavailable');
            return { durable_revision: 8 };
        } });
    const document = new Y.Doc();
    document.name = 'notes:retained';
    persistence.loaded(document, 7);
    persistence.changed(document);
    let unloaded = false;
    const unloading = persistence.beforeUnload(document).then(() => { unloaded = true; });
    await assert.rejects(persistence.flush(document), /unavailable/);
    assert.equal(unloaded, false);
    available = true;
    await persistence.retry(document);
    await unloading;
    assert.equal(await persistence.flush(document), 8);
    document.destroy();
});
