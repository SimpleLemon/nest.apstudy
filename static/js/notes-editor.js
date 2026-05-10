import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    useCreateBlockNote,
    FormattingToolbar,
    BlockTypeSelect,
    BasicTextStyleButton,
    TextAlignButton,
    ColorStyleButton,
    NestBlockButton,
    UnnestBlockButton,
    CreateLinkButton,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';

const noteId = window.location.pathname.split('/').pop();
const SAVE_DEBOUNCE_MS = 800;
const LOADER_STYLE_ID = 'apstudy-theme-loader-styles';

let editorInstance = null;
let saveDebounceTimer = null;
let hideSavedTimer = null;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');

function ensureThemeLoaderStyles() {
    if (document.getElementById(LOADER_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = LOADER_STYLE_ID;
    style.textContent = `
        .loader {
            display: inline-block;
            border-radius: 9999px;
            background: linear-gradient(180deg, rgba(99, 102, 241, 0.25), rgba(99, 102, 241, 0.08));
            position: relative;
            overflow: hidden;
        }
        .loader::before,
        .loader::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
        }
        .loader::before {
            border: 2px solid rgba(255, 255, 255, 0.14);
        }
        .loader::after {
            inset: 18%;
            border-radius: 9999px;
            border: 3px solid transparent;
            border-top-color: var(--border-accent, #6366f1);
            animation: apstudyLoaderRotation 0.85s linear infinite;
        }
        @keyframes apstudyLoaderRotation {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}

function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
    ensureThemeLoaderStyles();
    const sizePx = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
    const textToneClass = options.textToneClass || 'text-on-surface-variant';
    return `
        <div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${textToneClass}">
            <span class="loader" style="width:${sizePx}px; height:${sizePx}px;" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
}

function setSaveStatus(status) {
    if (!saveStatus) return;

    if (hideSavedTimer) {
        clearTimeout(hideSavedTimer);
        hideSavedTimer = null;
    }

    saveStatus.classList.remove(
        'save-status-hidden',
        'save-status-saving',
        'save-status-saved',
        'save-status-error'
    );

    if (status === 'saving') {
        saveStatus.textContent = 'Saving...';
        saveStatus.classList.add('save-status-saving');
        return;
    }

    if (status === 'saved') {
        saveStatus.textContent = 'Saved';
        saveStatus.classList.add('save-status-saved');
        hideSavedTimer = window.setTimeout(() => {
            saveStatus.classList.add('save-status-hidden');
        }, 2000);
        return;
    }

    if (status === 'error') {
        saveStatus.textContent = 'Save failed';
        saveStatus.classList.add('save-status-error');
    }
}

async function saveNote() {
    if (!noteId || !titleInput || !editorInstance) return;

    setSaveStatus('saving');

    try {
        const response = await fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        });

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        setSaveStatus('saved');
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}

function triggerDebouncedSave() {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, SAVE_DEBOUNCE_MS);
}

function NoteEditor({ initialContent }) {
    const editor = useCreateBlockNote({ initialContent });

    React.useEffect(() => {
        editorInstance = editor;

        return () => {
            if (editorInstance === editor) {
                editorInstance = null;
            }
        };
    }, [editor]);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            formattingToolbar: false,
            theme: 'dark',
            onChange: () => {
                triggerDebouncedSave();
            },
        },
        React.createElement(
            FormattingToolbar,
            null,
            React.createElement(BlockTypeSelect, null),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'bold' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'italic' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'underline' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'strike' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'code' }),
            React.createElement(TextAlignButton, { textAlignment: 'left' }),
            React.createElement(TextAlignButton, { textAlignment: 'center' }),
            React.createElement(TextAlignButton, { textAlignment: 'right' }),
            React.createElement(ColorStyleButton, null),
            React.createElement(NestBlockButton, null),
            React.createElement(UnnestBlockButton, null),
            React.createElement(CreateLinkButton, null)
        )
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
        const response = await fetch(`/api/notes/${noteId}`, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Failed to fetch note');
        }
        note = await response.json();
    } catch (error) {
        console.error(error);
    }

    const noteTitle = typeof note?.title === 'string' ? note.title : '';
    titleInput.value = noteTitle;

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