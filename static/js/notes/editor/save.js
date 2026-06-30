import {
    SAVED_TIME_REFRESH_MS,
    editorState,
    formatRelativeSavedTime,
    noteId,
    parseSavedDate,
    saveRetry,
    saveStatus,
    titleInput,
} from './runtime.js';

export function clearSavedTimeRefresh() {
    if (editorState.savedTimeRefreshTimer) {
        clearInterval(editorState.savedTimeRefreshTimer);
        editorState.savedTimeRefreshTimer = null;
    }
}

export function renderSavedTime() {
    if (!saveStatus || !editorState.lastSavedAt) return;
    saveStatus.textContent = `Saved ${formatRelativeSavedTime(editorState.lastSavedAt)}`;
}

export function setLastSavedAt(value) {
    editorState.lastSavedAt = parseSavedDate(value) || new Date();
    renderSavedTime();
    clearSavedTimeRefresh();
    editorState.savedTimeRefreshTimer = window.setInterval(renderSavedTime, SAVED_TIME_REFRESH_MS);
}

export function setSaveStatus(status, options = {}) {
    if (!saveStatus) return;
    if (saveRetry) saveRetry.hidden = true;

    saveStatus.classList.remove(
        'save-status-hidden',
        'save-status-saving',
        'save-status-saved',
        'save-status-error'
    );

    if (status === 'saving') {
        clearSavedTimeRefresh();
        saveStatus.textContent = 'Saving...';
        saveStatus.classList.add('save-status-saving');
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

export async function saveNote() {
    if (!noteId || !titleInput || !editorState.editorInstance) return;

    setSaveStatus('saving');

    try {
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorState.editorInstance.document),
            }),
        }), 'notes-save') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorState.editorInstance.document),
            }),
        }));

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        const updatedNote = await response.json();
        editorState.noteHasPendingChanges = false;
        setSaveStatus('saved', { savedAt: updatedNote?.updated_at });
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}
