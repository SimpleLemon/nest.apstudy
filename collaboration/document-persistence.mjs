/** Keep accepted updates in memory until durable storage acknowledges them. */
export function createDocumentPersistence({ store, noteIdFor }) {
    const states = new WeakMap();
    function stateFor(document) {
        let state = states.get(document);
        if (!state) {
            state = { revision: 0, storedRevision: 0, durableRevision: 0, saving: null, waiters: [], retired: false, lastError: null };
            states.set(document, state);
        }
        return state;
    }
    function changed(document) {
        const state = stateFor(document);
        if (!state.retired) state.revision += 1;
    }
    async function save(document) {
        const state = stateFor(document);
        if (state.retired) return;
        if (state.saving) {
            await state.saving;
            return;
        }
        const revision = state.revision;
        state.saving = (async () => {
            try {
                const result = await store(noteIdFor(document.name), document, state.durableRevision);
                if (state.retired) return;
                state.durableRevision = result?.durable_revision ?? state.durableRevision + 1;
                state.lastError = null;
                state.storedRevision = revision;
                if (state.storedRevision === state.revision) {
                    for (const resolve of state.waiters.splice(0)) resolve();
                }
            } catch (error) {
                state.lastError = error;
                // Hocuspocus's timer does not catch rejected store promises.
                // Keep the dirty document loaded; the idle loop retries.
                console.error('Collaboration storage unavailable; retaining document:', error.message);
            }
        })();
        await state.saving;
        state.saving = null;
    }
    async function beforeUnload(document) {
        const state = stateFor(document);
        if (state.storedRevision < state.revision) {
            await new Promise((resolve) => state.waiters.push(resolve));
        }
    }
    async function retry(document) {
        const state = stateFor(document);
        if (state.storedRevision < state.revision && !state.saving) await save(document);
    }
    function loaded(document, durableRevision) { stateFor(document).durableRevision = durableRevision; }
    function retire(document) {
        const state = stateFor(document);
        state.retired = true;
        state.storedRevision = state.revision;
        for (const resolve of state.waiters.splice(0)) resolve();
    }
    async function flush(document) {
        const state = stateFor(document);
        if (state.saving) await state.saving;
        while (!state.retired && state.storedRevision < state.revision) {
            await save(document);
            if (state.lastError) throw state.lastError;
        }
        return state.durableRevision;
    }
    return { changed, save, beforeUnload, retry, loaded, retire, flush };
}
