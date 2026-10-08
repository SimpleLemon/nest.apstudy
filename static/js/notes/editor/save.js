const SAVE_DEBOUNCE_MS = 800;
const SAVE_DEBOUNCE_LARGE_DOC_MS = 1500;
const LARGE_DOCUMENT_BLOCK_COUNT = 120;
const SAVED_TIME_REFRESH_MS = 60000;

export function fingerprintTextParts(parts) {
    let hash = 2166136261;
    let length = 0;
    parts.forEach((part) => {
        const text = String(part ?? '');
        length += text.length;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        hash ^= 0;
        hash = Math.imul(hash, 16777619);
    });
    return `${length}:${(hash >>> 0).toString(36)}`;
}

export function notePayloadFingerprint(title, content) {
    return fingerprintTextParts([title, content]);
}

export function createNoteSaveRuntime({
    noteId,
    titleInput,
    saveStatus,
    saveRetry,
    getCanEdit,
    getEditor,
    getNoteCollaborationEnabled,
    getCurrentDocumentSnapshot,
    getTopLevelBlockCount,
}) {
    let saveDebounceTimer = null;
    let savedTimeRefreshTimer = null;
    let lastSavedAt = null;
    let noteHasPendingChanges = false;
    let collaborationHasPendingChanges = false;
    let lastSavedPayloadFingerprint = '';
    let saveTask = null;
    let saveRequested = false;
    let saveController = null;
    let disposed = false;
    let collaborationRequired = false;
    let recoveryDraft = null;

    function clearSavedTimeRefresh() {
        if (savedTimeRefreshTimer) {
            clearInterval(savedTimeRefreshTimer);
            savedTimeRefreshTimer = null;
        }
    }

    function renderSavedTime() {
        if (!saveStatus || !lastSavedAt) return;
        saveStatus.textContent = `Saved ${formatRelativeSavedTime(lastSavedAt)}`;
    }

    function setLastSavedAt(value) {
        lastSavedAt = parseSavedDate(value) || new Date();
        renderSavedTime();
        clearSavedTimeRefresh();
        savedTimeRefreshTimer = window.setInterval(renderSavedTime, SAVED_TIME_REFRESH_MS);
    }

    function setSaveStatus(status, options = {}) {
        if (disposed || !saveStatus) return;
        recoveryDraft = null;
        if (saveRetry) { saveRetry.hidden = true; saveRetry.textContent = 'Retry'; }

        saveStatus.classList.remove(
            'save-status-hidden',
            'save-status-saving',
            'save-status-saved',
            'save-status-error'
        );

        if (status === 'saving') {
            clearSavedTimeRefresh();
            saveStatus.textContent = options.message || 'Saving...';
            saveStatus.classList.add('save-status-saving');
            return;
        }

        if (status === 'connecting') {
            clearSavedTimeRefresh();
            saveStatus.textContent = 'Connecting...';
            saveStatus.classList.add('save-status-saving');
            return;
        }

        if (status === 'reconnecting') {
            clearSavedTimeRefresh();
            saveStatus.textContent = 'Reconnecting...';
            saveStatus.classList.add('save-status-saving');
            return;
        }

        if (status === 'offline-readonly') {
            clearSavedTimeRefresh();
            saveStatus.textContent = 'Offline — read only';
            saveStatus.classList.add('save-status-error');
            if (saveRetry) saveRetry.hidden = true;
            return;
        }

        if (status === 'offline-local' || status === 'local-save-failed' || status === 'draft-blocked') {
            clearSavedTimeRefresh();
            saveStatus.textContent = status === 'offline-local'
                ? 'Saved on this device — reconnecting'
                : status === 'local-save-failed'
                    ? 'Local save failed — keep this page open'
                    : 'Previous draft kept on this device';
            saveStatus.classList.add(status === 'offline-local' ? 'save-status-saving' : 'save-status-error');
            if (options.draft && saveRetry) {
                recoveryDraft = options.draft;
                saveRetry.textContent = 'Export draft';
                saveRetry.hidden = false;
            }
            return;
        }

        if (status === 'saved') {
            setLastSavedAt(options.savedAt);
            saveStatus.classList.add('save-status-saved');
            return;
        }

        if (status === 'error') {
            clearSavedTimeRefresh();
            saveStatus.textContent = options.message || 'Save failed';
            saveStatus.classList.add('save-status-error');
            if (saveRetry && options.retry !== false) saveRetry.hidden = false;
        }
    }

    function currentPayload() {
        return {
            title: titleInput.value,
            content: JSON.stringify(getCurrentDocumentSnapshot()),
        };
    }

    function canSave() {
        return !disposed && !collaborationRequired && getCanEdit() && noteId && titleInput && getEditor() && !getNoteCollaborationEnabled();
    }

    async function saveResponseError(response) {
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            // A proxy or expired session may return HTML rather than API JSON.
        }
        const message = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error
            : response.status === 401
                ? 'Sign in again to save this note.'
                : response.status === 403
                    ? 'You no longer have permission to edit this note.'
                    : 'Unable to save this note. Try again.';
        return Object.assign(new Error(message), {
            status: response.status,
            code: payload?.code,
            saveStatusMessage: message,
        });
    }

    async function runRequestedSaves() {
        while (saveRequested && canSave()) {
            saveRequested = false;
            const payload = currentPayload();
            const payloadFingerprint = notePayloadFingerprint(payload.title, payload.content);
            if (payloadFingerprint === lastSavedPayloadFingerprint) {
                noteHasPendingChanges = false;
                if (lastSavedAt) setSaveStatus('saved', { savedAt: lastSavedAt.toISOString() });
                continue;
            }
            noteHasPendingChanges = true;
            setSaveStatus('saving');
            const controller = new AbortController();
            saveController = controller;
            try {
                const request = fetch(`/api/notes/${noteId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                const response = await (window.APStudyPendingMutations?.track(request, 'notes-save') ?? request);
                if (disposed) return;
                if (response.redirected) {
                    throw Object.assign(new Error('Sign in again to save this note.'), {
                        status: 401,
                        saveStatusMessage: 'Sign in again to save this note.',
                    });
                }
                if (!response.ok) throw await saveResponseError(response);

                lastSavedPayloadFingerprint = payloadFingerprint;
                const current = currentPayload();
                noteHasPendingChanges = notePayloadFingerprint(current.title, current.content) !== payloadFingerprint;
                if (!noteHasPendingChanges) {
                    setSaveStatus('saved', { savedAt: new Date().toISOString() });
                }
            } catch (error) {
                if (disposed) return;
                console.error(error);
                if (error.code === 'collaboration_required') {
                    collaborationRequired = true;
                    clearTimers();
                    setSaveStatus('error', {
                        message: 'Live collaboration is now enabled. Copy your unsaved changes, then reload to reconnect.',
                        retry: false,
                    });
                } else {
                    setSaveStatus('error', { message: error.saveStatusMessage });
                }
                saveRequested = false;
            } finally {
                if (saveController === controller) saveController = null;
            }
        }
    }

    function saveNote() {
        if (!canSave()) return Promise.resolve();
        saveRequested = true;
        if (!saveTask) {
            saveTask = runRequestedSaves().finally(() => {
                saveTask = null;
                if (saveRequested && canSave()) return saveNote();
            });
        }
        return saveTask;
    }

    function currentSaveDebounceMs() {
        const blockCount = getTopLevelBlockCount();
        return blockCount >= LARGE_DOCUMENT_BLOCK_COUNT ? SAVE_DEBOUNCE_LARGE_DOC_MS : SAVE_DEBOUNCE_MS;
    }

    function triggerDebouncedSave() {
        if (!canSave()) return;
        noteHasPendingChanges = true;
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
        }

        saveDebounceTimer = window.setTimeout(() => {
            saveDebounceTimer = null;
            void saveNote();
        }, currentSaveDebounceMs());
    }

    function clearTimers() {
        if (saveDebounceTimer) window.clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        clearSavedTimeRefresh();
    }

    function setLastSavedPayloadFingerprint(value) {
        lastSavedPayloadFingerprint = value || '';
    }

    function hasPendingChanges() {
        return noteHasPendingChanges || collaborationHasPendingChanges;
    }

    function setCollaborationPendingChanges(value) {
        if (!disposed) collaborationHasPendingChanges = Boolean(value);
    }

    function exportRecoveryDraft() {
        if (!recoveryDraft) return false;
        const draft = recoveryDraft;
        const payload = {
            title: draft.title, content: draft.content, note_id: draft.noteId,
            document_generation: draft.generation, updated_at: new Date(draft.updatedAt).toISOString(),
            yjs_update: Array.from(draft.update),
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `note-${noteId}-recovered-draft.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    }

    function warnBeforeUnload(event) {
        if (!hasPendingChanges()) return;
        event.preventDefault();
        event.returnValue = '';
    }

    window.addEventListener('beforeunload', warnBeforeUnload);

    function dispose() {
        if (disposed) return;
        disposed = true;
        saveRequested = false;
        clearTimers();
        saveController?.abort();
        window.removeEventListener('beforeunload', warnBeforeUnload);
    }

    return {
        clearTimers,
        dispose,
        exportRecoveryDraft,
        hasPendingChanges,
        setCollaborationPendingChanges,
        notePayloadFingerprint,
        saveNote,
        setLastSavedPayloadFingerprint,
        setSaveStatus,
        triggerDebouncedSave,
    };
}

function parseSavedDate(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeSavedTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds} sec ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes} min ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours} hr ago`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) {
        return `${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
    }

    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    });
}
