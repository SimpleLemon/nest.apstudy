import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { createAccessControl } from './access-control.mjs';
import { createDocumentPersistence } from './document-persistence.mjs';
import { createDocumentSnapshot } from './document-projection.mjs';
import { createDocumentAdmission } from './document-admission.mjs';
import { createDocumentReplacement } from './document-replacement.mjs';
import { createCollaborationShutdown } from './shutdown.mjs';
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding';

const HOST = process.env.NOTES_COLLABORATION_HOST || '127.0.0.1';
const PORT = Number(process.env.NOTES_COLLABORATION_PORT || 1234);
const FLASK_BASE_URL = (process.env.NEST_FLASK_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const INTERNAL_SECRET = process.env.NOTES_COLLABORATION_INTERNAL_SECRET || process.env.NOTES_COLLABORATION_SECRET || '';
const MAX_UPDATE_BYTES = Number(process.env.NOTES_COLLABORATION_MAX_UPDATE_BYTES || 512 * 1024);
const MAX_DOCUMENT_BYTES = Number(process.env.NOTES_COLLABORATION_MAX_DOCUMENT_BYTES || 10 * 1024 * 1024);
const ACCESS_CHECK_INTERVAL = Number(process.env.NOTES_COLLABORATION_ACCESS_CHECK_INTERVAL_MS || 15000);
const REQUEST_TIMEOUT = Number(process.env.NOTES_COLLABORATION_REQUEST_TIMEOUT_MS || 5000);
const SHUTDOWN_TIMEOUT = Number(process.env.NOTES_COLLABORATION_SHUTDOWN_TIMEOUT_MS || 15000);
const ORIGIN_ALLOWLIST = (process.env.NOTES_COLLABORATION_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const durableAcknowledgments = new WeakMap();

function normalizeNoteId(documentName) {
    const value = String(documentName || '').trim();
    if (!value) return '';
    return value.replace(/^notes[:/]/, '');
}

function internalHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        ...(INTERNAL_SECRET ? { 'X-Nest-Collaboration-Secret': INTERNAL_SECRET } : {}),
        ...extra,
    };
}

function requestOrigin(requestHeaders) {
    return String(requestHeaders?.origin || '').trim();
}

function validateOrigin(requestHeaders) {
    if (!ORIGIN_ALLOWLIST.length) return true;
    const origin = requestOrigin(requestHeaders);
    return ORIGIN_ALLOWLIST.includes(origin);
}

async function parseJsonResponse(response) {
    let payload = null;
    let parseError = null;
    try { payload = await response.json(); }
    catch (error) { parseError = error; }
    if (!response.ok || parseError) {
        const message = !response.ok ? payload?.error || `Flask request failed with ${response.status}`
            : 'Invalid JSON response from Flask collaboration API.';
        const error = new Error(message, { cause: parseError || undefined });
        error.status = response.status;
        error.payload = payload;
        error.url = response.url;
        error.response = response;
        throw error;
    }
    return payload;
}

async function checkCurrentAccess({ noteId, userId }) {
    const response = await fetch(`${FLASK_BASE_URL}/api/internal/notes/collaboration-access`, {
        method: 'POST', headers: internalHeaders(),
        body: JSON.stringify({ note_id: noteId, user_id: userId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    return parseJsonResponse(response);
}

async function verifyTicket(ticket, noteId) {
    const response = await fetch(`${FLASK_BASE_URL}/api/internal/notes/collaboration-token/verify`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({ ticket, note_id: noteId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    return parseJsonResponse(response);
}

async function fetchStoredDocument(noteId) {
    const response = await fetch(`${FLASK_BASE_URL}/api/internal/notes/${encodeURIComponent(noteId)}/collaboration-document`, {
        headers: INTERNAL_SECRET ? { 'X-Nest-Collaboration-Secret': INTERNAL_SECRET } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (response.status === 404) return { bytes: null, revision: 0, generation: 'initial' };
    if (!response.ok) {
        throw new Error(`Unable to load collaboration document ${noteId}: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new Error(`Collaboration document ${noteId} exceeds size limit.`);
    }
    const revision = Number(response.headers.get('X-Nest-Durable-Revision'));
    if (!Number.isSafeInteger(revision) || revision < 0 || !response.headers.has('X-Nest-Durable-Revision')) {
        throw new Error('Collaboration durable revision is missing or invalid.');
    }
    const generation = response.headers.get('X-Nest-Document-Generation');
    if (!generation) throw new Error('Collaboration document generation is missing.');
    return { bytes, revision, generation };
}

async function storeDocument(noteId, document, expectedRevision) {
    const snapshot = await createDocumentSnapshot(document, { maxDocumentBytes: MAX_DOCUMENT_BYTES });
    const response = await fetch(`${FLASK_BASE_URL}/api/internal/notes/${encodeURIComponent(noteId)}/collaboration-document`, {
        method: 'PUT',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: internalHeaders(),
        body: JSON.stringify({ ...snapshot, expected_revision: expectedRevision }),
    });
    try {
        const result = await parseJsonResponse(response);
        if (!Number.isSafeInteger(result.durable_revision) || result.durable_revision !== expectedRevision + 1
            || result.document_generation !== snapshot.document_generation) {
            throw new Error('Collaboration durable acknowledgment is invalid.');
        }
        const acknowledgment = { type: 'durable',
            state_vector_base64: snapshot.state_vector_base64, snapshot_base64: snapshot.snapshot_base64,
            document_generation: snapshot.document_generation };
        durableAcknowledgments.set(document, acknowledgment);
        document.broadcastStateless(JSON.stringify(acknowledgment));
        return result;
    } catch (error) {
        if (error.status === 409) await replacement.retire(document);
        throw error;
    }
}

async function healthPayload() {
    const startedAt = globalThis.__nestNotesCollaborationStartedAt || new Date().toISOString();
    globalThis.__nestNotesCollaborationStartedAt = startedAt;
    try {
        const response = await fetch(`${FLASK_BASE_URL}/api/internal/notes/collaboration-health`, {
            headers: INTERNAL_SECRET ? { 'X-Nest-Collaboration-Secret': INTERNAL_SECRET } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        return {
            ok: response.ok,
            status: response.ok ? 'ready' : 'degraded',
            flask_status: response.status,
            started_at: startedAt,
        };
    } catch (error) {
        return {
            ok: false,
            status: 'degraded',
            flask_error: error.message,
            started_at: startedAt,
        };
    }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                reject(new Error('Request body is too large.'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (error) { reject(error); }
        });
        request.on('error', reject);
    });
}

const accessControl = createAccessControl({ checkAccess: checkCurrentAccess });
const persistence = createDocumentPersistence({ store: storeDocument, noteIdFor: normalizeNoteId });
const admission = createDocumentAdmission({ maxDocumentBytes: MAX_DOCUMENT_BYTES });
const replacement = createDocumentReplacement({ getServer: () => server, persistence, accessControl,
    readDurableHead: fetchStoredDocument });

const server = Server.configure({
    name: 'nest-notes-collaboration',
    address: HOST,
    port: PORT,
    debounce: 750,
    maxDebounce: 3000,
    timeout: 30000,
    quiet: process.env.NOTES_COLLABORATION_QUIET === '1',
    unloadImmediately: false,
    stopOnSignals: false,
    // Hocuspocus 2.x registers this hook only through extensions.
    extensions: [{
        async beforeUnloadDocument({ documentName }) {
            const document = server.documents.get(documentName);
            if (document) await persistence.beforeUnload(document);
        },
    }],

    async onRequest({ request, response }) {
        if (request.url === '/health' || request.url === '/healthz') {
            const payload = await healthPayload();
            response.writeHead(payload.ok ? 200 : 503, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(payload));
            throw null;
        }
        if (['/events', '/reload', '/prepare-replacement', '/cancel-replacement', '/access-invalidation'].includes(request.url) && request.method === 'POST') {
            if (!INTERNAL_SECRET || request.headers['x-nest-collaboration-secret'] !== INTERNAL_SECRET) {
                response.writeHead(403, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: 'forbidden' }));
                throw null;
            }
            try {
                shutdown.requireAvailable();
                const payload = await readJsonBody(request);
                shutdown.requireAvailable();
                if (request.url === '/access-invalidation') {
                    if (!Array.isArray(payload.note_ids) || payload.note_ids.some((id) => typeof id !== 'string' || !id)) {
                        throw new Error('note_ids must be an array of note IDs.');
                    }
                    const affected = new Set(payload.note_ids.map(normalizeNoteId));
                    for (const document of server.documents.values()) {
                        if (affected.has(normalizeNoteId(document.name))) accessControl.invalidate(document);
                    }
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    throw null;
                }
                const noteId = normalizeNoteId(payload.note_id);
                if (!noteId) throw new Error('Missing note ID.');
                const documentName = `notes:${noteId}`;
                const document = server.documents.get(documentName);
                if (['/prepare-replacement', '/cancel-replacement', '/reload'].includes(request.url)) {
                    await replacement.handle(request.url, noteId, payload.replacement_id);
                } else {
                    document?.broadcastStateless(JSON.stringify(payload.event || {}));
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ ok: true, delivered: Boolean(document) }));
            } catch (error) {
                if (error === null) throw null;
                response.writeHead(400, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: error.message }));
            }
            throw null;
        }
    },

    async onAuthenticate({ token, documentName, requestHeaders, connection }) {
        shutdown.requireAvailable();
        if (!validateOrigin(requestHeaders)) {
            throw new Error('Origin is not allowed.');
        }
        const noteId = normalizeNoteId(documentName);
        if (!noteId) throw new Error('Missing note ID.');
        if (documentName !== `notes:${noteId}`) throw new Error('Canonical collaboration document name is required.');
        replacement.requireAvailable(noteId);
        const verification = await verifyTicket(token, noteId);
        shutdown.requireAvailable();
        replacement.requireAvailable(noteId);
        if (!Array.isArray(verification.permission_revision)) {
            throw new Error('Current collaboration permission revision is required.');
        }
        if (typeof verification.document_generation !== 'string' || !verification.document_generation) {
            throw new Error('Current collaboration document generation is required.');
        }
        connection.readOnly = !verification.can_write;
        return {
            noteId,
            userId: verification.user_id,
            role: verification.role,
            public: verification.public,
            anonymous: verification.anonymous,
            awarenessAllowed: verification.awareness_allowed,
            user: verification.user,
            accessRevision: verification.access_revision,
            permissionRevision: verification.permission_revision,
            documentGeneration: verification.document_generation,
            canWrite: verification.can_write,
        };
    },

    async connected({ documentName, connectionInstance }) {
        const document = server.documents.get(documentName);
        const acknowledgment = durableAcknowledgments.get(document);
        if (acknowledgment) connectionInstance.sendStateless(JSON.stringify(acknowledgment));
    },

    async onLoadDocument({ documentName, document }) {
        shutdown.requireAvailable();
        const noteId = normalizeNoteId(documentName);
        replacement.requireAvailable(noteId);
        const stored = await fetchStoredDocument(noteId);
        shutdown.requireAvailable();
        replacement.requireAvailable(noteId);
        persistence.loaded(document, stored.revision);
        if (stored.bytes) {
            Y.applyUpdate(document, stored.bytes);
            if (String(document.getMap('nest:meta').get('documentGeneration') || 'initial') !== stored.generation) {
                throw new Error('Stored collaboration generation does not match durable metadata.');
            }
            durableAcknowledgments.set(document, { type: 'durable', document_generation: stored.generation,
                state_vector_base64: Buffer.from(Y.encodeStateVector(document)).toString('base64'),
                snapshot_base64: Buffer.from(Y.encodeSnapshot(Y.snapshot(document))).toString('base64') });
        }
        if (!document.getMap('nest:meta').has('schemaVersion')) document.getMap('nest:meta').set('schemaVersion', 1);
    },

    async afterLoadDocument({ document }) {
        accessControl.guardDocument(document);
    },

    async beforeHandleMessage({ update, connection, document }) {
        if (update?.byteLength > MAX_UPDATE_BYTES) {
            throw new Error('Collaboration update is too large.');
        }
        await accessControl.check(connection);
        shutdown.requireAvailable();
        replacement.requireAvailable(normalizeNoteId(document.name));
        // Awareness hooks run after mutation in Hocuspocus 2.x. Reject before
        // application so anonymous/public clients cannot disclose awareness.
        const decoder = createDecoder(update);
        readVarString(decoder);
        const messageType = readVarUint(decoder);
        if ((messageType === 0 || messageType === 4) && !connection.readOnly) {
            const syncType = readVarUint(decoder);
            if (syncType === 1 || syncType === 2) admission.accept(document, readVarUint8Array(decoder));
        }
        if (messageType === 1 && !connection.context.awarenessAllowed) {
            const awareness = createDecoder(readVarUint8Array(decoder));
            const clients = readVarUint(awareness);
            for (let index = 0; index < clients; index += 1) {
                readVarUint(awareness);
                readVarUint(awareness);
                // Clearing local awareness on disconnect is harmless; publishing
                // an identity must be denied before Hocuspocus applies the frame.
                if (JSON.parse(readVarString(awareness)) !== null) {
                    throw new Error('Awareness is disabled for this collaboration connection.');
                }
            }
        }
    },

    async onChange({ document }) {
        persistence.changed(document);
    },

    async onStoreDocument({ document }) {
        await persistence.save(document);
    },

});

server.listen();

let idleCheckRunning = false;
const idleChecks = setInterval(async () => {
    if (idleCheckRunning) return;
    idleCheckRunning = true;
    try {
        await replacement.reconcile();
        for (const document of server.documents.values()) {
            await accessControl.checkDocument(document);
            await persistence.retry(document);
        }
    } finally { idleCheckRunning = false; }
}, Math.max(50, ACCESS_CHECK_INTERVAL));
idleChecks.unref();

const shutdown = createCollaborationShutdown({ server, persistence,
    stopRetries: () => clearInterval(idleChecks), timeoutMs: SHUTDOWN_TIMEOUT });
const handleShutdown = () => {
    shutdown.shutdown().then(() => process.exit(0), (error) => {
        console.error('Collaboration shutdown failed:', error.message);
        if (error.cause) console.error('Last collaboration storage error:', error.cause.message);
        process.exit(1);
    });
};
process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);
process.on('SIGQUIT', handleShutdown);
