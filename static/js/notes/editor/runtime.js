import * as React from 'react';

import { createRoot } from 'react-dom/client';

import { useCreateBlockNote, useEditorContentOrSelectionChange } from '@blocknote/react';

import { checkBlockHasDefaultProp, checkBlockTypeHasDefaultProp, mapTableCell } from '@blocknote/core';

import { BlockNoteView } from '@blocknote/mantine';

import { notesEditorSchema } from '../toolbar.js';

import { clipboardTextLooksStructured, normalizeImportedMarkdownBlocks } from './markdown-repair.js';

import { blockOwnContentIsEmpty, buildLoadingIndicatorHtml, documentHasText, formatRelativeSavedTime, isBlankTitle, noteIdFromPath, parseSavedDate } from './utils.js';

export const noteId = noteIdFromPath();

export const SAVE_DEBOUNCE_MS = 800;

export const SAVED_TIME_REFRESH_MS = 60000;

export const ZOOM_STORAGE_KEY = 'apstudy.notes.editor.zoom';

export const ZOOM_LEVELS = [0.85, 1, 1.15, 1.3, 1.5];

export const DEFAULT_ZOOM_INDEX = 1;

export const PAGE_SETUP_SAVE_DEBOUNCE_MS = 500;

export const PAGE_SETUP_DEFAULTS = {
    pageColor: 'default',
    fontType: 'default',
};

export const PAGE_SETUP_COLORS = {
    default: 'var(--notes-bg-surface)',
    paper: '#f8f1df',
    warm: '#f6eadf',
    blue: '#eaf2fb',
    green: '#eaf5ed',
    rose: '#f8e9ef',
    dark: '#141922',
};

export const PAGE_SETUP_FONT_TYPES = {
    default: 'var(--font-body)',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    display: 'var(--font-display)',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'var(--font-mono)',
};

export const PAGE_SETUP_MARGIN_MIN = 2;

export const PAGE_SETUP_MARGIN_MAX = 18;

export const VISUAL_INDENT_BLOCKS = new Set(['paragraph', 'heading']);

export const LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

export const MAX_INDENT_LEVEL = 4;

export const TEXT_BLOCK_OPTIONS = [
    { label: 'Paragraph', type: 'paragraph', icon: 'subject', key: 'paragraph' },
    { label: 'Heading 1', type: 'heading', props: { level: 1 }, icon: 'H1', key: 'heading-1' },
    { label: 'Heading 2', type: 'heading', props: { level: 2 }, icon: 'H2', key: 'heading-2' },
    { label: 'Heading 3', type: 'heading', props: { level: 3 }, icon: 'H3', key: 'heading-3' },
    { label: 'Quote', type: 'quote', icon: 'format_quote', key: 'quote' },
];

export const LIST_STYLE_OPTIONS = [
    { label: 'Bulleted list', type: 'bulletListItem', icon: 'format_list_bulleted', key: 'bulletListItem' },
    { label: 'Numbered list', type: 'numberedListItem', icon: 'format_list_numbered', key: 'numberedListItem' },
    { label: 'Checklist', type: 'checkListItem', icon: 'checklist', key: 'checkListItem' },
];

export const ALIGNMENT_OPTIONS = [
    { label: 'Align left', value: 'left', icon: 'format_align_left', key: 'align-left' },
    { label: 'Align center', value: 'center', icon: 'format_align_center', key: 'align-center' },
    { label: 'Align right', value: 'right', icon: 'format_align_right', key: 'align-right' },
    { label: 'Justify', value: 'justify', icon: 'format_align_justify', key: 'align-justify' },
];

export const editorState = {
    editorInstance: null,
    saveDebounceTimer: null,
    savedTimeRefreshTimer: null,
    lastSavedAt: null,
    noteHasPendingChanges: false,
    historyBaselineDepths: { undo: 0, redo: 0 },
    zoomIndex: DEFAULT_ZOOM_INDEX,
    activeToolbarMenu: null,
    toolbarOverflowController: null,
    notePageSetup: {},
    globalPageSetup: {},
    pageSetupScope: 'note',
    pageSetupSaveTimer: null,
    addBlockActiveIndex: 0,
    defaultSideMarginPercent: null,
    normalizingEditorDocument: false,
};

export const titleInput = document.getElementById('note-title-input');

export const saveStatus = document.getElementById('save-status');

export const saveRetry = document.getElementById('save-retry');

export const blocknoteRoot = document.getElementById('blocknote-root');

export const writingToolbar = document.getElementById('notes-writing-toolbar');

export const editorHint = document.getElementById('notes-editor-hint');

export const editorPage = document.getElementById('editor-page');

export const zoomValue = document.getElementById('notes-zoom-value');

export const pageSetupPopover = document.getElementById('notes-page-setup-popover');

export const pageSetupScopeInput = document.querySelector('[data-page-setup-scope]');

export const sideMarginsValue = document.getElementById('notes-side-margins-value');

export {
    React,
    createRoot,
    useCreateBlockNote,
    useEditorContentOrSelectionChange,
    checkBlockHasDefaultProp,
    checkBlockTypeHasDefaultProp,
    mapTableCell,
    BlockNoteView,
    notesEditorSchema,
    clipboardTextLooksStructured,
    normalizeImportedMarkdownBlocks,
    blockOwnContentIsEmpty,
    buildLoadingIndicatorHtml,
    documentHasText,
    formatRelativeSavedTime,
    isBlankTitle,
    noteIdFromPath,
    parseSavedDate,
};
