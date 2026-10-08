import { createDecoder, readVarString, readVarUint } from 'lib0/decoding';

/** Current ACL guards for Hocuspocus 2.x's synchronous send boundary. */
export function createAccessControl({ checkAccess, maxQueuedBytes = 20 * 1024 * 1024 }) {
    const states = new WeakMap();

    function rejectConnection(connection, reason = 'collaboration_access_changed') {
        const state = states.get(connection);
        if (state) state.closed = true;
        connection.readOnly = true;
        connection.close({ code: 4403, reason });
    }

    async function check(connection) {
        const state = states.get(connection);
        if (!state || state.closed) throw new Error('Collaboration connection is closed.');
        try {
            // The identity was returned by Flask during authentication. Never use
            // client message fields or revalidate the expiring admission ticket.
            const access = await checkAccess(state.identity);
            if (state.closed) throw new Error('Collaboration connection is closed.');
            if (!access?.ok || !Array.isArray(access.permission_revision) || access.note_id !== state.identity.noteId
                || access.user_id !== state.identity.userId
                || JSON.stringify(access.permission_revision) !== state.revision
                || !state.generation || access.document_generation !== state.generation
                || state.cachedGeneration !== state.generation
                || Boolean(access.can_write) !== state.canWrite
                || Boolean(access.awareness_allowed) !== state.awarenessAllowed) {
                rejectConnection(connection);
                throw new Error('Collaboration access changed.');
            }
            connection.readOnly = !access.can_write;
            return access;
        } catch (error) {
            if (!state.closed) rejectConnection(connection, error.status === 403 ? 'collaboration_access_revoked'
                : 'collaboration_permissions_unavailable');
            throw error;
        }
    }

    function attach(connection, document) {
        if (states.has(connection)) return;
        const context = connection.context;
        const state = {
            identity: Object.freeze({ noteId: context.noteId, userId: context.userId }),
            revision: JSON.stringify(context.permissionRevision),
            canWrite: Boolean(context.canWrite),
            awarenessAllowed: Boolean(context.awarenessAllowed),
            generation: context.documentGeneration,
            cachedGeneration: document.getMap?.('nest:meta').get('documentGeneration') || 'initial',
            closed: false, queuedBytes: 0, outgoing: Promise.resolve(),
        };
        states.set(connection, state);
        const send = connection.send.bind(connection);
        connection.send = (message) => {
            if (state.closed) return;
            const size = message.byteLength ?? message.length ?? 0;
            state.queuedBytes += size;
            if (state.queuedBytes > maxQueuedBytes) {
                rejectConnection(connection, 'collaboration_backpressure');
                return;
            }
            // Hocuspocus's Yjs/awareness/stateless broadcasts bypass async hooks.
            // Queue at send, checking fresh permission before any disclosure.
            state.outgoing = state.outgoing.then(async () => {
                await check(connection);
                if (!state.closed) {
                    const decoder = createDecoder(message);
                    readVarString(decoder);
                    if (readVarUint(decoder) !== 1 || state.awarenessAllowed) send(message);
                }
            }).catch(() => {}).finally(() => { state.queuedBytes -= size; });
        };
    }

    function guardDocument(document) {
        const addConnection = document.addConnection.bind(document);
        document.addConnection = (connection) => {
            attach(connection, document);
            return addConnection(connection);
        };
    }

    function invalidate(document) {
        // Mark every connection before closing any: close removes awareness and
        // synchronously broadcasts removal to the remaining document members.
        const connections = document.getConnections();
        for (const connection of connections) {
            const state = states.get(connection);
            if (state) state.closed = true;
        }
        for (const connection of connections) rejectConnection(connection);
    }

    async function checkDocument(document) {
        await Promise.allSettled(document.getConnections().map(check));
    }

    return { check, guardDocument, invalidate, checkDocument };
}
