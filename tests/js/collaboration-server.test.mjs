import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { BlockNoteEditor } from '@blocknote/core';
import { notesEditorSchema } from '../../static/js/notes/editor-schema.js';
import WebSocket from 'ws';
import { createCollaborationSession } from '../../static/js/notes/editor/collaboration/collaboration-session.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED_ORIGIN = 'https://allowed.test';
const notesSchema = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true }).pmSchema;
const noteBody = (text) => ({ type: 'doc', content: [{ type: 'blockGroup', content: [
    { type: 'blockContainer', attrs: { id: 'paragraph-1' }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
] }] });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, { timeout = 5000, interval = 25 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const result = await predicate();
            if (result) return result;
        } catch (error) {
            lastError = error;
        }
        await wait(Math.min(interval, Math.max(1, deadline - Date.now())));
    }
    throw lastError || new Error(`Condition was not met within ${timeout}ms.`);
}

function waitForEvent(emitter, event, { predicate = () => true, timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        const handler = (payload) => {
            if (!predicate(payload)) return;
            clearTimeout(timer);
            emitter.off(event, handler);
            resolve(payload);
        };
        timer = setTimeout(() => {
            emitter.off(event, handler);
            reject(new Error(`Timed out waiting for ${event}.`));
        }, timeout);
        emitter.on(event, handler);
    });
}

function encodeDocument(document) {
    return Buffer.from(Y.encodeStateAsUpdate(document));
}

function decodeDocument(bytes) {
    const document = new Y.Doc();
    Y.applyUpdate(document, bytes);
    return document;
}

async function requestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function createFlaskFixture() {
    const state = {
        healthStatus: 200,
        accessStatus: 200,
        accessRequests: [],
        accessOverrides: new Map(),
        storeStatus: 200,
        requests: [],
        storeRequests: [],
        verifyRequests: [],
        storedDocuments: new Map(),
        durableRevisions: new Map(),
        generations: new Map(),
        tickets: new Map([
            ['write-ticket', {
                user_id: 'user-1',
                role: 'editor',
                can_write: true,
                public: false,
                anonymous: false,
                awareness_allowed: true,
                access_revision: 4,
                permission_revision: ["owner", 4, "", "", 0],
            }],
            ['public-ticket', {
                user_id: null, role: 'viewer', can_write: false, public: true, anonymous: true,
                awareness_allowed: false, access_revision: 4, permission_revision: ['owner', 4, '', '', 0],
            }],
            ['read-ticket', {
                user_id: 'user-2',
                role: 'viewer',
                can_write: false,
                public: false,
                anonymous: false,
                awareness_allowed: true,
                access_revision: 4,
                permission_revision: ["owner", 4, "", "", 0],
            }],
        ]),
    };

    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const body = await requestBody(request);
        state.requests.push({
            method: request.method,
            path: url.pathname,
            headers: request.headers,
            body,
        });

        if (url.pathname === '/api/internal/notes/collaboration-health') {
            const ok = state.healthStatus < 400;
            sendJson(response, state.healthStatus, {
                ok,
                schema_version: ok ? 1 : 0,
                persistence: 'fixture',
            });
            return;
        }

        if (url.pathname === '/api/internal/notes/collaboration-token/verify') {
            const payload = JSON.parse(body || '{}');
            state.verifyRequests.push(payload);
            const ticket = state.tickets.get(payload.ticket);
            if (!ticket) {
                sendJson(response, 401, { error: 'collaboration_token_invalid' });
                return;
            }
            sendJson(response, 200, {
                ok: true,
                note_id: payload.note_id,
                user: null,
                ...ticket,
                document_generation: state.generations.get(payload.note_id) || 'initial',
            });
            return;
        }

        if (url.pathname === '/api/internal/notes/collaboration-access') {
            const identity = JSON.parse(body || '{}');
            state.accessRequests.push(identity);
            const override = state.accessOverrides.get(`${identity.note_id}:${identity.user_id}`);
            if (override === null || state.accessStatus !== 200) {
                sendJson(response, override === null ? 403 : state.accessStatus, { error: 'permissions unavailable' });
                return;
            }
            const ticket = [...state.tickets.values()].find((value) => value.user_id === identity.user_id);
            sendJson(response, 200, { ok: true, note_id: identity.note_id, ...ticket,
                document_generation: state.generations.get(identity.note_id) || 'initial', ...override });
            return;
        }

        const documentMatch = url.pathname.match(
            /^\/api\/internal\/notes\/([^/]+)\/collaboration-document$/,
        );
        if (documentMatch) {
            const noteId = decodeURIComponent(documentMatch[1]);
            if (request.method === 'GET') {
                const document = state.storedDocuments.get(noteId);
                if (!document) {
                    sendJson(response, 404, { error: 'collaboration_document_not_found' });
                    return;
                }
                response.writeHead(200, { 'Content-Type': 'application/octet-stream',
                    'X-Nest-Durable-Revision': String(state.durableRevisions.get(noteId) || 0),
                    'X-Nest-Document-Generation': state.generations.get(noteId) || 'initial' });
                response.end(document);
                return;
            }

            if (request.method === 'PUT') {
                if (state.storeStatus !== 200) {
                    sendJson(response, state.storeStatus, { error: 'storage unavailable' });
                    return;
                }
                const payload = JSON.parse(body || '{}');
                await state.beforeStore?.(noteId, payload);
                const revision = state.durableRevisions.get(noteId) || 0;
                if (payload.expected_revision !== revision || payload.document_generation !== (state.generations.get(noteId) || 'initial')) {
                    sendJson(response, 409, { error: 'collaboration_revision_conflict' });
                    return;
                }
                const document = Buffer.from(payload.ydoc_base64 || '', 'base64');
                state.storedDocuments.set(noteId, document);
                state.durableRevisions.set(noteId, revision + 1);
                state.storeRequests.push({ noteId, payload, document });
                sendJson(response, 200, { ok: true, note_id: noteId, durable_revision: revision + 1,
                    document_generation: state.generations.get(noteId) || 'initial' });
                return;
            }
        }

        response.writeHead(404);
        response.end('not found');
    });

    return {
        state,
        async start() {
            await once(server.listen(0, '127.0.0.1'), 'listening');
        },
        async stop() {
            if (server.listening) await new Promise((resolve) => server.close(resolve));
        },
        get url() {
            return `http://127.0.0.1:${server.address().port}`;
        },
    };
}

async function startCollaboration(fixture, options = {}) {
    const portProbe = createServer();
    await once(portProbe.listen(0, '127.0.0.1'), 'listening');
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));

    const child = spawn(process.execPath, ['collaboration/server.mjs'], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'testing',
            NOTES_COLLABORATION_HOST: '127.0.0.1',
            NOTES_COLLABORATION_PORT: String(port),
            NOTES_COLLABORATION_QUIET: '1',
            NOTES_COLLABORATION_ORIGINS: ALLOWED_ORIGIN,
            NOTES_COLLABORATION_INTERNAL_SECRET: 'fixture-secret',
            NOTES_COLLABORATION_SECRET: '',
            NOTES_COLLABORATION_ACCESS_CHECK_INTERVAL_MS: '200',
            NOTES_COLLABORATION_REQUEST_TIMEOUT_MS: '500',
            NOTES_COLLABORATION_SHUTDOWN_TIMEOUT_MS: String(options.shutdownTimeoutMs || 2000),
            NOTES_COLLABORATION_MAX_UPDATE_BYTES: String(512 * 1024),
            NOTES_COLLABORATION_MAX_DOCUMENT_BYTES: String(options.maxDocumentBytes || 10 * 1024 * 1024),
            NEST_FLASK_INTERNAL_URL: fixture.url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
        if (child.exitCode !== null) {
            throw new Error(`Collaboration server exited early: ${output}`);
        }
        try {
            const response = await fetch(`${baseUrl}/health`);
            return response.status === 200;
        } catch {
            return false;
        }
    });

    return {
        baseUrl,
        websocketUrl: `ws://127.0.0.1:${port}`,
        child,
        get output() { return output; },
        async stop() {
            if (child.exitCode !== null) return;
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await Promise.race([exited, wait(2500)]);
            if (child.exitCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        },
    };
}

function createProvider(server, { name, token, origin = ALLOWED_ORIGIN, awareness = null }) {
    class OriginWebSocket extends WebSocket {
        constructor(address, protocols) {
            super(address, protocols, { headers: { Origin: origin } });
        }
    }

    const websocketProvider = new HocuspocusProviderWebsocket({
        url: server.websocketUrl,
        connect: false,
        WebSocketPolyfill: OriginWebSocket,
        delay: 10,
        initialDelay: 0,
        minDelay: 10,
        maxDelay: 100,
        maxAttempts: 1,
        timeout: 2000,
        jitter: false,
        messageReconnectTimeout: 10000,
        quiet: true,
    });
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({
        name,
        document,
        token,
        awareness: awareness === 'enabled' ? undefined : awareness,
        broadcast: false,
        quiet: true,
        websocketProvider,
    });
    return { document, provider, websocketProvider };
}

async function destroyProvider(handle) {
    handle.provider.destroy();
    handle.websocketProvider.destroy();
}

let fixture;
let collaboration;

before(async () => {
    fixture = createFlaskFixture();
    await fixture.start();
    collaboration = await startCollaboration(fixture);
});

after(async () => {
    await collaboration?.stop();
    await fixture?.stop();
});

test('health endpoints report Flask readiness and preserve the internal secret boundary', async () => {
    const ready = await fetch(`${collaboration.baseUrl}/health`);
    const readyPayload = await ready.json();
    assert.equal(ready.status, 200);
    assert.equal(readyPayload.ok, true);
    assert.equal(readyPayload.status, 'ready');
    assert.equal(readyPayload.flask_status, 200);
    assert.match(readyPayload.started_at, /^20\d\d-/);

    const healthz = await fetch(`${collaboration.baseUrl}/healthz`);
    const healthzPayload = await healthz.json();
    assert.equal(healthz.status, 200);
    assert.equal(healthzPayload.started_at, readyPayload.started_at);

    fixture.state.healthStatus = 503;
    const degraded = await fetch(`${collaboration.baseUrl}/health`);
    const degradedPayload = await degraded.json();
    assert.equal(degraded.status, 503);
    assert.deepEqual(
        {
            ok: degradedPayload.ok,
            status: degradedPayload.status,
            flask_status: degradedPayload.flask_status,
        },
        { ok: false, status: 'degraded', flask_status: 503 },
    );
    fixture.state.healthStatus = 200;

    const healthRequest = [...fixture.state.requests]
        .reverse()
        .find((request) => request.path === '/api/internal/notes/collaboration-health');
    assert.equal(healthRequest.headers['x-nest-collaboration-secret'], 'fixture-secret');
});

test('authenticated clients load normalized documents and persist Yjs updates', async () => {
    const initial = prosemirrorJSONToYDoc(notesSchema, noteBody('Saved body'), 'document-store');
    initial.getText('title').insert(0, 'Saved title');
    fixture.state.storedDocuments.set('note-1', encodeDocument(initial));
    fixture.state.storeRequests.length = 0;

    const handle = createProvider(collaboration, {
        name: 'notes:note-1',
        token: 'write-ticket',
    });
    try {
        const synced = waitForEvent(handle.provider, 'synced', {
            predicate: (payload) => payload?.state === true,
        });
        handle.websocketProvider.connect();
        await synced;

        assert.equal(handle.document.getText('title').toString(), 'Saved title');
        assert.equal(handle.document.getMap('nest:meta').get('schemaVersion'), 1);
        assert.deepEqual(fixture.state.verifyRequests.at(-1), {
            ticket: 'write-ticket',
            note_id: 'note-1',
        });

        handle.document.transact(() => {
            handle.document.getText('title').delete(0, handle.document.getText('title').length);
            handle.document.getText('title').insert(0, 'Updated title');
            handle.document.getMap('note-settings').set('orientation', 'landscape');
            prosemirrorJSONToYXmlFragment(notesSchema, noteBody('Updated body'), handle.document.getXmlFragment('document-store'));
        });
        await waitFor(() => fixture.state.storeRequests.length > 0, { timeout: 5000 });
        const persisted = decodeDocument(fixture.state.storeRequests.at(-1).document);
        assert.equal(persisted.getText('title').toString(), 'Updated title');
        const payload = fixture.state.storeRequests.at(-1).payload;
        assert.equal(payload.schema_version, 1);
        assert.equal(payload.expected_revision, 0);
        assert.equal(payload.title, 'Updated title');
        assert.equal(JSON.parse(payload.content)[0].content[0].text, 'Updated body');
        assert.deepEqual(JSON.parse(payload.page_setup_json), { orientation: 'landscape' });

        const documentRequest = [...fixture.state.requests]
            .reverse()
            .find((request) => request.path.endsWith('/collaboration-document'));
        assert.equal(documentRequest.headers['x-nest-collaboration-secret'], 'fixture-secret');
    } finally {
        await destroyProvider(handle);
    }
});

test('rejects disallowed origins and missing note IDs before ticket verification', async () => {
    const verifyCount = fixture.state.verifyRequests.length;
    const cases = [
        { name: 'notes:note-1', origin: 'https://evil.test' },
        { name: 'notes:', origin: ALLOWED_ORIGIN },
        { name: 'note-1', origin: ALLOWED_ORIGIN },
        { name: 'notes/note-1', origin: ALLOWED_ORIGIN },
    ];

    for (const scenario of cases) {
        const handle = createProvider(collaboration, {
            name: scenario.name,
            token: 'write-ticket',
            origin: scenario.origin,
        });
        try {
            const failed = waitForEvent(handle.provider, 'authenticationFailed');
            handle.websocketProvider.connect();
            const payload = await failed;
            assert.equal(payload.reason, 'permission-denied');
        } finally {
            await destroyProvider(handle);
        }
    }

    assert.equal(fixture.state.verifyRequests.length, verifyCount);
});

test('returns Flask ticket failures without authenticating the WebSocket', async () => {
    const verifyCount = fixture.state.verifyRequests.length;
    const handle = createProvider(collaboration, {
        name: 'notes:note-1',
        token: 'invalid-ticket',
    });
    try {
        const failed = waitForEvent(handle.provider, 'authenticationFailed');
        handle.websocketProvider.connect();
        const payload = await failed;
        assert.equal(payload.reason, 'permission-denied');
    } finally {
        await destroyProvider(handle);
    }
    assert.equal(fixture.state.verifyRequests.length, verifyCount + 1);
    assert.equal(fixture.state.verifyRequests.at(-1).ticket, 'invalid-ticket');
});

test('allows read-only clients to sync without persisting their updates', async () => {
    fixture.state.storeRequests.length = 0;
    const handle = createProvider(collaboration, {
        name: 'notes:read-only',
        token: 'read-ticket',
    });
    try {
        const synced = waitForEvent(handle.provider, 'synced', {
            predicate: (payload) => payload?.state === true,
        });
        handle.websocketProvider.connect();
        await synced;
        handle.document.getMap('content').set('title', 'Must not persist');
        await wait(1100);
        assert.equal(fixture.state.storeRequests.filter((request) => request.noteId === 'read-only').length, 0);
        assert.equal(handle.provider.hasUnsyncedChanges, true);
    } finally {
        await destroyProvider(handle);
    }
});

test('rejects stored documents over the configured size limit', async () => {
    fixture.state.storedDocuments.set('oversized', Buffer.alloc(8, 7));
    const limited = await startCollaboration(fixture, { maxDocumentBytes: 4 });
    const handle = createProvider(limited, {
        name: 'notes:oversized',
        token: 'write-ticket',
    });
    try {
        const failed = waitForEvent(handle.provider, 'authenticationFailed');
        handle.websocketProvider.connect();
        const payload = await failed;
        assert.equal(payload.reason, 'permission-denied');
    } finally {
        await destroyProvider(handle);
        await limited.stop();
        fixture.state.storedDocuments.delete('oversized');
    }
    const oversizedRequest = [...fixture.state.requests]
        .reverse()
        .find((request) => request.path.endsWith('/oversized/collaboration-document'));
    assert.equal(oversizedRequest.method, 'GET');
});

async function syncedProvider(noteId, token = 'write-ticket') {
    const handle = createProvider(collaboration, { name: `notes:${noteId}`, token });
    const synced = waitForEvent(handle.provider, 'synced', { predicate: (payload) => payload?.state });
    handle.websocketProvider.connect();
    await synced;
    handle.websocketProvider.shouldConnect = false;
    return handle;
}

test('authenticated invalidation closes sessions and retains accepted pending updates', async () => {
    const handle = await syncedProvider('invalidated-pending');
    try {
        handle.document.getMap('content').set('title', 'Accepted before revocation');
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        const denied = await fetch(`${collaboration.baseUrl}/access-invalidation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note_ids: ['invalidated-pending'] }),
        });
        assert.equal(denied.status, 403);
        const closed = waitForEvent(handle.websocketProvider, 'close');
        const response = await fetch(`${collaboration.baseUrl}/access-invalidation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nest-Collaboration-Secret': 'fixture-secret' },
            body: JSON.stringify({ note_ids: ['invalidated-pending'] }),
        });
        assert.equal(response.status, 200);
        await closed;
        await waitFor(() => fixture.state.storedDocuments.has('invalidated-pending'));
        assert.equal(decodeDocument(fixture.state.storedDocuments.get('invalidated-pending')).getMap('content').get('title'), 'Accepted before revocation');
    } finally { await destroyProvider(handle); }
});

test('current permission blocks downgraded edits and revoked recipient disclosures', async () => {
    const editor = await syncedProvider('fresh-acl');
    const viewer = await syncedProvider('fresh-acl', 'read-ticket');
    try {
        fixture.state.accessOverrides.set('fresh-acl:user-2', null);
        const viewerClosed = waitForEvent(viewer.websocketProvider, 'close');
        editor.document.getMap('content').set('title', 'Only authorized recipients');
        await viewerClosed;
        assert.equal(viewer.document.getMap('content').get('title'), undefined);
        fixture.state.accessOverrides.set('fresh-acl:user-1', { can_write: false, role: 'viewer' });
        const editorClosed = waitForEvent(editor.websocketProvider, 'close');
        editor.document.getMap('content').set('blocked', 'Revoked editor update');
        await editorClosed;
        await wait(400);
        const stored = decodeDocument(fixture.state.storedDocuments.get('fresh-acl'));
        assert.equal(stored.getMap('content').get('blocked'), undefined);
    } finally {
        fixture.state.accessOverrides.clear();
        await destroyProvider(editor);
        await destroyProvider(viewer);
    }
});

test('idle checks enforce inherited folder revisions and ownership even at the same role', async () => {
    for (const revision of [['owner', 4, 'folder', 'owner', 2], ['new-owner', 4, '', '', 0]]) {
        const handle = await syncedProvider('inherited-acl');
        try {
            const closed = waitForEvent(handle.websocketProvider, 'close');
            fixture.state.accessOverrides.set('inherited-acl:user-1', { permission_revision: revision });
            await closed;
        } finally {
            fixture.state.accessOverrides.clear();
            await destroyProvider(handle);
        }
    }
});

test('permission outage closes idle sessions and recovery authenticates without relying on the old ticket', async () => {
    const handle = await syncedProvider('outage');
    const previousVerifyCount = fixture.state.verifyRequests.length;
    try {
        const closed = waitForEvent(handle.websocketProvider, 'close');
        fixture.state.accessStatus = 503;
        await closed;
        assert.equal(fixture.state.verifyRequests.length, previousVerifyCount);
    } finally {
        fixture.state.accessStatus = 200;
        await destroyProvider(handle);
    }
    const recovered = await syncedProvider('outage');
    try {
        recovered.document.getMap('content').set('title', 'Recovered session');
        await waitFor(() => fixture.state.storedDocuments.has('outage'));
    } finally { await destroyProvider(recovered); }
});

test('storage outage retains pending Yjs state across invalidation and retries after recovery', async () => {
    const handle = await syncedProvider('storage-outage');
    try {
        fixture.state.storeStatus = 503;
        handle.document.getMap('content').set('title', 'Retain while disconnected');
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        const closed = waitForEvent(handle.websocketProvider, 'close');
        await fetch(`${collaboration.baseUrl}/access-invalidation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nest-Collaboration-Secret': 'fixture-secret' },
            body: JSON.stringify({ note_ids: ['storage-outage'] }),
        });
        await closed;
        await wait(500);
        assert.equal(fixture.state.storedDocuments.has('storage-outage'), false);
        fixture.state.storeStatus = 200;
        await waitFor(() => fixture.state.storedDocuments.has('storage-outage'));
        assert.equal(decodeDocument(fixture.state.storedDocuments.get('storage-outage')).getMap('content').get('title'), 'Retain while disconnected');
    } finally {
        fixture.state.storeStatus = 200;
        await destroyProvider(handle);
    }
});

test('public viewers sync with cleared awareness but cannot publish identity or receive private presence', async () => {
    const editor = createProvider(collaboration, { name: 'notes:public-awareness', token: 'write-ticket', awareness: 'enabled' });
    const viewer = createProvider(collaboration, { name: 'notes:public-awareness', token: 'public-ticket', awareness: 'enabled' });
    editor.provider.awareness.setLocalStateField('user', { id: 'private-editor', name: 'Private profile' });
    viewer.provider.awareness.setLocalState(null);
    try {
        const editorSynced = waitForEvent(editor.provider, 'synced', { predicate: (payload) => payload?.state });
        editor.websocketProvider.connect();
        await editorSynced;
        const viewerSynced = waitForEvent(viewer.provider, 'synced', { predicate: (payload) => payload?.state });
        viewer.websocketProvider.connect();
        await viewerSynced;
        viewer.websocketProvider.shouldConnect = false;
        editor.websocketProvider.shouldConnect = false;
        assert.equal(viewer.provider.awareness.getStates().size, 0);
        const closed = waitForEvent(viewer.websocketProvider, 'close');
        viewer.provider.awareness.setLocalState({ user: { id: 'spoofed-profile' } });
        await closed;
        assert.equal([...editor.provider.awareness.getStates().values()].some((state) => state.user?.id === 'spoofed-profile'), false);
    } finally { await destroyProvider(editor); await destroyProvider(viewer); }
});

test('browser session uses a fresh async ticket with the installed provider on reconnect and preserves its Y.Doc', async () => {
    class OriginWebSocket extends WebSocket {
        constructor(address, protocols) { super(address, protocols, { headers: { Origin: ALLOWED_ORIGIN } }); }
    }
    const websocketProvider = new HocuspocusProviderWebsocket({
        url: collaboration.websocketUrl, connect: false, WebSocketPolyfill: OriginWebSocket,
        delay: 10, initialDelay: 0, minDelay: 10, maxDelay: 100, jitter: false, quiet: true,
    });
    let admissions = 0;
    const originalTicket = fixture.state.tickets.get('write-ticket');
    const document = new Y.Doc();
    const session = createCollaborationSession({
        noteId: 'session-reconnect', document,
        access: { can_view: true, can_edit: true, role: 'editor' },
        schedule: setTimeout, cancel: clearTimeout,
        userFromToken: (payload, access) => ({ id: payload.user?.id, role: access.role }),
        requestToken: async () => {
            admissions++;
            const viewer = admissions > 1;
            return { token: viewer ? 'fresh-view-ticket' : 'write-ticket', user: { id: 'user-1' }, awareness_allowed: true,
                document_generation: fixture.state.generations.get('session-reconnect') || 'initial',
                access: { can_view: true, can_edit: !viewer, role: viewer ? 'viewer' : 'editor' } };
        },
        createProvider: (options) => new HocuspocusProvider({ ...options, websocketProvider, quiet: true }),
    });
    try {
        await waitFor(() => session.ready);
        assert.equal(admissions, 1);
        document.getMap('content').set('title', 'Kept across reconnection');
        await waitFor(() => !session.hasPendingChanges());
        fixture.state.tickets.delete('write-ticket');
        fixture.state.tickets.set('fresh-view-ticket', { ...originalTicket, role: 'viewer', can_write: false,
            permission_revision: ['owner', 5, '', '', 0], access_revision: 5 });
        const closed = waitForEvent(websocketProvider, 'close');
        await fetch(`${collaboration.baseUrl}/access-invalidation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nest-Collaboration-Secret': 'fixture-secret' },
            body: JSON.stringify({ note_ids: ['session-reconnect'] }),
        });
        await closed;
        await waitFor(() => session.ready && session.access.role === 'viewer');
        assert.ok(admissions >= 2);
        assert.equal(session.access.can_edit, false);
        assert.equal(session.document, document);
        assert.equal(document.getMap('content').get('title'), 'Kept across reconnection');
        assert.equal(fixture.state.verifyRequests.filter((request) => request.note_id === 'session-reconnect').at(-1).ticket, 'fresh-view-ticket');
    } finally {
        session.destroy();
        fixture.state.tickets.delete('fresh-view-ticket');
        fixture.state.tickets.set('write-ticket', originalTicket);
    }
});

test('durable ACK waits for storage recovery and includes delete-only changes that leave the state vector unchanged', async () => {
    const handle = await syncedProvider('durable-delete');
    const acknowledgments = [];
    handle.provider.on('stateless', ({ payload }) => {
        const event = JSON.parse(payload);
        if (event.type === 'durable') acknowledgments.push(event);
    });
    try {
        fixture.state.storeStatus = 503;
        handle.document.getText('title').insert(0, 'Pending durable title');
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        await wait(300);
        assert.equal(acknowledgments.length, 0);
        assert.equal(fixture.state.storedDocuments.has('durable-delete'), false);
        fixture.state.storeStatus = 200;
        await waitFor(() => acknowledgments.length === 1);
        const first = acknowledgments[0];
        assert.equal(first.document_generation, 'initial');
        assert.equal(Y.snapshotContainsUpdate(Y.decodeSnapshot(Buffer.from(first.snapshot_base64, 'base64')),
            Y.encodeStateAsUpdate(handle.document)), true);
        const vector = Buffer.from(Y.encodeStateVector(handle.document));
        fixture.state.storeStatus = 503;
        handle.document.getText('title').delete(0, 7);
        assert.deepEqual(Buffer.from(Y.encodeStateVector(handle.document)), vector);
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        await wait(300);
        assert.equal(acknowledgments.length, 1);
        assert.equal(Y.snapshotContainsUpdate(Y.decodeSnapshot(Buffer.from(first.snapshot_base64, 'base64')),
            Y.encodeStateAsUpdate(handle.document)), false);
        fixture.state.storeStatus = 200;
        await waitFor(() => acknowledgments.length === 2);
        assert.equal(Y.snapshotContainsUpdate(Y.decodeSnapshot(Buffer.from(acknowledgments[1].snapshot_base64, 'base64')),
            Y.encodeStateAsUpdate(handle.document)), true);
        assert.equal(decodeDocument(fixture.state.storedDocuments.get('durable-delete')).getText('title').toString(), ' durable title');
    } finally {
        fixture.state.storeStatus = 200;
        await destroyProvider(handle);
    }
});

test('aggregate size rejection happens before mutation, broadcast or persistence and preserves earlier accepted edits', async () => {
    const limited = await startCollaboration(fixture, { maxDocumentBytes: 512 });
    const editor = createProvider(limited, { name: 'notes:aggregate-cap', token: 'write-ticket' });
    const viewer = createProvider(limited, { name: 'notes:aggregate-cap', token: 'read-ticket' });
    try {
        for (const handle of [editor, viewer]) {
            const synced = waitForEvent(handle.provider, 'synced', { predicate: (payload) => payload?.state });
            handle.websocketProvider.connect();
            await synced;
            handle.websocketProvider.shouldConnect = false;
        }
        editor.document.getText('title').insert(0, 'a'.repeat(150));
        await waitFor(() => fixture.state.storedDocuments.has('aggregate-cap'));
        await waitFor(() => viewer.document.getText('title').length === 150);
        const revision = fixture.state.durableRevisions.get('aggregate-cap');
        const closed = waitForEvent(editor.websocketProvider, 'close');
        editor.document.getText('title').insert(150, 'b'.repeat(600));
        await closed;
        await wait(300);
        assert.equal(viewer.document.getText('title').toString(), 'a'.repeat(150));
        assert.equal(decodeDocument(fixture.state.storedDocuments.get('aggregate-cap')).getText('title').toString(), 'a'.repeat(150));
        assert.equal(fixture.state.durableRevisions.get('aggregate-cap'), revision);
    } finally {
        await destroyProvider(editor); await destroyProvider(viewer); await limited.stop();
    }
});

async function replacementRequest(action, noteId, replacementId) {
    return fetch(`${collaboration.baseUrl}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nest-Collaboration-Secret': 'fixture-secret' },
        body: JSON.stringify({ note_id: noteId, replacement_id: replacementId }),
    });
}

test('replacement quiesces and flushes accepted edits, retires old cache, and reconnects exclusively to the new generation', async () => {
    const noteId = 'prepared-replacement';
    const editor = await syncedProvider(noteId);
    let reconnect;
    try {
        editor.document.getText('title').insert(0, 'Accepted before restore');
        await waitFor(() => !editor.provider.hasUnsyncedChanges);
        const prepared = await replacementRequest('prepare-replacement', noteId, 'replacement-1');
        assert.equal(prepared.status, 200);
        assert.equal(decodeDocument(fixture.state.storedDocuments.get(noteId)).getText('title').toString(), 'Accepted before restore');
        const blocked = createProvider(collaboration, { name: `notes:${noteId}`, token: 'write-ticket' });
        try {
            const denied = waitForEvent(blocked.provider, 'authenticationFailed');
            blocked.websocketProvider.connect();
            await denied;
        } finally { await destroyProvider(blocked); }
        const restored = new Y.Doc();
        restored.getText('title').insert(0, 'Restored authoritative title');
        restored.getMap('nest:meta').set('schemaVersion', 1);
        restored.getMap('nest:meta').set('documentGeneration', 'restored-generation');
        fixture.state.storedDocuments.set(noteId, encodeDocument(restored));
        fixture.state.generations.set(noteId, 'restored-generation');
        const revision = fixture.state.durableRevisions.get(noteId) + 1;
        fixture.state.durableRevisions.set(noteId, revision);
        restored.destroy();
        const reloaded = await replacementRequest('reload', noteId, 'replacement-1');
        assert.equal(reloaded.status, 200);
        assert.equal(fixture.state.durableRevisions.get(noteId), revision);
        reconnect = await syncedProvider(noteId);
        assert.equal(reconnect.document.getText('title').toString(), 'Restored authoritative title');
        assert.equal(reconnect.document.getMap('nest:meta').get('documentGeneration'), 'restored-generation');
        await wait(850); // A superseded debounce callback must not unload this fresh room.
        reconnect.document.getText('title').insert(0, 'New edit: ');
        await waitFor(() => fixture.state.durableRevisions.get(noteId) > revision);
        assert.equal(decodeDocument(fixture.state.storedDocuments.get(noteId)).getText('title').toString(), 'New edit: Restored authoritative title');
    } finally {
        await destroyProvider(editor);
        if (reconnect) await destroyProvider(reconnect);
    }
});

test('reload requires a prepared fence, and failed flush cancels without discarding accepted edits', async () => {
    const noteId = 'cancelled-replacement';
    const editor = await syncedProvider(noteId);
    try {
        assert.equal((await replacementRequest('reload', noteId, 'unprepared')).status, 400);
        fixture.state.storeStatus = 503;
        editor.document.getText('title').insert(0, 'Accepted pending draft');
        await waitFor(() => !editor.provider.hasUnsyncedChanges);
        assert.equal((await replacementRequest('prepare-replacement', noteId, 'failed-flush')).status, 400);
        assert.equal((await replacementRequest('cancel-replacement', noteId, 'failed-flush')).status, 200);
        fixture.state.storeStatus = 200;
        await waitFor(() => fixture.state.storedDocuments.has(noteId));
        assert.equal(decodeDocument(fixture.state.storedDocuments.get(noteId)).getText('title').toString(), 'Accepted pending draft');
        const reconnect = await syncedProvider(noteId);
        assert.equal(reconnect.document.getText('title').toString(), 'Accepted pending draft');
        await destroyProvider(reconnect);
    } finally {
        fixture.state.storeStatus = 200;
        await destroyProvider(editor);
    }
});

test('a committed replacement recovers from a lost reload callback even when no document was loaded', async () => {
    const noteId = 'lost-reload';
    const original = new Y.Doc();
    original.getText('title').insert(0, 'Original document');
    fixture.state.storedDocuments.set(noteId, encodeDocument(original));
    original.destroy();
    assert.equal((await replacementRequest('prepare-replacement', noteId, 'lost-callback')).status, 200);
    const replacement = new Y.Doc();
    replacement.getText('title').insert(0, 'Recovered committed replacement');
    replacement.getMap('nest:meta').set('documentGeneration', 'lost-reload-generation');
    fixture.state.storedDocuments.set(noteId, encodeDocument(replacement));
    fixture.state.generations.set(noteId, 'lost-reload-generation');
    fixture.state.durableRevisions.set(noteId, 1);
    replacement.destroy();
    await wait(450);
    const reconnect = await syncedProvider(noteId);
    try {
        assert.equal(reconnect.document.getText('title').toString(), 'Recovered committed replacement');
        assert.equal((await replacementRequest('reload', noteId, 'lost-callback')).status, 200);
        assert.equal(fixture.state.durableRevisions.get(noteId), 1);
    } finally { await destroyProvider(reconnect); }
});

test('an already in-flight stale PUT cannot overwrite an externally committed generation or ACK its superseded edits', async () => {
    const noteId = 'stale-put';
    const editor = await syncedProvider(noteId);
    const acknowledgments = [];
    editor.provider.on('stateless', ({ payload }) => acknowledgments.push(JSON.parse(payload)));
    let started;
    let resume;
    const submitted = new Promise((resolve) => { started = resolve; });
    fixture.state.beforeStore = async (candidate) => {
        if (candidate !== noteId) return;
        started();
        await new Promise((resolve) => { resume = resolve; });
    };
    try {
        editor.document.getText('title').insert(0, 'Old in-flight title');
        await submitted;
        const replacement = new Y.Doc();
        replacement.getText('title').insert(0, 'Current durable replacement');
        replacement.getMap('nest:meta').set('documentGeneration', 'stale-put-generation');
        fixture.state.storedDocuments.set(noteId, encodeDocument(replacement));
        fixture.state.generations.set(noteId, 'stale-put-generation');
        fixture.state.durableRevisions.set(noteId, 1);
        replacement.destroy();
        const closed = waitForEvent(editor.websocketProvider, 'close');
        resume();
        await closed;
        await wait(300);
        assert.equal(fixture.state.durableRevisions.get(noteId), 1);
        assert.equal(decodeDocument(fixture.state.storedDocuments.get(noteId)).getText('title').toString(), 'Current durable replacement');
        assert.equal(acknowledgments.filter((event) => event.type === 'durable').length, 0);
        const reconnect = await syncedProvider(noteId);
        assert.equal(reconnect.document.getText('title').toString(), 'Current durable replacement');
        await destroyProvider(reconnect);
    } finally {
        fixture.state.beforeStore = null;
        resume?.();
        await destroyProvider(editor);
    }
});

test('SIGTERM drains retained edits after storage recovery even when SIGINT repeats shutdown', async () => {
    const storage = createFlaskFixture();
    await storage.start();
    const server = await startCollaboration(storage);
    const handle = createProvider(server, { name: 'notes:shutdown-recovery', token: 'write-ticket' });
    try {
        const synced = waitForEvent(handle.provider, 'synced', { predicate: (payload) => payload?.state });
        handle.websocketProvider.connect();
        await synced;
        handle.websocketProvider.shouldConnect = false;
        storage.state.storeStatus = 503;
        handle.document.getText('title').insert(0, 'Persist before exit');
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        const closed = waitForEvent(handle.websocketProvider, 'close');
        const exited = once(server.child, 'exit');
        server.child.kill('SIGTERM');
        await closed;
        await waitFor(() => server.output.includes('Collaboration storage unavailable'));
        server.child.kill('SIGINT');
        await wait(100);
        assert.equal(server.child.exitCode, null);
        assert.equal(storage.state.storedDocuments.has('shutdown-recovery'), false);
        storage.state.storeStatus = 200;
        await waitFor(() => server.child.exitCode !== null, { timeout: 3000 });
        const [code, signal] = await exited;
        assert.equal(code, 0, server.output);
        assert.equal(signal, null);
        const durable = decodeDocument(storage.state.storedDocuments.get('shutdown-recovery'));
        assert.equal(durable.getText('title').toString(), 'Persist before exit');
        durable.destroy();
        assert.equal(server.output.includes('Collaboration shutdown failed'), false);
    } finally {
        storage.state.storeStatus = 200;
        await destroyProvider(handle);
        await server.stop();
        await storage.stop();
    }
});

test('SIGTERM exits with explicit failure on its drain deadline and never ACKs unavailable storage', async () => {
    const storage = createFlaskFixture();
    await storage.start();
    const server = await startCollaboration(storage, { shutdownTimeoutMs: 250 });
    const handle = createProvider(server, { name: 'notes:shutdown-deadline', token: 'write-ticket' });
    const acknowledgments = [];
    handle.provider.on('stateless', ({ payload }) => acknowledgments.push(JSON.parse(payload)));
    try {
        const synced = waitForEvent(handle.provider, 'synced', { predicate: (payload) => payload?.state });
        handle.websocketProvider.connect();
        await synced;
        handle.websocketProvider.shouldConnect = false;
        storage.state.storeStatus = 503;
        handle.document.getText('title').insert(0, 'Unacknowledged draft');
        await waitFor(() => !handle.provider.hasUnsyncedChanges);
        const exited = once(server.child, 'exit');
        server.child.kill('SIGTERM');
        await waitFor(() => server.child.exitCode !== null, { timeout: 2000 });
        const [code, signal] = await exited;
        assert.equal(code, 1, server.output);
        assert.equal(signal, null);
        assert.match(server.output, /Collaboration shutdown failed:.*exceeded 250ms.*notes:shutdown-deadline/);
        assert.match(server.output, /Last collaboration storage error: storage unavailable/);
        assert.equal(storage.state.storedDocuments.has('shutdown-deadline'), false);
        assert.equal(acknowledgments.filter((event) => event.type === 'durable').length, 0);
    } finally {
        await destroyProvider(handle);
        await server.stop();
        await storage.stop();
    }
});
