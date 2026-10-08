/** Quiesce and flush accepted updates before an authoritative replacement. */
export function createDocumentReplacement({ getServer, persistence, accessControl, readDurableHead }) {
    const pending = new Map();
    const completed = new Map();
    async function retire(document) {
        persistence.retire(document);
        accessControl.invalidate(document);
        // Drain Hocuspocus's old debounce callback while the document is
        // retired. Otherwise its later unload can delete a fresh room with
        // the same name after the replacement has become available.
        await getServer().debouncer?.executeNow(`onStoreDocument-${document.name}`);
        await getServer().unloadDocument(document);
    }
    function requireAvailable(noteId) {
        if (pending.has(noteId)) throw new Error('Collaboration document replacement is in progress.');
    }
    async function handle(action, noteId, replacementId) {
        if (typeof replacementId !== 'string' || !replacementId) throw new Error('replacement_id is required.');
        const current = pending.get(noteId);
        const previous = completed.get(noteId);
        const server = getServer();
        const documentName = `notes:${noteId}`;
        if (current && current.id !== replacementId) throw new Error('Another document replacement is in progress.');
        if (action === '/prepare-replacement') {
            if (!current && previous?.id === replacementId) throw new Error('Document replacement already completed.');
            if (!current && previous?.id !== replacementId) {
                const replacement = { id: replacementId, preparing: null, ready: false, generation: null, finishing: null };
                pending.set(noteId, replacement);
                replacement.preparing = (async () => {
                    await server.loadingDocuments.get(documentName);
                    const document = server.documents.get(documentName);
                    if (document) {
                        accessControl.invalidate(document);
                        await persistence.flush(document);
                    }
                    replacement.generation = (await readDurableHead(noteId)).generation;
                    replacement.ready = true;
                })();
            }
            await pending.get(noteId)?.preparing;
        } else if (action === '/cancel-replacement') {
            if (current) {
                if (current.finishing) { await current.finishing; return; }
                await current.preparing.catch(() => {});
                pending.delete(noteId);
                completed.set(noteId, { id: replacementId, action: 'cancel' });
            }
        } else if (action === '/reload') {
            if (!current && (previous?.id !== replacementId || previous.action !== 'reload')) {
                throw new Error('Document replacement was not prepared.');
            }
            if (current) {
                current.finishing ||= (async () => {
                    await current.preparing;
                    const document = server.documents.get(documentName);
                    if (document) await retire(document);
                    if (pending.get(noteId) === current) pending.delete(noteId);
                    completed.set(noteId, { id: replacementId, action: 'reload' });
                })();
                await current.finishing;
            }
        }
    }
    async function reconcile() {
        for (const [noteId, replacement] of pending) {
            if (!replacement.ready || replacement.finishing) continue;
            try {
                const head = await readDurableHead(noteId);
                if (pending.get(noteId) === replacement && head.generation !== replacement.generation) {
                    // The database commit is authoritative even when its HTTP
                    // reload callback was lost. Keep the fence until that
                    // commit is visible; never retry the superseded blob.
                    await handle('/reload', noteId, replacement.id);
                }
            } catch (error) {
                console.error('Collaboration replacement reconciliation unavailable:', error.message);
            }
        }
    }
    return { handle, retire, requireAvailable, reconcile };
}
