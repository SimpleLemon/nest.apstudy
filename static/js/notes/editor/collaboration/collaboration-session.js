import { createCollaborationRecovery } from './collaboration-recovery.js';

/** Admission and recovery state; the same Y.Doc survives permission outages. */
export function createCollaborationSession({
    noteId, access, initialGeneration = null, document, createProvider, userFromToken,
    onStatus, onAccessChange, onReviewEvent, onPresence, onPendingChanges, onDocumentChange,
    draftStore, draftMemory, getDraftContent,
    eventTarget = globalThis.window,
    requestToken = async () => {
        const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}/collaboration-token`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(10000),
        });
        let payload = null;
        let parseError = null;
        try { payload = await response.json(); }
        catch (error) { parseError = error; }
        if (!response.ok || parseError) {
            const error = new Error(!response.ok
                ? payload?.error || 'Unable to connect to note collaboration.'
                : 'Invalid collaboration token response.', { cause: parseError || undefined });
            error.status = response.status;
            error.url = response.url;
            error.response = response;
            throw error;
        }
        return payload;
    },
    schedule = (callback, delay) => window.setTimeout(callback, delay),
    cancel = (timer) => window.clearTimeout(timer),
}) {
    const user = userFromToken({}, access);
    const subscribers = new Set();
    let currentAccess = access || {};
    let awarenessAllowed = false;
    let authenticated = false;
    let admitted = false;
    let synced = false;
    let disposed = false;
    let suspended = false;
    let documentGeneration = initialGeneration;
    let admittedUserId = null;
    let durableEvent = null;
    let retryTimer = null;
    let retryDelay = 1000;
    let admission = 0;
    let provider;
    const recovery = createCollaborationRecovery({
        noteId, document, getProvider: () => provider, getReady: ready,
        store: draftStore, memory: draftMemory, getDraftContent, eventTarget,
        onPendingChanges, onStatus,
    });

    function ready() { return !disposed && !suspended && authenticated && synced && currentAccess.can_view === true; }
    function status(value) { if (!disposed) onStatus?.(...recovery.status(value)); }
    function publish() {
        if (disposed) return;
        onAccessChange?.(currentAccess, { readOnly: !ready() || currentAccess.can_edit !== true, ready: ready(), user });
        for (const listener of subscribers) listener();
    }
    function presence() {
        provider?.awareness?.setLocalState?.(ready() && awarenessAllowed ? { user: { ...user } } : null);
        onPresence?.(provider, user, ready() && awarenessAllowed);
    }
    function pause(status) {
        authenticated = false;
        admitted = false;
        synced = false;
        durableEvent = null;
        admission += 1;
        publish();
        presence();
        if (!disposed) onStatus?.(...recovery.status(status));
    }
    function retry() {
        if (disposed || suspended || retryTimer !== null) return;
        retryTimer = schedule(() => {
            retryTimer = null;
            if (disposed || suspended) return;
            provider.disconnect();
            Promise.resolve(provider.connect()).catch(() => retry());
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
    }
    async function token() {
        if (disposed || suspended) throw new Error('Collaboration session is paused.');
        pause('connecting');
        const requestAdmission = admission;
        try {
            const payload = await requestToken();
            if (disposed || requestAdmission !== admission) throw new Error('Collaboration admission was superseded.');
            if (!payload?.token || payload.access?.can_view !== true) throw new Error('Note access is unavailable.');
            if (typeof payload.document_generation !== 'string' || !payload.document_generation.trim()) {
                throw new Error('The current document generation is unavailable.');
            }
            const nextGeneration = payload.document_generation;
            const nextUser = userFromToken(payload, payload.access);
            if (payload.access.can_edit === true && !nextUser.id) throw new Error('The editor identity is unavailable.');
            if (documentGeneration !== null && (documentGeneration !== nextGeneration
                || (admittedUserId !== null && admittedUserId !== nextUser.id)
                || (recovery.hasPendingChanges() && payload.access.can_edit !== true))) {
                void recovery.checkpoint();
                suspended = true;
                pause('offline-readonly');
                provider.disconnect();
                onDocumentChange?.();
                throw new Error('Collaboration requires a fresh document.');
            }
            currentAccess = payload.access;
            awarenessAllowed = payload.awareness_allowed === true;
            Object.assign(user, nextUser);
            documentGeneration = nextGeneration;
            admittedUserId = nextUser.id;
            await recovery.admit(user.id, documentGeneration, currentAccess.can_edit === true,
                () => !disposed && requestAdmission === admission);
            if (disposed || requestAdmission !== admission) throw new Error('Collaboration admission was superseded.');
            user.mode = currentAccess.role === 'reviewer' ? 'suggesting' : currentAccess.can_edit ? 'editing' : 'viewing';
            admitted = true;
            publish();
            return payload.token;
        } catch (error) {
            if (!disposed && requestAdmission === admission) { pause('offline-readonly'); retry(); }
            throw error;
        }
    }
    provider = createProvider({
        document, name: `notes:${noteId}`, token, connect: false, broadcast: false,
        onStatus: ({ status }) => {
            if (disposed) return;
            if (status === 'disconnected') pause('reconnecting');
            if (status === 'connecting') pause('connecting');
        },
        onAuthenticated: () => {
            if (disposed || !admitted) return;
            authenticated = true;
            publish();
            presence();
            reportReady();
        },
        onSynced: ({ state }) => {
            if (disposed || !admitted) return;
            synced = Boolean(state);
            publish();
            presence();
            reportReady();
        },
        onAuthenticationFailed: () => { if (!disposed) { pause('offline-readonly'); retry(); } },
        onStateless: ({ payload }) => {
            if (disposed || !admitted || !authenticated) return;
            try {
                const event = JSON.parse(payload || '{}');
                if (event.type === 'durable') {
                    if (ready()) recovery.acknowledge(event);
                    else durableEvent = event;
                }
                if (ready() && String(event.type || '').startsWith('review.')) onReviewEvent?.(event);
            } catch { /* Non-review messages do not affect the review panel. */ }
        },
    });
    function reportReady() {
        if (!ready()) return;
        retryDelay = 1000;
        if (retryTimer !== null) cancel(retryTimer);
        retryTimer = null;
        if (durableEvent) { recovery.acknowledge(durableEvent); durableEvent = null; }
        status(provider.hasUnsyncedChanges ? 'saving' : 'saved');
    }
    const unsynced = () => {
        if (disposed) return;
        if (ready()) status(provider.hasUnsyncedChanges ? 'saving' : 'saved');
    };
    const awareness = () => { if (!disposed) onPresence?.(provider, user, ready() && awarenessAllowed); };
    provider.on?.('unsyncedChanges', unsynced);
    provider.awareness?.on?.('change', awareness);
    publish();
    presence();
    Promise.resolve(provider.connect()).catch(() => retry());
    return {
        document, provider, user, fragment: document.getXmlFragment('document-store'),
        get access() { return currentAccess; },
        get ready() { return ready(); },
        hasPendingChanges: recovery.hasPendingChanges,
        whenLocallySaved: recovery.whenStored,
        subscribeAccess(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
        setMode(mode) { user.mode = mode; presence(); },
        pause() {
            if (disposed || suspended) return;
            suspended = true;
            if (retryTimer !== null) cancel(retryTimer);
            retryTimer = null;
            pause('offline-readonly');
            provider.disconnect();
        },
        resume() {
            if (disposed || !suspended) return;
            suspended = false;
            Promise.resolve(provider.connect()).catch(() => retry());
        },
        destroy() {
            if (disposed) return;
            recovery.dispose();
            disposed = true;
            admission += 1;
            if (retryTimer !== null) cancel(retryTimer);
            provider.off?.('unsyncedChanges', unsynced);
            provider.awareness?.off?.('change', awareness);
            subscribers.clear();
            provider.destroy();
            provider.configuration?.websocketProvider?.destroy?.();
            document.destroy();
        },
    };
}
