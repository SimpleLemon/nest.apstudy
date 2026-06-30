import {
    React,
    blocknoteRoot,
    buildLoadingIndicatorHtml,
    createRoot,
    documentHasText,
    editorState,
    isBlankTitle,
    normalizeImportedMarkdownBlocks,
    noteId,
    saveRetry,
    titleInput,
} from './editor/runtime.js';
import {
    applyEditorZoom,
    applyPageSetupVariables,
    loadStoredZoomIndex,
    normalizePageSetup,
    updatePageSetupControls,
} from './editor/page-setup.js';
import {
    saveNote,
    setSaveStatus,
} from './editor/save.js';
import {
    focusEditorBody,
    updateEditorChrome,
} from './editor/editing.js';
import {
    bindWritingToolbar,
} from './editor/toolbar-bindings.js';
import {
    NoteEditor,
    renderMissingNoteState,
    triggerDebouncedSave,
} from './editor/document.js';

window.addEventListener('beforeunload', (event) => {
    if (!editorState.noteHasPendingChanges) return;
    event.preventDefault();
    event.returnValue = '';
});

export async function initEditorPage() {
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
    editorState.notePageSetup = normalizePageSetup(note?.page_setup);
    editorState.globalPageSetup = normalizePageSetup(note?.global_page_setup);
    applyPageSetupVariables();
    updatePageSetupControls();
    if (note?.updated_at) {
        setSaveStatus('saved', { savedAt: note.updated_at });
    }

    let parsedContent = undefined;
    let parsedContentWasNormalized = false;
    if (typeof note?.content === 'string' && note.content.trim() !== '') {
        try {
            parsedContent = JSON.parse(note.content);
        } catch (error) {
            parsedContent = undefined;
        }
    }

    if (Array.isArray(parsedContent)) {
        const normalized = normalizeImportedMarkdownBlocks(parsedContent);
        parsedContent = normalized.blocks;
        parsedContentWasNormalized = normalized.changed;
    }

    const root = createRoot(rootElement);

    try {
        root.render(React.createElement(NoteEditor, {
            initialContent: parsedContent,
            initialContentWasNormalized: parsedContentWasNormalized,
        }));
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

editorState.zoomIndex = loadStoredZoomIndex();

applyEditorZoom();

initEditorPage();
