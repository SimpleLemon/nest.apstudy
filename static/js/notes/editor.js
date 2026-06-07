import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { useCreateBlockNote, FormattingToolbarController, useEditorContentOrSelectionChange } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { ContextualNotesToolbar, applyToolbarTooltips, notesEditorSchema } from './toolbar.js';
import { blockOwnContentIsEmpty, buildLoadingIndicatorHtml, documentHasText, formatRelativeSavedTime, isBlankTitle, noteIdFromPath, parseSavedDate } from './editor/utils.js';

const noteId = noteIdFromPath();
const SAVE_DEBOUNCE_MS = 800;
const SAVED_TIME_REFRESH_MS = 60000;

let editorInstance = null;
let saveDebounceTimer = null;
let savedTimeRefreshTimer = null;
let lastSavedAt = null;
let noteHasPendingChanges = false;
let historyBaselineDepths = { undo: 0, redo: 0 };

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');
const saveRetry = document.getElementById('save-retry');
const blocknoteRoot = document.getElementById('blocknote-root');
const writingToolbar = document.getElementById('notes-writing-toolbar');
const editorHint = document.getElementById('notes-editor-hint');

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

function focusEditorBody() {
    if (!editorInstance) return;
    editorInstance.focus?.();
}

function getCurrentBlock() {
    if (!editorInstance) return null;
    return editorInstance.getTextCursorPosition?.()?.block || selectedBlocks()[0] || null;
}

function openBlockSuggestionMenu(block) {
    if (!editorInstance || !block) return;
    editorInstance.setTextCursorPosition?.(block);
    editorInstance.openSuggestionMenu?.('/');
    focusEditorBody();
}

function addBlockAfterCurrent() {
    if (!editorInstance) return;

    const currentBlock = getCurrentBlock();
    if (!currentBlock) {
        focusEditorBody();
        return;
    }

    if (blockOwnContentIsEmpty(currentBlock)) {
        openBlockSuggestionMenu(currentBlock);
        return;
    }

    const insertedBlock = editorInstance.insertBlocks?.(
        [{ type: 'paragraph' }],
        currentBlock,
        'after'
    )?.[0];

    openBlockSuggestionMenu(insertedBlock || currentBlock);
    updateEditorChrome();
    triggerDebouncedSave();
}

function selectedBlocks() {
    if (!editorInstance) return [];
    return editorInstance.getSelection?.()?.blocks || [editorInstance.getTextCursorPosition?.()?.block].filter(Boolean);
}

function setSelectedBlocks(type, props = undefined) {
    if (!editorInstance) return;
    selectedBlocks().forEach((block) => {
        if (!block) return;
        editorInstance.updateBlock(block, {
            type,
            props,
        });
    });
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

function toggleBasicStyle(style) {
    if (!editorInstance) return;
    if (typeof editorInstance.toggleStyles === 'function') {
        editorInstance.toggleStyles({ [style]: true });
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
        return;
    }
    focusEditorBody();
}

function canRunHistoryAction(action) {
    if (!editorInstance) return false;

    const depth = historyDepth(action);
    if (typeof depth === 'number') {
        return depth > (historyBaselineDepths[action] || 0);
    }

    const commandCan = editorInstance._tiptapEditor?.can?.();
    const canAction = commandCan?.[action];
    if (typeof canAction !== 'function') return false;

    try {
        return Boolean(canAction.call(commandCan));
    } catch (error) {
        return false;
    }
}

function runHistoryAction(action) {
    if (!editorInstance || !canRunHistoryAction(action)) return;

    if (typeof editorInstance[action] === 'function') {
        editorInstance[action]();
    } else {
        editorInstance._tiptapEditor?.commands?.[action]?.();
    }

    focusEditorBody();
    updateEditorChrome();
}

function historyDepth(action) {
    const state = editorInstance?._tiptapEditor?.state;
    if (!state?.plugins) return null;

    const historyPlugin = state.plugins.find((plugin) => String(plugin.key || '').startsWith('history$'));
    const historyState = historyPlugin?.getState?.(state);
    const branch = action === 'redo' ? historyState?.undone : historyState?.done;
    return typeof branch?.eventCount === 'number' ? branch.eventCount : null;
}

function captureHistoryBaseline() {
    historyBaselineDepths = {
        undo: historyDepth('undo') || 0,
        redo: historyDepth('redo') || 0,
    };
}

function updateToolbarState() {
    if (!writingToolbar || !editorInstance) return;
    const block = selectedBlocks()[0];
    const activeStyles = typeof editorInstance.getActiveStyles === 'function'
        ? editorInstance.getActiveStyles()
        : {};

    writingToolbar.querySelectorAll('button[data-editor-action]').forEach((button) => {
        const action = button.dataset.editorAction;
        let active = false;
        let disabled = false;
        if (action === 'paragraph') {
            active = block?.type === 'paragraph';
        } else if (action === 'heading') {
            active = block?.type === 'heading' && Number(block?.props?.level) === Number(button.dataset.level);
        } else if (['bulletListItem', 'numberedListItem', 'checkListItem'].includes(action)) {
            active = block?.type === action;
        } else if (action === 'basic-style') {
            active = Boolean(activeStyles?.[button.dataset.style]);
        } else if (action === 'undo' || action === 'redo') {
            disabled = !canRunHistoryAction(action);
        }
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
    });
}

function updateEditorHint() {
    if (!editorHint || !editorInstance) return;
    editorHint.hidden = documentHasText(editorInstance.document);
}

function updateEditorChrome() {
    updateToolbarState();
    updateEditorHint();
}

function bindWritingToolbar() {
    if (!writingToolbar) return;
    writingToolbar.hidden = false;
    writingToolbar.querySelectorAll('button[data-editor-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.dataset.editorAction;
            if (action === 'focus-body') {
                focusEditorBody();
                return;
            }
            if (action === 'add-block') {
                addBlockAfterCurrent();
                return;
            }
            if (action === 'undo' || action === 'redo') {
                runHistoryAction(action);
                return;
            }
            if (action === 'basic-style') {
                toggleBasicStyle(button.dataset.style);
                return;
            }
            if (action === 'heading') {
                setSelectedBlocks('heading', { level: Number(button.dataset.level) || 1 });
                return;
            }
            setSelectedBlocks(action);
        });
    });
    writingToolbar.addEventListener('toggle', (event) => {
        if (event.target.matches('.notes-toolbar-more[open]')) {
            writingToolbar.querySelectorAll('.notes-toolbar-more[open]').forEach((details) => {
                if (details !== event.target) details.open = false;
            });
        }
    }, true);
}

function renderMissingNoteState(message = 'This note could not be opened.') {
    if (titleInput) {
        titleInput.value = '';
        titleInput.disabled = true;
    }
    if (writingToolbar) writingToolbar.hidden = true;
    if (blocknoteRoot) {
        blocknoteRoot.innerHTML = `
            <div class="notes-editor-empty-state">
                <span class="material-symbols-outlined" aria-hidden="true">description</span>
                <h2>Note unavailable</h2>
                <p>${message}</p>
                <a href="/notes" class="btn-primary">Back to notes</a>
            </div>
        `;
    }
    setSaveStatus('error', { message: 'Unable to load', retry: false });
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
        window.setTimeout(() => {
            if (editorInstance !== editor) return;
            captureHistoryBaseline();
            updateEditorChrome();
        }, 0);

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

    useEditorContentOrSelectionChange(() => {
        updateEditorChrome();
    }, editor);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            formattingToolbar: false,
            sideMenu: false,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            onChange: () => {
                updateEditorChrome();
                triggerDebouncedSave();
            },
        },
        React.createElement(FormattingToolbarController, {
            formattingToolbar: ContextualNotesToolbar,
        })
    );
}

async function initEditorPage() {
    if (!noteId || !titleInput) {
        renderMissingNoteState('Open or create a note from the Notes page first.');
        return;
    }

    const rootElement = blocknoteRoot;
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
        renderMissingNoteState('The note may have been deleted or is unavailable.');
        return;
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
        bindWritingToolbar();
    } catch (error) {
        console.error('Failed to mount note editor', error);
        setSaveStatus('error');
    }

    titleInput.addEventListener('input', () => {
        triggerDebouncedSave();
    });
    titleInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        focusEditorBody();
    });
    rootElement.addEventListener('click', () => {
        focusEditorBody();
    });
    window.setTimeout(() => {
        const isNewBlankNote = isBlankTitle(noteTitle) && !documentHasText(parsedContent);
        updateEditorChrome();
        if (!isNewBlankNote) return;
        titleInput.focus({ preventScroll: true });
        titleInput.select();
    }, 0);
}

saveRetry?.addEventListener('click', () => {
    void saveNote();
});

initEditorPage();
