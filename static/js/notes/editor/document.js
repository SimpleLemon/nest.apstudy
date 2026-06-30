import {
    BlockNoteView,
    React,
    SAVE_DEBOUNCE_MS,
    blocknoteRoot,
    clipboardTextLooksStructured,
    editorState,
    normalizeImportedMarkdownBlocks,
    notesEditorSchema,
    titleInput,
    useCreateBlockNote,
    useEditorContentOrSelectionChange,
    writingToolbar,
} from './runtime.js';
import {
    saveNote,
    setSaveStatus,
} from './save.js';
import {
    captureHistoryBaseline,
    updateEditorChrome,
} from './editing.js';

export function renderMissingNoteState(message = 'This note could not be opened.') {
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

export function triggerDebouncedSave() {
    editorState.noteHasPendingChanges = true;
    if (editorState.saveDebounceTimer) {
        clearTimeout(editorState.saveDebounceTimer);
    }

    editorState.saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, SAVE_DEBOUNCE_MS);
}

export function clipboardTextHasMarkdownSyntax(text) {
    if (typeof text !== 'string') return false;
    return text.split(/\r?\n/).some((line) => (
        /^#{1,6}\s+\S/.test(line)
        || /^>\s+\S/.test(line)
        || /^[-*+]\s+\S/.test(line)
        || /^\d+[.)]\s+\S/.test(line)
        || /^-{3,}\s*$/.test(line)
    ));
}

export function normalizeEditorDocument({ save = true } = {}) {
    if (!editorState.editorInstance || editorState.normalizingEditorDocument) return false;

    const result = normalizeImportedMarkdownBlocks(editorState.editorInstance.document);
    if (!result.changed) return false;

    editorState.normalizingEditorDocument = true;
    try {
        editorState.editorInstance.replaceBlocks(editorState.editorInstance.document, result.blocks);
    } finally {
        editorState.normalizingEditorDocument = false;
    }

    updateEditorChrome();
    if (save) triggerDebouncedSave();
    return true;
}

export function schedulePastedContentNormalization() {
    window.setTimeout(() => {
        normalizeEditorDocument();
    }, 0);
}

export function handleNotesPaste({ event, editor, defaultPasteHandler }) {
    const plainText = event.clipboardData?.getData('text/plain') || '';
    if (clipboardTextHasMarkdownSyntax(plainText)) {
        editor.pasteMarkdown?.(plainText);
        schedulePastedContentNormalization();
        return true;
    }

    const handled = defaultPasteHandler({
        prioritizeMarkdownOverHTML: true,
        plainTextAsMarkdown: true,
    });

    if (clipboardTextLooksStructured(plainText)) {
        schedulePastedContentNormalization();
    }

    return handled;
}

export function NoteEditor({ initialContent, initialContentWasNormalized = false }) {
    const editor = useCreateBlockNote({
        initialContent,
        schema: notesEditorSchema,
        pasteHandler: handleNotesPaste,
        placeholders: {
            default: undefined,
            emptyDocument: "Enter text or type '/' for commands",
        },
    });

    React.useEffect(() => {
        editorState.editorInstance = editor;
        window.setTimeout(() => {
            if (editorState.editorInstance !== editor) return;
            captureHistoryBaseline();
            updateEditorChrome();
            if (initialContentWasNormalized) {
                triggerDebouncedSave();
            }
        }, 0);

        return () => {
            if (editorState.editorInstance === editor) {
                editorState.editorInstance = null;
            }
        };
    }, [editor]);

    useEditorContentOrSelectionChange(() => {
        updateEditorChrome();
    }, editor);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            formattingToolbar: false,
            linkToolbar: false,
            sideMenu: false,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            onChange: () => {
                if (editorState.normalizingEditorDocument) {
                    updateEditorChrome();
                    return;
                }
                if (normalizeEditorDocument()) return;
                updateEditorChrome();
                triggerDebouncedSave();
            },
        }
    );
}
