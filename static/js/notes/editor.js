import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    useCreateBlockNote,
    FormattingToolbarController,
    SideMenuController,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import {
    CleanSideMenu,
    ContextualNotesToolbar,
    applyToolbarTooltips,
    notesEditorSchema,
} from './toolbar.js';

const noteId = window.location.pathname.split('/').pop();
const SAVE_DEBOUNCE_MS = 800;
const SAVED_TIME_REFRESH_MS = 60000;

let editorInstance = null;
let saveDebounceTimer = null;
let savedTimeRefreshTimer = null;
let lastSavedAt = null;
let noteHasPendingChanges = false;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');

function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
    return window.APStudyLoader.html(label, options);
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
    if (!saveStatus) return;

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
        saveStatus.textContent = 'Save failed';
        saveStatus.classList.add('save-status-error');
    }
}

async function saveNote() {
    if (!noteId || !titleInput || !editorInstance) return;

    setSaveStatus('saving');

    try {
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        }), 'notes-save') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        }));

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        const updatedNote = await response.json();
        noteHasPendingChanges = false;
        setSaveStatus('saved', { savedAt: updatedNote?.updated_at });
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}

function triggerDebouncedSave() {
    noteHasPendingChanges = true;
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, SAVE_DEBOUNCE_MS);
}

window.addEventListener('beforeunload', (event) => {
    if (!noteHasPendingChanges) return;
    event.preventDefault();
    event.returnValue = '';
});

function NoteEditor({ initialContent }) {
    const editor = useCreateBlockNote({
        initialContent,
        schema: notesEditorSchema,
        placeholders: {
            default: undefined,
            emptyDocument: "Enter text or type '/' for commands",
        },
    });

    React.useEffect(() => {
        editorInstance = editor;

        return () => {
            if (editorInstance === editor) {
                editorInstance = null;
            }
        };
    }, [editor]);

    React.useEffect(() => {
        const rootElement = document.getElementById('blocknote-root');
        if (!rootElement) return undefined;

        applyToolbarTooltips(rootElement);
        const observer = new MutationObserver(() => {
            applyToolbarTooltips(rootElement);
        });
        observer.observe(rootElement, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, []);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            formattingToolbar: false,
            sideMenu: false,
            theme: 'dark',
            onChange: () => {
                triggerDebouncedSave();
            },
        },
        React.createElement(FormattingToolbarController, {
            formattingToolbar: ContextualNotesToolbar,
        }),
        React.createElement(SideMenuController, { sideMenu: CleanSideMenu })
    );
}

async function initEditorPage() {
    if (!noteId || !titleInput) return;

    const rootElement = document.getElementById('blocknote-root');
    if (!rootElement) return;

    rootElement.innerHTML = `
        <div class="rounded-2xl border border-outline-variant/20 bg-surface-container p-10 text-center min-h-[320px] flex items-center justify-center">
            ${buildLoadingIndicatorHtml('Loading note...', { sizePx: 54, textToneClass: 'text-on-surface' })}
        </div>
    `;

    let note = null;

    try {
        const response = await fetch(`/api/notes/${noteId}`);
        if (!response.ok) {
            throw new Error('Failed to fetch note');
        }
        note = await response.json();
    } catch (error) {
        console.error(error);
    }

    const noteTitle = typeof note?.title === 'string' ? note.title : '';
    titleInput.value = noteTitle;
    if (note?.updated_at) {
        setSaveStatus('saved', { savedAt: note.updated_at });
    }

    let parsedContent = undefined;
    if (typeof note?.content === 'string' && note.content.trim() !== '') {
        try {
            parsedContent = JSON.parse(note.content);
        } catch (error) {
            parsedContent = undefined;
        }
    }

    const root = createRoot(rootElement);

    try {
        root.render(React.createElement(NoteEditor, { initialContent: parsedContent }));
    } catch (error) {
        console.error('Failed to mount note editor', error);
        setSaveStatus('error');
    }

    titleInput.addEventListener('input', () => {
        triggerDebouncedSave();
    });
}

initEditorPage();
