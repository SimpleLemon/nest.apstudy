import { applyUpdate, decodeSnapshot, encodeStateAsUpdate, snapshotContainsUpdate } from 'yjs';
import { createCollaborationDraftStore } from './collaboration-draft-store.js';

const retainedDrafts = new Map();

function decodeBase64(value) {
    return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

/** Capture pending state independently of transport ACKs and current edit access. */
export function createCollaborationRecovery({
    noteId, document, getProvider, getReady, onPendingChanges, onStatus,
    getDraftContent = () => undefined,
    store = createCollaborationDraftStore(), memory = retainedDrafts,
    eventTarget = globalThis.window,
}) {
    let identity = null;
    let generation = null;
    let key = null;
    let loadedKey = null;
    let loadedEditable = false;
    let pending = false;
    let locallySaved = false;
    let storageError = null;
    let blockedDraft = null;
    let revision = 0;
    let disposed = false;
    let writes = Promise.resolve();

    function setPending(value) {
        pending = value;
        onPendingChanges?.(value);
    }
    function status(base) {
        if (blockedDraft) return ['draft-blocked', { draft: blockedDraft }];
        if (storageError) return ['local-save-failed', { draft: key ? memory.get(key) : null }];
        if (pending && locallySaved && !getReady()) return ['offline-local', {}];
        return [pending && base === 'saved' ? 'saving' : base, {}];
    }
    function report(base = getReady() ? 'saving' : 'offline-readonly') {
        if (!disposed) onStatus?.(...status(base));
    }
    function warnBeforeUnload(event) {
        if (!pending) return;
        event.preventDefault();
        event.returnValue = '';
    }
    function capture() {
        if (!pending || !key) return null;
        const record = {
            key, identity, noteId, generation, updatedAt: Date.now(),
            update: encodeStateAsUpdate(document), title: document.getText('title').toString(),
            content: getDraftContent(),
        };
        memory.set(key, record);
        return record;
    }
    function checkpoint() {
        const record = capture();
        if (!record) return writes;
        const capturedRevision = revision;
        writes = writes.then(async () => {
            try {
                // BlockNote invalidates its cached export after the Yjs update event.
                // Refresh the human-readable export once that synchronous edit finishes.
                if (!disposed && capturedRevision === revision) record.content = getDraftContent();
                await store.write(record);
                if (capturedRevision === revision) { locallySaved = true; storageError = null; }
            } catch (error) {
                if (capturedRevision === revision) storageError = error;
            }
            if (pending && capturedRevision === revision) report();
        });
        return writes;
    }
    const localUpdate = (_update, origin) => {
        if (disposed || origin === getProvider()) return;
        revision++;
        locallySaved = false;
        setPending(true);
        report();
        void checkpoint();
    };

    async function admit(userId, nextGeneration, canEdit, isCurrent = () => true) {
        if (disposed) return;
        const nextIdentity = userId ? JSON.stringify([userId, noteId]) : null;
        const nextKey = userId ? JSON.stringify([userId, noteId, nextGeneration]) : null;
        if (!nextKey || (nextKey === loadedKey && (!canEdit || loadedEditable))) return;
        let records = [...memory.values()].filter((record) => record.identity === nextIdentity);
        let readError = null;
        try {
            const stored = await store.read(userId, noteId);
            const byKey = new Map(stored.map((record) => [record.key, record]));
            for (const record of records) byKey.set(record.key, record);
            records = [...byKey.values()];
        } catch (error) { readError = error; }
        if (disposed || !isCurrent()) return;
        generation = nextGeneration;
        identity = nextIdentity;
        key = nextKey;
        loadedKey = key;
        loadedEditable = canEdit;
        storageError = readError;
        blockedDraft = null;
        const draft = records.find((record) => record.key === key);
        if (draft && canEdit) {
            applyUpdate(document, draft.update, getProvider());
            revision++;
            setPending(true);
            locallySaved = !storageError;
            memory.set(key, draft);
        } else if (draft) blockedDraft = draft;
        blockedDraft ||= records.filter((record) => record.generation !== generation)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
        if (pending && !draft) void checkpoint();
        report('connecting');
    }

    function acknowledge(event) {
        if (disposed || !pending || event.document_generation !== generation || !event.snapshot_base64) return false;
        try {
            if (!snapshotContainsUpdate(decodeSnapshot(decodeBase64(event.snapshot_base64)), encodeStateAsUpdate(document))) return false;
        } catch { return false; }
        const acknowledgedKey = key;
        setPending(false);
        locallySaved = false;
        memory.delete(acknowledgedKey);
        // Serialize delete after older checkpoints; a subsequent edit queues a new write.
        writes = writes.then(() => store.remove(acknowledgedKey)).catch(() => {});
        report('saved');
        return true;
    }

    document.on('update', localUpdate);
    eventTarget?.addEventListener('beforeunload', warnBeforeUnload);
    return {
        admit, acknowledge, checkpoint, status,
        hasPendingChanges: () => pending,
        whenStored: () => writes,
        dispose() {
            if (disposed) return;
            void checkpoint();
            disposed = true;
            document.off('update', localUpdate);
            eventTarget?.removeEventListener('beforeunload', warnBeforeUnload);
        },
    };
}
