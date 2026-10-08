import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccessControl } from '../../collaboration/access-control.mjs';
import { createDocumentPersistence } from '../../collaboration/document-persistence.mjs';

const revision = ['owner', 2, 'folder', 'owner', 4];
const access = { ok: true, note_id: 'note', user_id: 'user', can_write: true, awareness_allowed: true, permission_revision: revision, document_generation: 'initial' };
const drain = () => new Promise((resolve) => setImmediate(resolve));
function connectionFixture() {
    const sent = [];
    const closed = [];
    const connection = {
        context: { noteId: 'note', userId: 'user', canWrite: true, awarenessAllowed: true, permissionRevision: revision, documentGeneration: 'initial' },
        send(message) { sent.push(message); }, close(event) { closed.push(event); },
    };
    const document = { addConnection(value) { this.connection = value; }, getConnections() { return [connection]; } };
    return { sent, closed, connection, document };
}

test('queued disclosure is blocked when invalidation arrives during a current ACL request', async () => {
    let respond;
    const fixture = connectionFixture();
    const guard = createAccessControl({ checkAccess: () => new Promise((resolve) => { respond = resolve; }) });
    guard.guardDocument(fixture.document);
    fixture.document.addConnection(fixture.connection);
    fixture.connection.send(new Uint8Array([1, 2, 3]));
    await drain();
    guard.invalidate(fixture.document);
    respond(access);
    await drain();
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.closed[0].reason, 'collaboration_access_changed');
});

test('current checks use immutable authenticated identity despite context changes and ticket expiry', async () => {
    const identities = [];
    const fixture = connectionFixture();
    const guard = createAccessControl({ checkAccess: async (identity) => { identities.push(identity); return access; } });
    guard.guardDocument(fixture.document);
    fixture.document.addConnection(fixture.connection);
    fixture.connection.context.userId = 'owner';
    fixture.connection.context.ticket = 'expired';
    await guard.check(fixture.connection);
    assert.deepEqual(identities, [{ noteId: 'note', userId: 'user' }]);
});

test('missing revision and permission service timeout fail closed before sending', async () => {
    for (const checkAccess of [async () => ({ ...access, permission_revision: undefined }), async () => { throw new Error('timeout'); }]) {
        const fixture = connectionFixture();
        const guard = createAccessControl({ checkAccess });
        guard.guardDocument(fixture.document);
        fixture.document.addConnection(fixture.connection);
        fixture.connection.send(new Uint8Array([1]));
        await drain();
        assert.equal(fixture.sent.length, 0);
        assert.ok(fixture.closed.length);
        assert.equal(fixture.connection.readOnly, true);
    }
});

test('recipient queue backpressure closes rather than retaining an unbounded disclosure queue', async () => {
    const fixture = connectionFixture();
    const guard = createAccessControl({ checkAccess: async () => access, maxQueuedBytes: 2 });
    guard.guardDocument(fixture.document);
    fixture.document.addConnection(fixture.connection);
    fixture.connection.send(new Uint8Array([1, 2, 3]));
    assert.equal(fixture.closed[0].reason, 'collaboration_backpressure');
    assert.equal(fixture.sent.length, 0);
});

test('new document generation closes stale caches even when sharing permissions are unchanged', async () => {
    const fixture = connectionFixture();
    const guard = createAccessControl({ checkAccess: async () => ({ ...access, document_generation: 'restored-generation' }) });
    guard.guardDocument(fixture.document);
    fixture.document.addConnection(fixture.connection);
    await assert.rejects(guard.check(fixture.connection), /access changed/);
    assert.equal(fixture.connection.readOnly, true);
    assert.equal(fixture.closed[0].reason, 'collaboration_access_changed');
});

test('persistence waits for the latest accepted revision when updates arrive during a save', async () => {
    let complete;
    let calls = 0;
    const document = { name: 'notes:note' };
    const persistence = createDocumentPersistence({
        noteIdFor: (value) => value.replace('notes:', ''),
        store: async () => { calls += 1; if (calls === 1) await new Promise((resolve) => { complete = resolve; }); },
    });
    persistence.changed(document);
    const saving = persistence.save(document);
    let unloaded = false;
    const unloading = persistence.beforeUnload(document).then(() => { unloaded = true; });
    persistence.changed(document);
    complete();
    await saving;
    assert.equal(unloaded, false);
    await persistence.retry(document);
    await unloading;
    assert.equal(calls, 2);
    assert.equal(unloaded, true);
});
