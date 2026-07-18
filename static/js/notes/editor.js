import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    SideMenuController,
    SuggestionMenuController,
    useCreateBlockNote,
    useEditorContentOrSelectionChange,
} from '@blocknote/react';
import { checkBlockHasDefaultProp, checkBlockTypeHasDefaultProp, mapTableCell } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { History } from '@tiptap/extension-history';
import { notesEditorSchema } from './toolbar.js';
import {
    BLOCK_CATALOG,
    FONT_SIZE_PRESETS,
    FORMAT_COLORS,
    blockIconClass,
    blockPayloadForCatalogItem,
    catalogItemByKey,
    catalogItemByType,
    filterBlockCatalog,
} from './editor/block-catalog.js';
import { hiddenBlocksForCollapsedHeadings } from './editor/heading-collapse.js';
import { listItemHardBreakShortcuts, preserveRangeSelectionShortcuts, createSelectAllShortcuts } from './editor/keyboard-shortcuts.js';
import { clipboardTextLooksStructured, normalizeClipboardMarkdown, normalizeClipboardText, normalizeCopiedPlainText, normalizeImportedMarkdownBlocks } from './editor/markdown-repair.js';
import { removeBlocksAndRestoreCursor } from './editor/block-operations.js';
import { blockOwnContentIsEmpty, buildLoadingIndicatorHtml, claimElementBinding, documentHasText, floatingPopoverPosition, formatRelativeSavedTime, handlePageSetupToolbarClick, isBlankTitle, noteIdFromPath, parseSavedDate } from './editor/utils.js';
import {
    clipboardHtmlImageSources,
    clipboardImageFiles,
    dataImageFile,
} from './editor/images.js';
import { bindImageRuntime, insertInlineImageFile, insertInlineImageNode, requestImageSource } from './editor/image-runtime.js';

const noteContext = window.APSTUDY_NOTE_CONTEXT || {};
const noteId = noteContext.noteId || noteIdFromPath();
let canEdit = noteContext.access?.can_edit === true;
const SAVE_DEBOUNCE_MS = 800;
const SAVE_DEBOUNCE_LARGE_DOC_MS = 1500;
const LARGE_DOCUMENT_BLOCK_COUNT = 120;
const NORMAL_HISTORY_DEPTH = 100;
const LONG_DOCUMENT_HISTORY_DEPTH = 35;
const GRAMMARLY_DISABLED_ATTRS = 'data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" spellcheck="false"';

const EDITOR_CHROME_THROTTLE_MS = 120;
const SAVED_TIME_REFRESH_MS = 60000;
const ZOOM_STORAGE_KEY = 'apstudy.notes.editor.zoom';
const ZOOM_LEVELS = [0.85, 1, 1.15, 1.3, 1.5];
const DEFAULT_ZOOM_INDEX = 1;
const PAGE_SETUP_SAVE_DEBOUNCE_MS = 500;
const PAGE_SETUP_DEFAULTS = {
    pageColor: 'default',
    fontType: 'default',
};
const PAGE_SETUP_COLORS = {
    default: 'var(--notes-bg-surface)',
    paper: '#f8f1df',
    warm: '#f6eadf',
    blue: '#eaf2fb',
    green: '#eaf5ed',
    rose: '#f8e9ef',
    dark: '#141922',
};
const PAGE_SETUP_FONT_TYPES = {
    default: 'var(--font-body)',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    display: 'var(--font-display)',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'var(--font-mono)',
};
const PAGE_SETUP_MARGIN_MIN = 2;
const PAGE_SETUP_MARGIN_MAX = 18;
const VISUAL_INDENT_BLOCKS = new Set(['paragraph', 'heading']);
const LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);
const ATOM_BLOCK_TYPES = new Set(['divider', 'bookmark', 'image', 'video', 'audio', 'file']);
const MAX_INDENT_LEVEL = 4;
const TEXT_BLOCK_OPTIONS = [
    { label: 'Paragraph', type: 'paragraph', icon: 'subject', key: 'paragraph' },
    { label: 'Heading 1', type: 'heading', props: { level: 1 }, icon: 'H1', key: 'heading-1' },
    { label: 'Heading 2', type: 'heading', props: { level: 2 }, icon: 'H2', key: 'heading-2' },
    { label: 'Heading 3', type: 'heading', props: { level: 3 }, icon: 'H3', key: 'heading-3' },
    { label: 'Quote', type: 'quote', icon: 'format_quote', key: 'quote' },
    { label: 'Code block', type: 'codeBlock', icon: 'code_blocks', key: 'codeBlock' },
    { label: 'Callout', type: 'callout', icon: 'lightbulb', key: 'callout' },
];
const LIST_STYLE_OPTIONS = [
    { label: 'Bulleted list', type: 'bulletListItem', icon: 'format_list_bulleted', key: 'bulletListItem' },
    { label: 'Numbered list', type: 'numberedListItem', icon: 'format_list_numbered', key: 'numberedListItem' },
    { label: 'Checklist', type: 'checkListItem', icon: 'checklist', key: 'checkListItem' },
];
const ALIGNMENT_OPTIONS = [
    { label: 'Align left', value: 'left', icon: 'format_align_left', key: 'align-left' },
    { label: 'Align center', value: 'center', icon: 'format_align_center', key: 'align-center' },
    { label: 'Align right', value: 'right', icon: 'format_align_right', key: 'align-right' },
    { label: 'Justify', value: 'justify', icon: 'format_align_justify', key: 'align-justify' },
];
let editorInstance = null;
let saveDebounceTimer = null;
let savedTimeRefreshTimer = null;
let lastSavedAt = null;
let noteHasPendingChanges = false;
let historyBaselineDepths = { undo: 0, redo: 0 };
let zoomIndex = DEFAULT_ZOOM_INDEX;
let activeToolbarMenu = null;
let toolbarOverflowController = null;
let notePageSetup = {};
let globalPageSetup = {};
let pageSetupScope = 'note';
let activePageSetupTrigger = null;
let activePageSetupTriggerRect = null;
let pageSetupSaveTimer = null;
let pageSetupPositionRafId = null;
let addBlockActiveIndex = 0;
let defaultSideMarginPercent = null;
let selectedBlockAnchorId = null;
let urlBlockPopover = null;
let urlBlockResolve = null;
let editorChromeThrottleTimer = null;
let editorChromeRafId = null;
let editorChromeSyncNeedsStructure = false;
let editorChromeSyncSnapshot = null;
let lastSelectedBlockIds = new Set();
let lastHeadingCollapseSignature = '';
let latestDocumentSnapshot = null;
let lastSavedPayloadFingerprint = '';
let notePrintReady = false;
let notePrintInProgress = false;
let noteEditorReactRoot = null;
let editorLoadController = null;
let editorReadyTimer = null;
let editorInitialFocusTimer = null;
let editorPageDisposed = false;
let activeCollaborationSession = null;
let noteCollaborationEnabled = false;
let activeCollaborativeTitleCleanup = null;
let reviewPanelController = null;
let reviewPanelModulePromise = null;
let reviewPanelBootstrapCleanup = null;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');
const saveRetry = document.getElementById('save-retry');
const blocknoteRoot = document.getElementById('blocknote-root');
const writingToolbar = document.getElementById('notes-writing-toolbar');
const editorHint = document.getElementById('notes-editor-hint');
const editorPage = document.getElementById('editor-page');
const zoomValue = document.getElementById('notes-zoom-value');
const pageSetupPopover = document.getElementById('notes-page-setup-popover');
const shareButton = document.getElementById('notes-share-button');
const collaboratorsRoot = document.getElementById('notes-active-collaborators');
const reviewPanel = document.getElementById('notes-review-panel');
const reviewButton = document.getElementById('notes-review-button');
const historyButton = document.getElementById('notes-history-button');
const pageSetupScopeInput = document.querySelector('[data-page-setup-scope]');
const sideMarginsValue = document.getElementById('notes-side-margins-value');
const notePrintButtons = Array.from(document.querySelectorAll('[data-note-print]'));

function setEditorReadOnlyMode(readOnly) {
    canEdit = !readOnly && noteContext.access?.can_edit === true;
    document.body.dataset.noteReadOnly = readOnly ? 'true' : 'false';
    if (titleInput) {
        titleInput.readOnly = readOnly;
        titleInput.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
    }
}

function bindCollaborativeTitle(session, fallbackTitle) {
    if (!session || !titleInput) return null;
    const yTitle = session.document.getText('title');
    let applyingRemoteTitle = false;
    const applyRemoteTitle = () => {
        const nextTitle = yTitle.toString();
        if (titleInput.value === nextTitle) return;
        applyingRemoteTitle = true;
        titleInput.value = nextTitle;
        applyingRemoteTitle = false;
    };
    const maybeInitializeTitle = () => {
        if (yTitle.length === 0 && fallbackTitle) {
            yTitle.insert(0, fallbackTitle);
        }
        applyRemoteTitle();
    };
    const handleTitleInput = () => {
        if (applyingRemoteTitle || !canEdit) return;
        yTitle.delete(0, yTitle.length);
        yTitle.insert(0, titleInput.value);
    };
    yTitle.observe(applyRemoteTitle);
    session.provider.on?.('synced', ({ state }) => {
        if (state) maybeInitializeTitle();
    });
    titleInput.addEventListener('input', handleTitleInput);
    maybeInitializeTitle();
    return () => {
        yTitle.unobserve(applyRemoteTitle);
        titleInput.removeEventListener('input', handleTitleInput);
    };
}

function clampZoomIndex(index) {
    return Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
}

function loadStoredZoomIndex() {
    try {
        const stored = Number(window.localStorage?.getItem(ZOOM_STORAGE_KEY));
        const index = ZOOM_LEVELS.findIndex((level) => Math.round(level * 100) === stored);
        return index >= 0 ? index : DEFAULT_ZOOM_INDEX;
    } catch (error) {
        return DEFAULT_ZOOM_INDEX;
    }
}

function storeZoomLevel(level) {
    try {
        window.localStorage?.setItem(ZOOM_STORAGE_KEY, String(Math.round(level * 100)));
    } catch (error) {
        // localStorage can be unavailable in private or restricted contexts.
    }
}

function clampSideMargins(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultSideMargins();
    return Math.min(PAGE_SETUP_MARGIN_MAX, Math.max(PAGE_SETUP_MARGIN_MIN, Math.round(numeric)));
}

function defaultSideMargins() {
    if (defaultSideMarginPercent !== null) return defaultSideMarginPercent;
    if (!editorPage) return 10;
    const rawValue = getComputedStyle(editorPage).getPropertyValue('--notes-page-side-margin').trim();
    const parsed = Number.parseFloat(rawValue);
    defaultSideMarginPercent = Number.isFinite(parsed) ? Math.round(parsed) : 10;
    return defaultSideMarginPercent;
}

function normalizePageSetup(value) {
    if (!value || typeof value !== 'object') return {};
    const normalized = {};
    if (Object.prototype.hasOwnProperty.call(PAGE_SETUP_COLORS, value.pageColor)) {
        normalized.pageColor = value.pageColor;
    }
    if (Object.prototype.hasOwnProperty.call(PAGE_SETUP_FONT_TYPES, value.fontType)) {
        normalized.fontType = value.fontType;
    }
    if (value.sideMargins !== undefined) {
        normalized.sideMargins = clampSideMargins(value.sideMargins);
    }
    return normalized;
}

function effectivePageSetup() {
    return normalizePageSetup({
        ...PAGE_SETUP_DEFAULTS,
        ...globalPageSetup,
        ...notePageSetup,
    });
}

function setupForCurrentScope() {
    return pageSetupScope === 'global'
        ? normalizePageSetup({ ...PAGE_SETUP_DEFAULTS, ...globalPageSetup })
        : effectivePageSetup();
}

function applyPageSetupVariables() {
    const setup = effectivePageSetup();
    const zoom = ZOOM_LEVELS[zoomIndex] || ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
    const zoomReduction = Math.max(0, Math.round((zoom - 1) * 12));
    const marginPercent = Math.max(PAGE_SETUP_MARGIN_MIN, clampSideMargins(setup.sideMargins) - zoomReduction);
    const paddingMax = zoom > 1 ? Math.max(30, Math.round(96 - (zoom - 1) * 96)) : 96;

    editorPage?.style.setProperty('--notes-page-setup-bg', PAGE_SETUP_COLORS[setup.pageColor] || PAGE_SETUP_COLORS.default);
    editorPage?.style.setProperty('--notes-page-font-family', PAGE_SETUP_FONT_TYPES[setup.fontType] || PAGE_SETUP_FONT_TYPES.default);
    editorPage?.style.setProperty('--notes-page-side-margin', `${marginPercent}%`);
    editorPage?.style.setProperty('--notes-editor-padding-max', `${paddingMax}px`);
}

function closePageSetupDropdowns(except = null) {
    pageSetupPopover?.querySelectorAll('[data-page-setup-dropdown]').forEach((dropdown) => {
        if (dropdown === except) return;
        dropdown.querySelector('[data-page-setup-options]')?.setAttribute('hidden', '');
        dropdown.querySelector('[data-page-setup-dropdown-trigger]')?.setAttribute('aria-expanded', 'false');
    });
}

function syncPageSetupDropdown(dropdown, value) {
    if (!dropdown) return;
    const trigger = dropdown.querySelector('[data-page-setup-dropdown-trigger]');
    const labelTarget = trigger?.querySelector('[data-page-setup-selected-label]');
    const swatchTarget = trigger?.querySelector('[data-page-setup-selected-swatch]');
    const options = Array.from(dropdown.querySelectorAll('[data-page-setup-option], [data-page-setup-scope-option]'));
    const selected = options.find((option) => (option.dataset.value || option.dataset.pageSetupScopeOption) === value) || options[0];

    options.forEach((option) => {
        option.setAttribute('aria-selected', String(option === selected));
    });

    if (labelTarget && selected) {
        const primaryLabel = selected.querySelector('span:not(.notes-color-swatch)') || selected;
        labelTarget.textContent = primaryLabel.textContent.trim();
    }
    if (swatchTarget && selected?.dataset.swatch) {
        swatchTarget.style.background = selected.dataset.swatch;
    }
}

function updatePageSetupControls() {
    if (!pageSetupPopover) return;
    const setup = setupForCurrentScope();
    if (pageSetupScopeInput) {
        pageSetupScopeInput.value = pageSetupScope;
        syncPageSetupDropdown(pageSetupScopeInput.closest('.notes-setup-field')?.querySelector('[data-page-setup-dropdown]'), pageSetupScope);
    }
    pageSetupPopover.querySelectorAll('[data-page-setup-input]').forEach((input) => {
        const key = input.dataset.pageSetupInput;
        if (key === 'sideMargins') {
            input.value = String(clampSideMargins(setup.sideMargins));
            if (sideMarginsValue) sideMarginsValue.textContent = `${input.value}%`;
            return;
        }
        const nextValue = setup[key] || PAGE_SETUP_DEFAULTS[key];
        input.value = nextValue;
        syncPageSetupDropdown(input.closest('.notes-setup-field')?.querySelector('[data-page-setup-dropdown]'), nextValue);
    });
}

function applyEditorZoom({ persist = false } = {}) {
    const zoom = ZOOM_LEVELS[zoomIndex] || ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
    const fontSize = Math.round(16 * zoom * 10) / 10;
    const titleSize = Math.round(32 * zoom * 10) / 10;
    const contentWidth = Math.round(720 + Math.max(0, zoom - 1) * 300);

    editorPage?.style.setProperty('--notes-editor-font-size', `${fontSize}px`);
    editorPage?.style.setProperty('--notes-editor-title-size', `${titleSize}px`);
    editorPage?.style.setProperty('--notes-editor-content-width', `${contentWidth}px`);
    applyPageSetupVariables();

    if (zoomValue) zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    if (persist) storeZoomLevel(zoom);
    updateToolbarState();
    toolbarOverflowController?.refresh();
}

function setZoomIndex(nextIndex) {
    const clamped = clampZoomIndex(nextIndex);
    if (clamped === zoomIndex) return;
    zoomIndex = clamped;
    applyEditorZoom({ persist: true });
}

function iconHtml(icon) {
    if (!icon) return '';
    if (icon.startsWith?.('H')) {
        return icon;
    }
    return icon;
}

function textFromInlineContent(content) {
    if (!Array.isArray(content)) return '';
    return content.map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'link') return textFromInlineContent(item.content);
        return item?.text || '';
    }).join('');
}

function blockCountForDocument(documentValue) {
    return Array.isArray(documentValue) ? documentValue.length : 0;
}

function historyDepthForDocument(documentValue) {
    return blockCountForDocument(documentValue) >= LARGE_DOCUMENT_BLOCK_COUNT
        ? LONG_DOCUMENT_HISTORY_DEPTH
        : NORMAL_HISTORY_DEPTH;
}

function editorTopLevelBlockCount() {
    const prosemirrorBlockGroup = editorInstance?._tiptapEditor?.state?.doc?.firstChild;
    if (typeof prosemirrorBlockGroup?.childCount === 'number') {
        return prosemirrorBlockGroup.childCount;
    }
    return blockCountForDocument(latestDocumentSnapshot);
}

function invalidateDocumentSnapshot() {
    latestDocumentSnapshot = null;
}

function currentDocumentSnapshot() {
    if (!editorInstance) return [];
    if (!latestDocumentSnapshot) {
        latestDocumentSnapshot = editorInstance.document || [];
    }
    return latestDocumentSnapshot;
}

function fingerprintTextParts(parts) {
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

function notePayloadFingerprint(title, content) {
    return fingerprintTextParts([title, content]);
}

function noteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.href;
    } catch (error) {
        return '';
    }
}

function materialIcon(name, className = 'material-symbols-outlined') {
    return React.createElement('span', {
        className,
        'aria-hidden': 'true',
    }, name);
}

function updateBlockPayloadForPreservedText(block, payload) {
    if (!block || !payload) return payload;
    if (ATOM_BLOCK_TYPES.has(payload.type) || payload.type === 'table') return payload;
    return {
        ...payload,
        props: mergedPropsForBlockType(payload.type, block, payload.props),
        content: block.content,
        children: block.children || [],
    };
}

function isBlockStyleSelected(block, option) {
    if (!block || block.type !== option.type) return false;
    if (!option.props) return true;
    return Object.entries(option.props).every(([key, value]) => block.props?.[key] === value);
}

function getSelectedTextAlignment() {
    if (!editorInstance) return 'left';
    const inlineSelection = editorInstance._tiptapEditor?.state?.selection;
    if (inlineSelection?.node?.type?.name === 'inlineImage') {
        return inlineSelection.node.attrs?.alignment || 'left';
    }
    const blocks = selectedBlocks();
    const block = blocks[0];
    if (!block) return 'left';

    if (checkBlockHasDefaultProp('textAlignment', block, editorInstance)) {
        return block.props.textAlignment || 'left';
    }

    if (block.type === 'table') {
        const cellSelection = editorInstance.tableHandles?.getCellSelection();
        if (!cellSelection) return 'left';

        const alignments = cellSelection.cells.map(({ row, col }) => (
            mapTableCell(block.content.rows[row].cells[col]).props.textAlignment
        ));
        const firstAlignment = alignments[0];
        return alignments.every((alignment) => alignment === firstAlignment) ? firstAlignment || 'left' : 'left';
    }

    return 'left';
}

function applyTextAlignment(textAlignment) {
    if (!editorInstance) return;
    editorInstance.focus();

    const inlineSelection = editorInstance._tiptapEditor?.state?.selection;
    if (inlineSelection?.node?.type?.name === 'inlineImage') {
        const transaction = editorInstance._tiptapEditor.state.tr.setNodeMarkup(
            inlineSelection.from,
            undefined,
            { ...inlineSelection.node.attrs, layout: 'break', alignment: textAlignment === 'justify' ? 'left' : textAlignment }
        );
        editorInstance.dispatch(transaction);
        updateEditorChrome();
        triggerDebouncedSave();
        return;
    }

    selectedBlocks().forEach((block) => {
        if (checkBlockTypeHasDefaultProp('textAlignment', block.type, editorInstance)) {
            editorInstance.updateBlock(block, { props: { ...block.props, textAlignment } });
            return;
        }

        if (block.type !== 'table') return;
        const cellSelection = editorInstance.tableHandles?.getCellSelection();
        if (!cellSelection) return;

        const newTable = block.content.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => mapTableCell(cell)),
        }));

        cellSelection.cells.forEach(({ row, col }) => {
            newTable[row].cells[col].props.textAlignment = textAlignment;
        });

        editorInstance.updateBlock(block, {
            type: 'table',
            content: {
                ...block.content,
                type: 'tableContent',
                rows: newTable,
            },
        });
        editorInstance.setTextCursorPosition(block);
    });

    updateEditorChrome();
    triggerDebouncedSave();
}

function closePageSetupPopover({ restoreFocus = false } = {}) {
    if (!pageSetupPopover) return;
    const triggerToRestore = activePageSetupTrigger;
    if (pageSetupPositionRafId) {
        window.cancelAnimationFrame(pageSetupPositionRafId);
        pageSetupPositionRafId = null;
    }
    pageSetupPopover.hidden = true;
    closePageSetupDropdowns();
    activePageSetupTrigger?.setAttribute('aria-expanded', 'false');
    activePageSetupTrigger = null;
    activePageSetupTriggerRect = null;
    if (restoreFocus && triggerToRestore?.isConnected) {
        triggerToRestore.focus({ preventScroll: true });
    }
}

function usableTriggerRect(trigger) {
    const rect = trigger?.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) return null;
    return rect;
}

function positionPageSetupPopover(trigger, triggerRectOverride = null) {
    if (!pageSetupPopover || !trigger) return;
    const currentRect = usableTriggerRect(trigger);
    activePageSetupTriggerRect = currentRect || triggerRectOverride || activePageSetupTriggerRect;
    if (!activePageSetupTriggerRect) return;
    positionFloatingElement(trigger, pageSetupPopover, {
        triggerRectOverride: activePageSetupTriggerRect,
        boundaryRect: editorPage?.getBoundingClientRect(),
    });
}

function schedulePageSetupPopoverPosition() {
    if (!pageSetupPopover || pageSetupPopover.hidden || pageSetupPositionRafId) return;
    pageSetupPositionRafId = window.requestAnimationFrame(() => {
        pageSetupPositionRafId = null;
        positionPageSetupPopover(activePageSetupTrigger, activePageSetupTriggerRect);
    });
}

function openPageSetupPopover(trigger, triggerRect = null) {
    if (!pageSetupPopover) return;
    closeToolbarMenus();
    activePageSetupTrigger = trigger || null;
    activePageSetupTriggerRect = triggerRect || usableTriggerRect(trigger);
    pageSetupPopover.hidden = false;
    activePageSetupTrigger?.setAttribute('aria-expanded', 'true');
    updatePageSetupControls();
    positionPageSetupPopover(activePageSetupTrigger, activePageSetupTriggerRect);
    window.requestAnimationFrame(() => {
        if (pageSetupPopover.hidden) return;
        pageSetupPopover.querySelector('[data-page-setup-dropdown-trigger]')?.focus({ preventScroll: true });
    });
}

async function saveNotePageSetup() {
    if (!canEdit || !noteId || noteCollaborationEnabled) return;
    try {
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup_json: notePageSetup }),
        }), 'notes-page-setup') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup_json: notePageSetup }),
        }));
        if (!response.ok) throw new Error('Page setup save failed');
        const updated = await response.json();
        notePageSetup = normalizePageSetup(updated?.page_setup);
        globalPageSetup = normalizePageSetup(updated?.global_page_setup);
        applyPageSetupVariables();
        updatePageSetupControls();
    } catch (error) {
        console.error(error);
        setSaveStatus('error', { message: 'Page setup save failed' });
    }
}

async function saveGlobalPageSetup() {
    if (!canEdit) return;
    try {
        const response = await (window.APStudyPendingMutations?.track(fetch('/settings/api/notes-page-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup: globalPageSetup }),
        }), 'notes-page-setup') || fetch('/settings/api/notes-page-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup: globalPageSetup }),
        }));
        if (!response.ok) throw new Error('Global page setup save failed');
        const updated = await response.json();
        globalPageSetup = normalizePageSetup(updated?.notes_page_setup);
        applyPageSetupVariables();
        updatePageSetupControls();
    } catch (error) {
        console.error(error);
        setSaveStatus('error', { message: 'Page setup save failed' });
    }
}

function schedulePageSetupSave() {
    if (!canEdit) return;
    if (pageSetupSaveTimer) clearTimeout(pageSetupSaveTimer);
    pageSetupSaveTimer = window.setTimeout(() => {
        if (pageSetupScope === 'global') {
            void saveGlobalPageSetup();
        } else {
            void saveNotePageSetup();
        }
    }, PAGE_SETUP_SAVE_DEBOUNCE_MS);
}

function updateCurrentPageSetup(key, value) {
    const nextValue = key === 'sideMargins' ? clampSideMargins(value) : value;
    if (pageSetupScope === 'global') {
        globalPageSetup = normalizePageSetup({ ...globalPageSetup, [key]: nextValue });
    } else {
        notePageSetup = normalizePageSetup({ ...notePageSetup, [key]: nextValue });
    }
    applyPageSetupVariables();
    updatePageSetupControls();
    schedulePageSetupSave();
}

function syncNotePrintControls() {
    notePrintButtons.forEach((button) => {
        const disabled = !notePrintReady || notePrintInProgress;
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
        button.toggleAttribute('aria-busy', notePrintInProgress);
    });
}

function setNotePrintReady(ready) {
    notePrintReady = Boolean(ready);
    syncNotePrintControls();
}

async function requestCurrentNotePrint() {
    if (!notePrintReady || notePrintInProgress || !editorInstance || !titleInput) return;
    notePrintInProgress = true;
    syncNotePrintControls();
    closeToolbarMenus();
    closePageSetupPopover();

    try {
        const { printNote } = await import('./editor/print.js');
        const documentSnapshot = currentDocumentSnapshot();
        const { hidden } = hiddenBlocksForCollapsedHeadings(documentSnapshot);
        const setup = effectivePageSetup();
        await printNote({
            editor: editorInstance,
            blocks: documentSnapshot,
            hiddenBlockIds: hidden.keys(),
            title: titleInput.value,
            fontFamily: PAGE_SETUP_FONT_TYPES[setup.fontType] || PAGE_SETUP_FONT_TYPES.default,
            sideMargins: setup.sideMargins,
        });
    } catch (error) {
        console.error('Failed to prepare note for printing', error);
        window.APStudyToast?.error?.('Could not prepare this note for printing.');
    } finally {
        notePrintInProgress = false;
        syncNotePrintControls();
    }
}

function bindNotePrintControls() {
    syncNotePrintControls();
    document.addEventListener('click', handleNotePrintClick, true);
    document.addEventListener('keydown', handleNotePrintShortcut, true);
}

function handleNotePrintClick(event) {
    const button = event.target.closest?.('[data-note-print]');
    if (!button || !document.contains(button)) return;
    event.preventDefault();
    void requestCurrentNotePrint();
}

function handleNotePrintShortcut(event) {
    const isPrintShortcut = !event.defaultPrevented
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && String(event.key || '').toLowerCase() === 'p';
    if (!isPrintShortcut) return;
    event.preventDefault();
    if (notePrintReady) void requestCurrentNotePrint();
}

function bindLazyReviewPanel({ canReview, canManageReviews, canViewVersions }) {
    reviewPanelBootstrapCleanup?.();
    reviewPanelBootstrapCleanup = null;
    if (!noteId || !reviewPanel) return;

    const openPanel = async (mode) => {
        reviewButton?.setAttribute('aria-busy', 'true');
        historyButton?.setAttribute('aria-busy', 'true');
        try {
            reviewPanelModulePromise ||= import('./editor/review-panel.js');
            const { bindReviewPanel } = await reviewPanelModulePromise;
            if (editorPageDisposed) return;
            if (!reviewPanelController) {
                reviewPanelController = bindReviewPanel({
                    noteId,
                    canReview,
                    canManageReviews,
                    canViewVersions,
                    panel: reviewPanel,
                    reviewButton: null,
                    historyButton: null,
                    toast: window.APStudyToast,
                });
            }
            await reviewPanelController?.open?.(mode);
        } catch (error) {
            console.error('Failed to load note review panel', error);
            window.APStudyToast?.error?.('Could not load review tools.');
        } finally {
            reviewButton?.removeAttribute('aria-busy');
            historyButton?.removeAttribute('aria-busy');
        }
    };
    const openReview = () => { void openPanel('review'); };
    const openHistory = () => { void openPanel('history'); };
    reviewButton?.addEventListener('click', openReview);
    historyButton?.addEventListener('click', openHistory);
    reviewPanelBootstrapCleanup = () => {
        reviewButton?.removeEventListener('click', openReview);
        historyButton?.removeEventListener('click', openHistory);
    };
}

function closeToolbarMenus() {
    if (!writingToolbar) return;
    activeToolbarMenu = null;
    writingToolbar.querySelectorAll('[data-toolbar-menu]').forEach((menu) => {
        menu.hidden = true;
    });
    writingToolbar.querySelectorAll('[data-toolbar-menu-trigger]').forEach((trigger) => {
        trigger.setAttribute('aria-expanded', 'false');
    });
}

function positionFloatingElement(trigger, element, { triggerRectOverride = null, boundaryRect = null } = {}) {
    if (!trigger || !element) return;
    const triggerRect = triggerRectOverride || trigger.getBoundingClientRect();
    element.style.left = '0px';
    element.style.top = '0px';
    element.style.transform = 'none';

    const originRect = element.getBoundingClientRect();
    const position = floatingPopoverPosition({
        triggerRect,
        popoverRect: originRect,
        boundaryRect,
    });

    element.style.left = `${Math.round(position.left - originRect.left)}px`;
    element.style.top = `${Math.round(position.top - originRect.top)}px`;
}

function positionToolbarMenu(trigger, menu, triggerRectOverride = null) {
    if (!trigger || !menu) return;
    const triggerRect = triggerRectOverride || trigger.getBoundingClientRect();
    const isOverflowToolbar = menu.classList.contains('notes-toolbar-overflow-menu');
    menu.style.minWidth = isOverflowToolbar ? '0px' : `${Math.max(triggerRect.width, 150)}px`;

    const editorRect = editorPage?.getBoundingClientRect();
    menu.style.maxWidth = isOverflowToolbar
        ? `${Math.max(0, Math.min(window.innerWidth, editorRect?.width || window.innerWidth) - 16)}px`
        : '';
    positionFloatingElement(trigger, menu, {
        triggerRectOverride: triggerRect,
        boundaryRect: editorRect,
    });
}

function openToolbarMenu(name, trigger) {
    if (!writingToolbar) return;
    const menu = writingToolbar.querySelector(`[data-toolbar-menu="${name}"]`);
    if (!menu) return;

    const openingSameMenu = activeToolbarMenu === name && !menu.hidden;
    const triggerRect = trigger?.getBoundingClientRect() || null;
    closePageSetupPopover();
    closeToolbarMenus();
    if (openingSameMenu) return;

    activeToolbarMenu = name;
    menu.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');

    if (name === 'link') {
        const input = menu.querySelector('[data-link-url]');
        if (input) {
            input.value = editorInstance?.getSelectedLinkUrl?.() || '';
            window.setTimeout(() => input.focus(), 0);
        }
    } else if (name === 'add-block') {
        prepareAddBlockMenu(menu);
    } else if (name === 'font-size') {
        renderFontSizeMenu(menu);
    } else if (name === 'text-color' || name === 'highlight-color') {
        renderColorMenu(menu, name === 'highlight-color' ? 'backgroundColor' : 'textColor');
    }

    positionToolbarMenu(trigger, menu, triggerRect);
}

function renderFontSizeMenu(menu) {
    if (!menu || menu.dataset.rendered === 'font-size') return;
    menu.dataset.rendered = 'font-size';
    menu.innerHTML = FONT_SIZE_PRESETS.map((item) => `
        <button type="button" class="notes-toolbar-menu-item" data-editor-action="font-size" data-font-size="${item.value}" data-menu-check="font-size-${item.value}">
            <span class="material-symbols-outlined" aria-hidden="true">format_size</span>
            <span>${item.label}</span>
        </button>
    `).join('');
}

function renderColorMenu(menu, style) {
    if (!menu || menu.dataset.rendered === style) return;
    menu.dataset.rendered = style;
    const action = style === 'backgroundColor' ? 'highlight-color' : 'text-color';
    menu.innerHTML = FORMAT_COLORS.map((item) => `
        <button type="button" class="notes-toolbar-menu-item notes-color-menu-item" data-editor-action="${action}" data-color="${item.value}" data-menu-check="${action}-${item.value}">
            <span class="notes-format-swatch" data-${style === 'backgroundColor' ? 'background' : 'text'}-color="${item.value}" aria-hidden="true"></span>
            <span>${item.label}</span>
        </button>
    `).join('');
}

function visibleAddBlockItems(menu) {
    return Array.from(menu?.querySelectorAll('.notes-add-block-item:not([hidden])') || []);
}

function setActiveAddBlockItem(menu, index) {
    const items = visibleAddBlockItems(menu);
    if (!items.length) return;
    addBlockActiveIndex = Math.min(items.length - 1, Math.max(0, index));
    items.forEach((item, itemIndex) => {
        const active = itemIndex === addBlockActiveIndex;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
        if (active) item.scrollIntoView({ block: 'nearest' });
    });
}

function filterAddBlockMenu(menu) {
    const input = menu?.querySelector('[data-add-block-search]');
    const query = (input?.value || '').trim().toLowerCase();
    const items = filterBlockCatalog(query);
    const visibleKeys = new Set(items.map((item) => item.key));
    menu?.querySelectorAll('.notes-add-block-item').forEach((item) => {
        item.hidden = !visibleKeys.has(item.dataset.blockKey);
    });
    setActiveAddBlockItem(menu, 0);
}

function renderAddBlockMenu(menu) {
    const list = menu?.querySelector('[data-add-block-list]');
    if (!list || list.dataset.rendered === 'catalog') return;
    list.dataset.rendered = 'catalog';
    list.innerHTML = BLOCK_CATALOG.map((item) => `
        <button type="button" class="notes-add-block-item" data-editor-action="insert-block" data-block-key="${item.key}" data-block-type="${item.type}">
            <span class="${blockIconClass(item.icon)}" aria-hidden="true">${iconHtml(item.icon)}</span>
            <span><strong>${item.label}</strong><small>${item.description}</small></span>
        </button>
    `).join('');
}

function prepareAddBlockMenu(menu) {
    renderAddBlockMenu(menu);
    const input = menu?.querySelector('[data-add-block-search]');
    if (input) {
        input.value = '';
        window.setTimeout(() => input.focus(), 0);
    }
    filterAddBlockMenu(menu);
}

function createToolbarOverflowController(toolbar) {
    const main = toolbar?.querySelector('[data-toolbar-main]');
    const more = toolbar?.querySelector('[data-toolbar-more]');
    const menu = toolbar?.querySelector('[data-toolbar-menu="overflow"]');
    if (!main || !more || !menu) return null;

    const items = Array.from(main.querySelectorAll('[data-toolbar-item]')).map((element, index) => ({
        element,
        index,
        priority: Number(element.dataset.overflowPriority || 100),
    }));

    const restoreItems = () => {
        items
            .slice()
            .sort((a, b) => a.index - b.index)
            .forEach(({ element }) => {
                main.insertBefore(element, more);
            });
    };

    const refresh = () => {
        restoreItems();
        more.hidden = true;
        menu.hidden = true;
        closeToolbarMenus();

        window.requestAnimationFrame(() => {
            restoreItems();
            const moved = [];
            const ordered = items.slice().sort((a, b) => b.priority - a.priority || b.index - a.index);

            more.hidden = false;
            for (const item of ordered) {
                if (main.scrollWidth <= main.clientWidth + 1) break;
                menu.insertBefore(item.element, menu.firstChild);
                moved.push(item);
            }

            more.hidden = moved.length === 0;
            if (!moved.length) menu.hidden = true;
        });
    };

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null;
    observer?.observe(main);
    window.addEventListener('resize', refresh);

    return {
        refresh,
        disconnect() {
            observer?.disconnect();
            window.removeEventListener('resize', refresh);
        },
    };
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
    if (saveRetry) saveRetry.hidden = true;

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
    if (!canEdit || !noteId || !titleInput || !editorInstance || noteCollaborationEnabled) return;

    const documentSnapshot = currentDocumentSnapshot();
    const content = JSON.stringify(documentSnapshot);
    const payload = {
        title: titleInput.value,
        content,
    };
    const payloadFingerprint = notePayloadFingerprint(payload.title, payload.content);
    if (payloadFingerprint === lastSavedPayloadFingerprint) {
        noteHasPendingChanges = false;
        return;
    }

    setSaveStatus('saving');

    try {
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }), 'notes-save') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }));

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        lastSavedPayloadFingerprint = payloadFingerprint;
        noteHasPendingChanges = false;
        setSaveStatus('saved', { savedAt: new Date().toISOString() });
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}

function currentSaveDebounceMs() {
    const blockCount = editorTopLevelBlockCount();
    return blockCount >= LARGE_DOCUMENT_BLOCK_COUNT ? SAVE_DEBOUNCE_LARGE_DOC_MS : SAVE_DEBOUNCE_MS;
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

function removeUrlBlockPopover(result = null) {
    if (!urlBlockPopover) return;
    const resolve = urlBlockResolve;
    urlBlockPopover.remove();
    urlBlockPopover = null;
    urlBlockResolve = null;
    resolve?.(result);
}

function positionUrlBlockPopover(anchorRect) {
    if (!urlBlockPopover) return;
    const rect = anchorRect || editorPage?.getBoundingClientRect() || { left: 16, bottom: 80 };
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left || 8, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min((rect.bottom || 80) + 8, window.innerHeight - 380));
    urlBlockPopover.style.width = `${width}px`;
    urlBlockPopover.style.left = `${Math.round(left)}px`;
    urlBlockPopover.style.top = `${Math.round(top)}px`;
}

function requestUrlForBlock(item, anchorRect = null) {
    removeUrlBlockPopover();
    return new Promise((resolve) => {
        urlBlockResolve = resolve;
        const label = item?.label || 'URL block';
        urlBlockPopover = document.createElement('form');
        urlBlockPopover.className = 'notes-url-block-popover';
        urlBlockPopover.setAttribute('data-gramm', 'false');
        urlBlockPopover.setAttribute('data-gramm_editor', 'false');
        urlBlockPopover.setAttribute('data-enable-grammarly', 'false');
        urlBlockPopover.setAttribute('spellcheck', 'false');
        urlBlockPopover.innerHTML = `
            <label class="notes-url-block-field">
                <span>${label} URL</span>
                <input type="url" name="url" placeholder="https://example.com" autocomplete="off" ${GRAMMARLY_DISABLED_ATTRS} required />
            </label>
            <div class="notes-url-block-error" role="alert" hidden></div>
            <div class="notes-url-block-actions">
                <button type="button" data-url-block-cancel>Cancel</button>
                <button type="submit">Insert</button>
            </div>
        `;
        document.body.appendChild(urlBlockPopover);
        positionUrlBlockPopover(anchorRect);
        const input = urlBlockPopover.querySelector('input[name="url"]');
        const error = urlBlockPopover.querySelector('.notes-url-block-error');
        input?.focus();

        urlBlockPopover.addEventListener('submit', (event) => {
            event.preventDefault();
            const url = noteUrl(input?.value);
            if (!url) {
                if (error) {
                    error.hidden = false;
                    error.textContent = 'Enter a valid http or https URL.';
                }
                return;
            }
            removeUrlBlockPopover(url);
        });
        urlBlockPopover.querySelector('[data-url-block-cancel]')?.addEventListener('click', () => {
            removeUrlBlockPopover('');
        });
    });
}

async function insertImageFromDialog(anchorRect = null, editor = editorInstance) {
    const source = await requestImageSource(anchorRect, noteUrl);
    if (!source) return null;
    closeToolbarMenus();
    if (source.file) return insertInlineImageFile(editor, source.file, { noteId, onChange: triggerDebouncedSave });
    return insertInlineImageNode(editor, { url: source.url, mediaId: '', clientId: `url-${Date.now()}`, alt: '', width: 240, layout: 'inline', alignment: 'left', status: 'ready', error: '' });
}

async function previewForBookmark(url) {
    try {
        const response = await fetch(`/api/notes/tools/link-preview?url=${encodeURIComponent(url)}`);
        if (!response.ok) throw new Error('Preview unavailable');
        return await response.json();
    } catch (error) {
        let hostname = '';
        try {
            hostname = new URL(url).hostname;
        } catch (urlError) {
            hostname = '';
        }
        return {
            url,
            title: hostname || url,
            description: '',
            image_url: '',
            site_name: hostname,
            content_type: '',
            preview_found: false,
        };
    }
}

async function payloadForCatalogItem(item, anchorRect = null) {
    if (!item) return blockPayloadForCatalogItem(catalogItemByKey('paragraph'));
    if (!item.requiresUrl) return blockPayloadForCatalogItem(item);
    const url = await requestUrlForBlock(item, anchorRect);
    if (!url) return null;
    if (item.type === 'bookmark') {
        const preview = await previewForBookmark(url);
        return blockPayloadForCatalogItem(item, {
            url: preview?.url || url,
            title: preview?.title || url,
            description: preview?.description || '',
            image_url: preview?.image_url || '',
            site_name: preview?.site_name || '',
            content_type: preview?.content_type || '',
        });
    }
    return blockPayloadForCatalogItem(item, { url });
}

function insertBlockPayload(block, editor = editorInstance) {
    if (!editor || !block) return null;
    const currentBlock = editor.getTextCursorPosition?.()?.block;
    if (!currentBlock) {
        editor.focus?.();
        return null;
    }
    let insertedOrUpdated = null;
    if (blockOwnContentIsEmpty(currentBlock)) {
        insertedOrUpdated = editor.updateBlock(currentBlock, block);
    } else {
        insertedOrUpdated = editor.insertBlocks?.([block], currentBlock, 'after')?.[0] || null;
    }

    if (!insertedOrUpdated) return null;

    if (ATOM_BLOCK_TYPES.has(insertedOrUpdated.type) || insertedOrUpdated.type === 'table') {
        const after = editor.insertBlocks?.([{ type: 'paragraph' }], insertedOrUpdated, 'after')?.[0];
        if (after) editor.setTextCursorPosition?.(after);
    } else {
        editor.setTextCursorPosition?.(insertedOrUpdated);
    }

    editor.focus?.();
    updateEditorChrome();
    triggerDebouncedSave();
    return insertedOrUpdated;
}

async function insertCatalogItem(item, anchorRect = null, editor = editorInstance) {
    if (item?.type === 'inlineImage') return insertImageFromDialog(anchorRect, editor);
    const payload = await payloadForCatalogItem(item, anchorRect);
    if (!payload) {
        focusEditorBody();
        return null;
    }
    closeToolbarMenus();
    return insertBlockPayload(payload, editor);
}

function insertBlockFromMenu(button) {
    if (!editorInstance) return;
    const item = catalogItemByKey(button?.dataset.blockKey) || catalogItemByType(button?.dataset.blockType, {
        level: Number(button?.dataset.level || 1),
    });
    void insertCatalogItem(item || catalogItemByKey('paragraph'), button?.getBoundingClientRect?.());
}

function selectedBlocks() {
    if (!editorInstance) return [];
    return editorInstance.getSelection?.()?.blocks || [editorInstance.getTextCursorPosition?.()?.block].filter(Boolean);
}

function safeSetBlockSelection(anchor, head = anchor) {
    if (!editorInstance || !anchor) return false;
    const nextHead = head || anchor;
    if (anchor.id && nextHead.id && anchor.id !== nextHead.id) {
        editorInstance.setSelection?.(anchor, nextHead);
    } else {
        editorInstance.setTextCursorPosition?.(anchor);
    }
    selectedBlockAnchorId = anchor.id || null;
    editorInstance.setForceSelectionVisible?.(true);
    return true;
}

function blockSupportsVisualIndent(block) {
    return VISUAL_INDENT_BLOCKS.has(block?.type);
}

function visualIndentLevel(block) {
    return Math.min(MAX_INDENT_LEVEL, Math.max(0, Number(block?.props?.indentLevel || 0)));
}

function mergedPropsForBlockType(type, block, props = undefined) {
    const merged = {};
    if (block?.props?.textAlignment) merged.textAlignment = block.props.textAlignment;
    if (block?.props?.textColor) merged.textColor = block.props.textColor;
    if (block?.props?.backgroundColor) merged.backgroundColor = block.props.backgroundColor;
    if (VISUAL_INDENT_BLOCKS.has(type)) merged.indentLevel = visualIndentLevel(block);
    if (type === 'heading') merged.level = Number(props?.level || block?.props?.level || 1);
    if (type === 'checkListItem') merged.checked = Boolean(block?.props?.checked);
    return { ...merged, ...(props || {}) };
}

function setSelectedBlocks(type, props = undefined) {
    if (!editorInstance) return;
    selectedBlocks().forEach((block) => {
        if (!block) return;
        editorInstance.updateBlock(block, {
            type,
            props: mergedPropsForBlockType(type, block, props),
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

function applyInlineStyle(style, value) {
    if (!editorInstance) return;
    editorInstance.focus?.();
    if (value === 'default' || value === '') {
        editorInstance.removeStyles?.({ [style]: value });
    } else {
        editorInstance.addStyles?.({ [style]: value });
    }
    updateEditorChrome();
    triggerDebouncedSave();
}

function applyTextColor(color) {
    applyInlineStyle('textColor', color);
}

function applyHighlightColor(color) {
    applyInlineStyle('backgroundColor', color);
}

function applyFontSizePreset(value) {
    const preset = FONT_SIZE_PRESETS.find((item) => item.value === value) || FONT_SIZE_PRESETS[0];
    if (preset.value === 'default') {
        editorInstance?.removeStyles?.({ fontSize: '' });
    } else {
        editorInstance?.addStyles?.({ fontSize: preset.cssValue });
    }
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

function deleteSelectedBlocks() {
    if (!editorInstance) return;
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    removeBlocksAndRestoreCursor(editorInstance, blocks);
    selectedBlockAnchorId = null;
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

function duplicateSelectedBlocks() {
    if (!editorInstance) return;
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    const copied = JSON.parse(JSON.stringify(blocks)).map((block) => {
        delete block.id;
        return block;
    });
    const inserted = editorInstance.insertBlocks?.(copied, blocks[blocks.length - 1], 'after') || [];
    if (inserted[0]) {
        safeSetBlockSelection(inserted[0], inserted[inserted.length - 1] || inserted[0]);
    }
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

async function copySelectedBlocks({ cut = false } = {}) {
    if (!editorInstance) return;
    const blocks = selectedBlocks();
    if (!blocks.length) return;
    const blockIds = blocks.map((block) => block.id).filter(Boolean);
    const [markdown, html] = await Promise.all([
        editorInstance.blocksToMarkdownLossy?.(blocks),
        editorInstance.blocksToHTMLLossy?.(blocks),
    ]);
    const copiedMarkdown = markdown || blocks.map((block) => textFromInlineContent(block.content)).join('\n\n');
    const plainText = normalizeCopiedPlainText(copiedMarkdown);
    try {
        if (window.ClipboardItem && navigator.clipboard?.write) {
            const clipboardPayload = {
                'text/plain': new Blob([plainText], { type: 'text/plain' }),
                'text/html': new Blob([html || plainText], { type: 'text/html' }),
            };
            if (window.ClipboardItem.supports?.('text/markdown')) {
                clipboardPayload['text/markdown'] = new Blob([copiedMarkdown], { type: 'text/markdown' });
            }
            await navigator.clipboard.write([
                new ClipboardItem(clipboardPayload),
            ]);
        } else {
            await navigator.clipboard?.writeText(plainText);
        }
    } catch (error) {
        try {
            await navigator.clipboard?.writeText(plainText);
        } catch (clipboardError) {
            console.warn('Unable to write selected note blocks to clipboard', clipboardError);
        }
    }
    if (cut) removeBlocksAndRestoreCursor(editorInstance, blockIds);
}

function normalizeNativeEditorCopy(event) {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    const plainText = clipboardData.getData('text/plain');
    if (!plainText) return;
    clipboardData.setData('text/plain', normalizeCopiedPlainText(plainText));
}

function moveSelectedBlocks(direction) {
    if (!editorInstance) return;
    if (direction === 'up') {
        editorInstance.moveBlocksUp?.();
    } else {
        editorInstance.moveBlocksDown?.();
    }
    focusEditorBody();
    updateEditorChrome({ structureChanged: true });
    triggerDebouncedSave();
}

function firstSelectedHeading() {
    return selectedBlocks().find((block) => block?.type === 'heading') || null;
}

function toggleHeadingCollapse(block = firstSelectedHeading()) {
    if (!editorInstance || !block || block.type !== 'heading') return;
    editorInstance.updateBlock(block, {
        props: {
            ...block.props,
            isCollapsed: !Boolean(block.props?.isCollapsed),
        },
    });
    focusEditorBody();
    updateEditorChrome({ structureChanged: true });
    triggerDebouncedSave();
}

function selectBlockRange(block, extend = false) {
    if (!editorInstance || !block) return;
    const anchor = extend && selectedBlockAnchorId ? editorInstance.getBlock?.(selectedBlockAnchorId) : null;
    if (anchor) {
        safeSetBlockSelection(anchor, block);
    } else {
        safeSetBlockSelection(block, block);
    }
    updateEditorChrome();
}

function selectedBlockIds() {
    return new Set(selectedBlocks().map((block) => block?.id).filter(Boolean));
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

function canRunIndentAction(action) {
    if (!editorInstance) return false;
    const blocks = selectedBlocks();
    if (!blocks.length) return false;
    if (blocks.some((block) => LIST_BLOCK_TYPES.has(block?.type))) {
        if (action === 'indent') return Boolean(editorInstance.canNestBlock?.());
        if (action === 'outdent') return Boolean(editorInstance.canUnnestBlock?.());
    }
    if (blocks.some(blockSupportsVisualIndent)) {
        if (action === 'indent') return blocks.some((block) => visualIndentLevel(block) < MAX_INDENT_LEVEL);
        if (action === 'outdent') return blocks.some((block) => visualIndentLevel(block) > 0);
    }
    return false;
}

function runIndentAction(action) {
    if (!editorInstance || !canRunIndentAction(action)) return;
    const blocks = selectedBlocks();
    const listMode = blocks.some((block) => LIST_BLOCK_TYPES.has(block?.type));
    if (listMode && action === 'indent') {
        editorInstance.nestBlock?.();
    } else if (listMode && action === 'outdent') {
        editorInstance.unnestBlock?.();
    } else {
        blocks.forEach((block) => {
            if (!blockSupportsVisualIndent(block)) return;
            const currentLevel = visualIndentLevel(block);
            const nextLevel = action === 'indent'
                ? Math.min(MAX_INDENT_LEVEL, currentLevel + 1)
                : Math.max(0, currentLevel - 1);
            editorInstance.updateBlock(block, {
                props: {
                    ...block.props,
                    indentLevel: nextLevel,
                },
            });
        });
    }
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

function applyLinkFromMenu(menu) {
    if (!editorInstance || !menu) return;
    const input = menu.querySelector('[data-link-url]');
    const url = input?.value?.trim();
    if (!url) return;

    const selectedText = editorInstance.getSelectedText?.() || '';
    editorInstance.focus();
    editorInstance.createLink?.(url, selectedText ? undefined : url);
    closeToolbarMenus();
    updateEditorChrome();
    triggerDebouncedSave();
}

function removeSelectedLink() {
    if (!editorInstance) return;
    editorInstance.focus?.();
    editorInstance._tiptapEditor?.chain?.().focus().unsetLink().run();
    closeToolbarMenus();
    updateEditorChrome();
    triggerDebouncedSave();
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
    const blocks = selectedBlocks();
    const block = blocks[0];
    const activeStyles = typeof editorInstance.getActiveStyles === 'function'
        ? editorInstance.getActiveStyles()
        : {};
    const activeFontPreset = FONT_SIZE_PRESETS.find((item) => item.cssValue && item.cssValue === activeStyles?.fontSize) || FONT_SIZE_PRESETS[0];
    const activeBlockOption = TEXT_BLOCK_OPTIONS.find((option) => isBlockStyleSelected(block, option)) || TEXT_BLOCK_OPTIONS[0];
    const activeListOption = LIST_STYLE_OPTIONS.find((option) => isBlockStyleSelected(block, option));
    const currentAlignment = getSelectedTextAlignment();
    const activeAlignment = ALIGNMENT_OPTIONS.find((option) => option.value === currentAlignment) || ALIGNMENT_OPTIONS[0];

    const blockIcon = writingToolbar.querySelector('[data-current-block-icon]');
    const blockLabel = writingToolbar.querySelector('[data-current-block-label]');
    if (blockIcon) {
        blockIcon.classList.toggle('notes-toolbar-text-icon', activeBlockOption.icon.startsWith('H'));
        blockIcon.classList.toggle('material-symbols-outlined', !activeBlockOption.icon.startsWith('H'));
        blockIcon.textContent = iconHtml(activeBlockOption.icon);
    }
    if (blockLabel) blockLabel.textContent = activeBlockOption.label;

    const listIcon = writingToolbar.querySelector('[data-current-list-icon]');
    if (listIcon) listIcon.textContent = activeListOption?.icon || 'format_list_bulleted';

    const alignIcon = writingToolbar.querySelector('[data-current-align-icon]');
    if (alignIcon) alignIcon.textContent = activeAlignment.icon;

    const collapseIcon = writingToolbar.querySelector('[data-heading-collapse-icon]');
    const collapseLabel = writingToolbar.querySelector('[data-heading-collapse-label]');
    if (collapseIcon) collapseIcon.textContent = block?.props?.isCollapsed ? 'unfold_more' : 'unfold_less';
    if (collapseLabel) collapseLabel.textContent = block?.props?.isCollapsed ? 'Expand heading' : 'Collapse heading';

    writingToolbar.querySelectorAll('button[data-editor-action]').forEach((button) => {
        const action = button.dataset.editorAction;
        let active = false;
        let disabled = false;
        if (action === 'set-block') {
            const blockType = button.dataset.blockType;
            active = blockType === 'heading'
                ? block?.type === 'heading' && Number(block?.props?.level) === Number(button.dataset.level)
                : block?.type === blockType;
        } else if (action === 'align') {
            active = button.dataset.align === currentAlignment;
        } else if (action === 'basic-style') {
            active = Boolean(activeStyles?.[button.dataset.style]);
        } else if (action === 'text-color') {
            active = (activeStyles?.textColor || 'default') === button.dataset.color;
        } else if (action === 'highlight-color') {
            active = (activeStyles?.backgroundColor || 'default') === button.dataset.color;
        } else if (action === 'font-size') {
            active = activeFontPreset.value === button.dataset.fontSize;
        } else if (action === 'undo' || action === 'redo') {
            disabled = !canRunHistoryAction(action);
        } else if (action === 'indent' || action === 'outdent') {
            disabled = !canRunIndentAction(action);
        } else if (action === 'toggle-heading-collapse') {
            disabled = block?.type !== 'heading';
        } else if (['copy-blocks', 'cut-blocks', 'duplicate-blocks', 'delete-blocks', 'move-blocks-up', 'move-blocks-down'].includes(action)) {
            disabled = blocks.length === 0;
        } else if (action === 'zoom-out') {
            disabled = zoomIndex === 0;
        } else if (action === 'zoom-in') {
            disabled = zoomIndex === ZOOM_LEVELS.length - 1;
        }
        button.classList.toggle('is-active', active);
        if (action === 'basic-style') {
            button.setAttribute('aria-pressed', String(active));
        } else {
            button.removeAttribute('aria-pressed');
        }
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
    });

    writingToolbar.querySelectorAll('[data-menu-check]').forEach((item) => {
        const key = item.dataset.menuCheck;
        const checked = key === activeBlockOption.key
            || key === activeListOption?.key
            || key === activeAlignment.key
            || key === `text-color-${activeStyles?.textColor || 'default'}`
            || key === `highlight-color-${activeStyles?.backgroundColor || 'default'}`
            || key === `font-size-${activeFontPreset.value}`;
        item.classList.toggle('is-active', checked);
        item.setAttribute('aria-checked', String(checked));
    });
}

function updateEditorHint(documentSnapshot = latestDocumentSnapshot) {
    if (!editorHint || !editorInstance) return;
    if (Array.isArray(documentSnapshot)) {
        editorHint.hidden = documentHasText(documentSnapshot);
        return;
    }
    const textContent = editorInstance._tiptapEditor?.state?.doc?.textContent || '';
    editorHint.hidden = textContent.trim().length > 0;
}

function blockOuterById(id) {
    if (!id || !blocknoteRoot) return null;
    return blocknoteRoot.querySelector(`.bn-block-outer[data-id="${CSS.escape(String(id))}"]`);
}

function syncSelectedBlockClasses() {
    if (!blocknoteRoot) return;
    if (!canEdit) {
        blocknoteRoot.querySelectorAll('.notes-block-selected').forEach((element) => {
            element.classList.remove('notes-block-selected');
        });
        lastSelectedBlockIds = new Set();
        return;
    }
    const ids = selectedBlockIds();
    const toClear = [...lastSelectedBlockIds].filter((id) => !ids.has(id));
    const toSet = [...ids].filter((id) => !lastSelectedBlockIds.has(id));

    toClear.forEach((id) => {
        const element = blockOuterById(id);
        element?.classList.remove('notes-block-selected');
    });
    toSet.forEach((id) => {
        const element = blockOuterById(id);
        element?.classList.add('notes-block-selected');
    });
    lastSelectedBlockIds = ids;
}

function headingCollapseSignature(documentBlocks) {
    const { hidden, counts } = hiddenBlocksForCollapsedHeadings(documentBlocks || []);
    const collapsed = (documentBlocks || [])
        .filter((block) => block?.type === 'heading')
        .map((block) => `${block.id}:${block.props?.isCollapsed ? 1 : 0}:${counts.get(block.id) || 0}`)
        .join('|');
    const hiddenPart = [...hidden.entries()].map(([id, by]) => `${id}:${by}`).join('|');
    return `${collapsed}::${hiddenPart}`;
}

function syncHeadingCollapseChrome(force = false, documentSnapshot = null) {
    if (!editorInstance || !blocknoteRoot) return;
    const documentBlocks = documentSnapshot || currentDocumentSnapshot();
    const signature = headingCollapseSignature(documentBlocks);
    if (!force && signature === lastHeadingCollapseSignature) return;
    lastHeadingCollapseSignature = signature;

    const { hidden } = hiddenBlocksForCollapsedHeadings(documentBlocks);
    blocknoteRoot.querySelectorAll('.bn-block-outer[data-id]').forEach((element) => {
        const blockId = element.dataset.id;
        const hiddenBy = hidden.get(blockId);
        element.classList.toggle('notes-block-hidden-by-collapse', Boolean(hiddenBy));
        if (hiddenBy) element.dataset.hiddenByHeading = hiddenBy;
        else delete element.dataset.hiddenByHeading;
    });

    documentBlocks.forEach((block) => {
        if (block?.type !== 'heading') return;
        const outer = blockOuterById(block.id);
        const content = outer?.querySelector('.bn-block-content[data-content-type="heading"]');
        if (!content) return;
        content.classList.toggle('notes-heading-collapsed', Boolean(block.props?.isCollapsed));
        let button = content.querySelector(':scope > .notes-heading-collapse-toggle');
        if (!canEdit) {
            button?.remove();
            return;
        }
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'notes-heading-collapse-toggle';
            button.contentEditable = 'false';
            button.setAttribute('aria-label', 'Toggle heading collapse');
            button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>';
            content.insertBefore(button, content.firstChild);
        }
        button.setAttribute('aria-expanded', String(!block.props?.isCollapsed));
    });
}

function flushEditorChromeSync() {
    editorChromeRafId = null;
    const needsStructure = editorChromeSyncNeedsStructure;
    const documentSnapshot = editorChromeSyncSnapshot;
    editorChromeSyncNeedsStructure = false;
    editorChromeSyncSnapshot = null;
    syncSelectedBlockClasses();
    if (needsStructure) {
        syncHeadingCollapseChrome(false, documentSnapshot);
    }
}

function scheduleEditorChromeSync({ immediate = false, structureChanged = false, documentSnapshot = null } = {}) {
    editorChromeSyncNeedsStructure = editorChromeSyncNeedsStructure || structureChanged;
    if (documentSnapshot) editorChromeSyncSnapshot = documentSnapshot;

    if (immediate) {
        if (editorChromeThrottleTimer) {
            clearTimeout(editorChromeThrottleTimer);
            editorChromeThrottleTimer = null;
        }
        if (editorChromeRafId) {
            cancelAnimationFrame(editorChromeRafId);
        }
        editorChromeRafId = window.requestAnimationFrame(flushEditorChromeSync);
        return;
    }
    if (editorChromeThrottleTimer) return;
    editorChromeThrottleTimer = window.setTimeout(() => {
        editorChromeThrottleTimer = null;
        if (editorChromeRafId) return;
        editorChromeRafId = window.requestAnimationFrame(flushEditorChromeSync);
    }, EDITOR_CHROME_THROTTLE_MS);
}

function updateEditorChrome({ immediate = false, structureChanged = false, contentChanged = false, documentSnapshot = null } = {}) {
    updateToolbarState();
    if (contentChanged) {
        updateEditorHint(documentSnapshot);
    }
    if (immediate || structureChanged || contentChanged) {
        scheduleEditorChromeSync({
            immediate: immediate || structureChanged,
            structureChanged: structureChanged || contentChanged,
            documentSnapshot,
        });
        return;
    }
    scheduleEditorChromeSync();
}

function bindWritingToolbar() {
    if (!canEdit || !writingToolbar) return;
    if (!claimElementBinding(writingToolbar, 'notesEditorToolbarBound')) {
        toolbarOverflowController?.refresh();
        return;
    }
    writingToolbar.hidden = false;
    toolbarOverflowController?.disconnect();
    toolbarOverflowController = createToolbarOverflowController(writingToolbar);

    writingToolbar.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-toolbar-menu-close]');
        if (closeButton) {
            event.preventDefault();
            closeToolbarMenus();
            return;
        }

        const menuTrigger = event.target.closest('[data-toolbar-menu-trigger]');
        if (menuTrigger && writingToolbar.contains(menuTrigger)) {
            event.preventDefault();
            openToolbarMenu(menuTrigger.dataset.toolbarMenuTrigger, menuTrigger);
            return;
        }

        if (handlePageSetupToolbarClick(
            event,
            writingToolbar,
            pageSetupPopover,
            openPageSetupPopover,
            closePageSetupPopover
        )) return;

        const actionButton = event.target.closest('button[data-editor-action]');
        if (!actionButton || !writingToolbar.contains(actionButton)) return;
        event.preventDefault();

        const action = actionButton.dataset.editorAction;
        if (action === 'focus-body') {
            focusEditorBody();
        } else if (action === 'insert-block') {
            insertBlockFromMenu(actionButton);
        } else if (action === 'undo' || action === 'redo') {
            runHistoryAction(action);
        } else if (action === 'zoom-out') {
            setZoomIndex(zoomIndex - 1);
        } else if (action === 'zoom-in') {
            setZoomIndex(zoomIndex + 1);
        } else if (action === 'basic-style') {
            toggleBasicStyle(actionButton.dataset.style);
        } else if (action === 'text-color') {
            applyTextColor(actionButton.dataset.color || 'default');
            closeToolbarMenus();
        } else if (action === 'highlight-color') {
            applyHighlightColor(actionButton.dataset.color || 'default');
            closeToolbarMenus();
        } else if (action === 'font-size') {
            applyFontSizePreset(actionButton.dataset.fontSize || 'default');
            closeToolbarMenus();
        } else if (action === 'remove-link') {
            removeSelectedLink();
        } else if (action === 'set-block') {
            const blockType = actionButton.dataset.blockType;
            const level = Number(actionButton.dataset.level);
            setSelectedBlocks(blockType, blockType === 'heading' ? { level: level || 1 } : undefined);
            closeToolbarMenus();
        } else if (action === 'align') {
            applyTextAlignment(actionButton.dataset.align || 'left');
            closeToolbarMenus();
        } else if (action === 'indent' || action === 'outdent') {
            runIndentAction(action);
        } else if (action === 'copy-blocks') {
            void copySelectedBlocks();
            closeToolbarMenus();
        } else if (action === 'cut-blocks') {
            void copySelectedBlocks({ cut: true });
            closeToolbarMenus();
        } else if (action === 'duplicate-blocks') {
            duplicateSelectedBlocks();
            closeToolbarMenus();
        } else if (action === 'delete-blocks') {
            deleteSelectedBlocks();
            closeToolbarMenus();
        } else if (action === 'move-blocks-up') {
            moveSelectedBlocks('up');
            closeToolbarMenus();
        } else if (action === 'move-blocks-down') {
            moveSelectedBlocks('down');
            closeToolbarMenus();
        } else if (action === 'toggle-heading-collapse') {
            toggleHeadingCollapse();
            closeToolbarMenus();
        }
    });

    writingToolbar.addEventListener('input', (event) => {
        const input = event.target.closest('[data-add-block-search]');
        if (!input) return;
        filterAddBlockMenu(input.closest('[data-toolbar-menu="add-block"]'));
    });

    writingToolbar.addEventListener('keydown', (event) => {
        const menu = event.target.closest('[data-toolbar-menu="add-block"]');
        if (!menu || menu.hidden) return;
        const items = visibleAddBlockItems(menu);
        if (!items.length) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveAddBlockItem(menu, addBlockActiveIndex + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveAddBlockItem(menu, addBlockActiveIndex - 1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            insertBlockFromMenu(items[addBlockActiveIndex] || items[0]);
        }
    });

    writingToolbar.addEventListener('submit', (event) => {
        const menu = event.target.closest('[data-toolbar-menu="link"]');
        if (!menu) return;
        event.preventDefault();
        applyLinkFromMenu(menu);
    });

    document.addEventListener('click', (event) => {
        if (activeToolbarMenu && !writingToolbar.contains(event.target)) {
            closeToolbarMenus();
        }
        if (urlBlockPopover && !urlBlockPopover.contains(event.target) && !writingToolbar?.contains(event.target)) {
            urlBlockResolve?.('');
            removeUrlBlockPopover();
        }
        if (!pageSetupPopover || pageSetupPopover.hidden) return;
        if (pageSetupPopover.contains(event.target) || activePageSetupTrigger?.contains(event.target)) return;
        closePageSetupDropdowns();
        closePageSetupPopover();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (activeToolbarMenu) closeToolbarMenus();
            if (pageSetupPopover && !pageSetupPopover.hidden) closePageSetupPopover({ restoreFocus: true });
            if (urlBlockPopover) {
                urlBlockResolve?.('');
                removeUrlBlockPopover();
            }
            return;
        }
        if (!editorInstance) return;
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="link"]');
            openToolbarMenu('link', trigger);
        } else if (mod && event.shiftKey && event.key.toLowerCase() === 'l') {
            event.preventDefault();
            const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="text-color"]');
            openToolbarMenu('text-color', trigger);
        } else if (mod && event.shiftKey && event.key.toLowerCase() === 'h') {
            event.preventDefault();
            const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="highlight-color"]');
            openToolbarMenu('highlight-color', trigger);
        } else if (mod && event.altKey && event.key.toLowerCase() === 'h') {
            event.preventDefault();
            toggleHeadingCollapse();
        } else if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowUp') {
            event.preventDefault();
            moveSelectedBlocks('up');
        } else if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowDown') {
            event.preventDefault();
            moveSelectedBlocks('down');
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedBlocks().length > 1) {
            event.preventDefault();
            deleteSelectedBlocks();
        }
    });

    pageSetupPopover?.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-page-setup-close]');
        if (closeButton) {
            event.preventDefault();
            closePageSetupPopover({ restoreFocus: true });
            return;
        }

        const dropdownTrigger = event.target.closest('[data-page-setup-dropdown-trigger]');
        if (dropdownTrigger) {
            event.preventDefault();
            const dropdown = dropdownTrigger.closest('[data-page-setup-dropdown]');
            const menu = dropdown?.querySelector('[data-page-setup-options]');
            const opening = menu?.hasAttribute('hidden');
            closePageSetupDropdowns(dropdown);
            if (!menu) return;
            menu.toggleAttribute('hidden', !opening);
            dropdownTrigger.setAttribute('aria-expanded', String(opening));
            return;
        }

        const scopeOption = event.target.closest('[data-page-setup-scope-option]');
        if (scopeOption) {
            event.preventDefault();
            pageSetupScope = scopeOption.dataset.pageSetupScopeOption === 'global' ? 'global' : 'note';
            closePageSetupDropdowns();
            updatePageSetupControls();
            return;
        }

        const setupOption = event.target.closest('[data-page-setup-option]');
        if (!setupOption) return;
        event.preventDefault();
        const field = setupOption.dataset.pageSetupOption;
        const input = pageSetupPopover.querySelector(`[data-page-setup-input="${field}"]`);
        if (!field || !input) return;
        input.value = setupOption.dataset.value || '';
        closePageSetupDropdowns();
        updateCurrentPageSetup(input.dataset.pageSetupInput, input.value);
    });

    pageSetupPopover?.addEventListener('input', (event) => {
        const input = event.target.closest('[data-page-setup-input="sideMargins"]');
        if (!input) return;
        updateCurrentPageSetup('sideMargins', input.value);
    });

    editorPage?.addEventListener('scroll', schedulePageSetupPopoverPosition, { passive: true });
    window.addEventListener('resize', schedulePageSetupPopoverPosition);

    toolbarOverflowController?.refresh();
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
    if (!canEdit || noteCollaborationEnabled) return;
    noteHasPendingChanges = true;
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, currentSaveDebounceMs());
}

window.addEventListener('beforeunload', (event) => {
    if (!noteHasPendingChanges) return;
    event.preventDefault();
    event.returnValue = '';
});

function handleNotesPaste({ event, editor, defaultPasteHandler }) {
    const clipboardData = event.clipboardData;
    const imageFiles = clipboardImageFiles(clipboardData);
    if (imageFiles.length) {
        event.preventDefault();
        imageFiles.forEach((file) => insertInlineImageFile(editor, file, { noteId, onChange: triggerDebouncedSave }));
        return true;
    }
    const htmlImages = clipboardHtmlImageSources(clipboardData);
    if (htmlImages.length) {
        event.preventDefault();
        htmlImages.forEach((source, index) => {
            if (/^data:/i.test(source)) {
                void dataImageFile(source, index).then((file) => insertInlineImageFile(editor, file, { noteId, onChange: triggerDebouncedSave }));
            } else {
                insertInlineImageNode(editor, { url: source, mediaId: '', clientId: `url-${Date.now()}-${index}`, alt: '', width: 240, layout: 'inline', alignment: 'left', status: 'ready', error: '' });
            }
        });
        return true;
    }
    const rawPlainText = clipboardData?.getData('text/plain') || '';
    if (clipboardData?.getData('blocknote/html')) {
        return defaultPasteHandler({
            prioritizeMarkdownOverHTML: false,
            plainTextAsMarkdown: false,
        });
    }

    const explicitMarkdown = clipboardData?.getData('text/markdown') || '';
    if (explicitMarkdown) {
        void editor.pasteMarkdown?.(normalizeClipboardMarkdown(explicitMarkdown));
        return true;
    }

    const plainText = normalizeClipboardText(rawPlainText);
    const looksStructured = clipboardTextLooksStructured(plainText);
    if (looksStructured) {
        void editor.pasteMarkdown?.(normalizeClipboardMarkdown(plainText));
        return true;
    }

    return defaultPasteHandler({
        prioritizeMarkdownOverHTML: false,
        plainTextAsMarkdown: false,
    });
}

function NotesSlashMenu(props) {
    const { items, selectedIndex, onItemClick } = props;
    return React.createElement(
        'div',
        { className: 'notes-slash-menu', role: 'listbox' },
        items.map((item, index) => React.createElement(
            'button',
            {
                key: item.key || item.label,
                type: 'button',
                className: `notes-slash-item${index === selectedIndex ? ' is-active' : ''}`,
                role: 'option',
                'aria-selected': String(index === selectedIndex),
                onMouseDown: (event) => event.preventDefault(),
                onClick: (event) => {
                    event.stopPropagation();
                    onItemClick?.(item);
                },
            },
            React.createElement('span', { className: blockIconClass(item.icon), 'aria-hidden': 'true' }, iconHtml(item.icon)),
            React.createElement('span', null,
                React.createElement('strong', null, item.label),
                React.createElement('small', null, item.description)
            )
        ))
    );
}

function NotesSideMenu(props) {
    const { block, blockDragStart, blockDragEnd, freezeMenu, unfreezeMenu } = props;
    const [open, setOpen] = React.useState(false);
    const [turnIntoOpen, setTurnIntoOpen] = React.useState(false);
    const toolsRef = React.useRef(null);
    const closeMenu = React.useCallback(() => {
        setTurnIntoOpen(false);
        setOpen(false);
    }, []);
    const selectActionBlock = React.useCallback(() => {
        if (!editorInstance || !block) return;
        safeSetBlockSelection(block, block);
    }, [block]);

    React.useEffect(() => {
        if (!open) return undefined;

        freezeMenu?.();
        const handlePointerDown = (event) => {
            if (toolsRef.current?.contains(event.target)) return;
            closeMenu();
        };
        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeMenu();
        };
        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
            unfreezeMenu?.();
        };
    }, [closeMenu, freezeMenu, open, unfreezeMenu]);

    const select = (event) => {
        event.preventDefault();
        selectBlockRange(block, event.shiftKey);
    };
    const addBelow = async (event) => {
        event.preventDefault();
        editorInstance?.setTextCursorPosition?.(block);
        await insertCatalogItem(catalogItemByKey('paragraph'), event.currentTarget.getBoundingClientRect());
    };
    const duplicate = () => {
        selectActionBlock();
        duplicateSelectedBlocks();
        closeMenu();
    };
    const remove = () => {
        selectActionBlock();
        deleteSelectedBlocks();
        closeMenu();
    };
    const turnIntoItems = filterBlockCatalog('', { includeAtoms: false, turnIntoOnly: true });
    const turnIntoMenu = turnIntoOpen ? React.createElement(
        'div',
        { className: 'notes-side-submenu' },
        turnIntoItems.map((item) => React.createElement(
            'button',
            {
                key: item.key,
                type: 'button',
                onClick: () => {
                    selectActionBlock();
                    const payload = blockPayloadForCatalogItem(item);
                    editorInstance.updateBlock(block, updateBlockPayloadForPreservedText(block, payload));
                    closeMenu();
                    updateEditorChrome();
                    triggerDebouncedSave();
                },
            },
            React.createElement('span', { className: blockIconClass(item.icon), 'aria-hidden': 'true' }, iconHtml(item.icon)),
            React.createElement('span', null, item.label)
        ))
    ) : null;
    return React.createElement(
        'div',
        {
            ref: toolsRef,
            className: 'notes-side-tools',
            onClick: (event) => event.stopPropagation(),
        },
        React.createElement('button', {
            type: 'button',
            className: 'notes-side-button',
            title: 'Add block below',
            'aria-label': 'Add block below',
            onMouseDown: (event) => event.preventDefault(),
            onClick: addBelow,
        }, materialIcon('add')),
        React.createElement('button', {
            type: 'button',
            className: 'notes-side-button notes-block-select-handle',
            title: 'Select block',
            'aria-label': 'Select block',
            draggable: true,
            onDragStart: (event) => blockDragStart?.(event, block),
            onDragEnd: blockDragEnd,
            onClick: select,
        }, materialIcon('drag_indicator')),
        React.createElement('button', {
            type: 'button',
            className: 'notes-side-button',
            title: 'Block actions',
            'aria-label': 'Block actions',
            'aria-expanded': String(open),
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => {
                if (open) {
                    closeMenu();
                } else {
                    setOpen(true);
                }
            },
        }, materialIcon('more_vert')),
        open ? React.createElement(
        'div',
        {
            className: 'notes-side-menu',
            onMouseDown: (event) => event.preventDefault(),
        },
            React.createElement('button', { type: 'button', onClick: () => { selectActionBlock(); void copySelectedBlocks(); closeMenu(); } }, materialIcon('content_copy'), React.createElement('span', null, 'Copy')),
            React.createElement('button', { type: 'button', 'aria-expanded': String(turnIntoOpen), onClick: () => setTurnIntoOpen(!turnIntoOpen) }, materialIcon('swap_vert'), React.createElement('span', null, 'Turn into')),
            turnIntoMenu,
            React.createElement('button', { type: 'button', onClick: duplicate }, materialIcon('content_copy'), React.createElement('span', null, 'Duplicate')),
            React.createElement('button', { type: 'button', onClick: () => { selectActionBlock(); moveSelectedBlocks('up'); closeMenu(); } }, materialIcon('arrow_upward'), React.createElement('span', null, 'Move up')),
            React.createElement('button', { type: 'button', onClick: () => { selectActionBlock(); moveSelectedBlocks('down'); closeMenu(); } }, materialIcon('arrow_downward'), React.createElement('span', null, 'Move down')),
            block.type === 'heading'
                ? React.createElement('button', { type: 'button', onClick: () => { selectActionBlock(); toggleHeadingCollapse(block); closeMenu(); } }, materialIcon(block.props?.isCollapsed ? 'unfold_more' : 'unfold_less'), React.createElement('span', null, 'Collapse'))
                : null,
            React.createElement('button', { type: 'button', className: 'is-danger', onClick: remove }, materialIcon('delete'), React.createElement('span', null, 'Delete'))
        ) : null
    );
}

function NoteEditor({ initialContent, initialContentWasNormalized = false, collaborationSession = null }) {
    const historyDepth = historyDepthForDocument(initialContent);
    let blockNoteEditorRef = null;
    const tiptapExtensions = [
        preserveRangeSelectionShortcuts,
        listItemHardBreakShortcuts,
        createSelectAllShortcuts(() => blockNoteEditorRef),
    ];
    if (!collaborationSession) {
        tiptapExtensions.unshift(History.configure({ depth: historyDepth, newGroupDelay: 500 }));
    }
    const editorOptions = {
        schema: notesEditorSchema,
        pasteHandler: handleNotesPaste,
        disableExtensions: ['history'],
        _tiptapOptions: {
            extensions: tiptapExtensions,
        },
        placeholders: {
            default: undefined,
            emptyDocument: "Enter text or type '/' for commands",
        },
    };
    if (collaborationSession) {
        editorOptions.collaboration = {
            fragment: collaborationSession.fragment,
            provider: collaborationSession.provider,
            user: collaborationSession.user,
            showCursorLabels: 'activity',
        };
    } else {
        editorOptions.initialContent = initialContent;
    }
    const editor = useCreateBlockNote(editorOptions);
    blockNoteEditorRef = editor;

    const getSlashItems = React.useCallback(async (query) => (
        filterBlockCatalog(query).map((item) => ({
            ...item,
            onItemClick: async () => {
                await insertCatalogItem(item, null, editor);
            },
        }))
    ), [editor]);

    React.useEffect(() => {
        editorInstance = editor;
        setNotePrintReady(true);
        editorReadyTimer = window.setTimeout(() => {
            editorReadyTimer = null;
            if (editorInstance !== editor) return;
            captureHistoryBaseline();
            invalidateDocumentSnapshot();
            const documentSnapshot = currentDocumentSnapshot();
            updateEditorChrome({ structureChanged: true, contentChanged: true, documentSnapshot });
            if (canEdit && initialContentWasNormalized && !collaborationSession) {
                triggerDebouncedSave();
            }
        }, 0);

        return () => {
            if (editorReadyTimer) {
                window.clearTimeout(editorReadyTimer);
                editorReadyTimer = null;
            }
            if (editorInstance === editor) {
                editorInstance = null;
                setNotePrintReady(false);
            }
        };
    }, [editor]);

    React.useEffect(() => {
        return bindImageRuntime({
            editor,
            editorPage,
            noteId,
            onChange: triggerDebouncedSave,
            openDialog: insertImageFromDialog,
        });
    }, [editor]);

    useEditorContentOrSelectionChange(() => {
        updateEditorChrome({ immediate: true });
    }, editor);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            editable: canEdit,
            formattingToolbar: false,
            linkToolbar: false,
            sideMenu: false,
            slashMenu: false,
            filePanel: false,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            onChange: () => {
                invalidateDocumentSnapshot();
                if (!canEdit) return;
                updateEditorChrome({ contentChanged: true });
                triggerDebouncedSave();
            },
        },
        canEdit ? React.createElement(SuggestionMenuController, {
            triggerCharacter: '/',
            getItems: getSlashItems,
            suggestionMenuComponent: NotesSlashMenu,
        }) : null,
        canEdit ? React.createElement(SideMenuController, {
            sideMenu: NotesSideMenu,
        }) : null
    );
}

async function initEditorPage() {
    if (editorPageDisposed) return;
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
        editorLoadController?.abort();
        editorLoadController = new AbortController();
        const response = await fetch(`/api/notes/${noteId}`, { signal: editorLoadController.signal });
        if (!response.ok) {
            throw new Error('Failed to fetch note');
        }
        note = await response.json();
    } catch (error) {
        if (error?.name === 'AbortError' || editorPageDisposed) return;
        console.error(error);
        renderMissingNoteState('The note may have been deleted or is unavailable.');
        return;
    } finally {
        editorLoadController = null;
    }

    if (editorPageDisposed) return;

    const noteTitle = typeof note?.title === 'string' ? note.title : '';
    titleInput.value = noteTitle;
    if (shareButton) shareButton.dataset.resourceTitle = noteTitle || 'Untitled';
    notePageSetup = normalizePageSetup(note?.page_setup);
    globalPageSetup = normalizePageSetup(note?.global_page_setup);
    applyPageSetupVariables();
    updatePageSetupControls();
    noteCollaborationEnabled = note?.collaboration_enabled === true;
    if (note?.updated_at) {
        setSaveStatus('saved', { savedAt: note.updated_at });
    }
    if (typeof note?.content === 'string') {
        lastSavedPayloadFingerprint = notePayloadFingerprint(noteTitle, note.content);
    }

    if (noteCollaborationEnabled) {
        setSaveStatus('connecting');
        try {
            const { createNoteCollaborationSession } = await import('./editor/collaboration.js');
            activeCollaborationSession = await createNoteCollaborationSession({
                noteId,
                access: note?.access || noteContext.access,
                presenceRoot: collaboratorsRoot,
                onStatus: (status) => setSaveStatus(status),
            });
            activeCollaborativeTitleCleanup = bindCollaborativeTitle(activeCollaborationSession, noteTitle);
        } catch (error) {
            console.error('Failed to connect note collaboration', error);
            activeCollaborationSession = null;
            setEditorReadOnlyMode(true);
            setSaveStatus('offline-readonly');
        }
    }
    bindLazyReviewPanel({
        canReview: note?.access?.can_review === true,
        canManageReviews: note?.access?.can_manage_reviews === true,
        canViewVersions: note?.access?.can_edit === true,
    });

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

    noteEditorReactRoot = createRoot(rootElement);

    try {
        noteEditorReactRoot.render(React.createElement(NoteEditor, {
            initialContent: parsedContent,
            initialContentWasNormalized: parsedContentWasNormalized,
            collaborationSession: activeCollaborationSession,
        }));
        if (canEdit) bindWritingToolbar();
    } catch (error) {
        console.error('Failed to mount note editor', error);
        setSaveStatus('error');
    }

    if (canEdit) {
        titleInput.addEventListener('input', () => {
            triggerDebouncedSave();
        });
        titleInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            focusEditorBody();
        });
    }
    rootElement.addEventListener('click', (event) => {
        if (!canEdit) return;
        const collapseButton = event.target.closest('.notes-heading-collapse-toggle');
        if (collapseButton) {
            event.preventDefault();
            event.stopPropagation();
            const blockId = collapseButton.closest('.bn-block-outer[data-id]')?.dataset.id;
            const block = blockId ? editorInstance?.getBlock?.(blockId) : null;
            toggleHeadingCollapse(block);
            return;
        }
        focusEditorBody();
    });
    rootElement.addEventListener('copy', normalizeNativeEditorCopy);
    rootElement.addEventListener('cut', normalizeNativeEditorCopy);
    editorInitialFocusTimer = window.setTimeout(() => {
        editorInitialFocusTimer = null;
        if (editorPageDisposed) return;
        const isNewBlankNote = isBlankTitle(noteTitle) && !documentHasText(parsedContent);
        const documentSnapshot = currentDocumentSnapshot();
        updateEditorChrome({ structureChanged: true, contentChanged: true, documentSnapshot });
        if (!canEdit || !isNewBlankNote) return;
        titleInput.focus({ preventScroll: true });
        titleInput.select();
    }, 0);
}

function clearEditorTimersAndFrames() {
    if (saveDebounceTimer) window.clearTimeout(saveDebounceTimer);
    if (pageSetupSaveTimer) window.clearTimeout(pageSetupSaveTimer);
    if (editorChromeThrottleTimer) window.clearTimeout(editorChromeThrottleTimer);
    if (editorReadyTimer) window.clearTimeout(editorReadyTimer);
    if (editorInitialFocusTimer) window.clearTimeout(editorInitialFocusTimer);
    if (pageSetupPositionRafId) window.cancelAnimationFrame(pageSetupPositionRafId);
    if (editorChromeRafId) window.cancelAnimationFrame(editorChromeRafId);
    saveDebounceTimer = null;
    pageSetupSaveTimer = null;
    editorChromeThrottleTimer = null;
    editorReadyTimer = null;
    editorInitialFocusTimer = null;
    pageSetupPositionRafId = null;
    editorChromeRafId = null;
    clearSavedTimeRefresh();
}

function releaseNoteEditorRuntime() {
    if (editorPageDisposed) return;
    editorPageDisposed = true;
    editorLoadController?.abort();
    editorLoadController = null;
    clearEditorTimersAndFrames();
    toolbarOverflowController?.disconnect();
    toolbarOverflowController = null;
    closeToolbarMenus();
    closePageSetupPopover();
    closePageSetupDropdowns();
    removeUrlBlockPopover();
    activeCollaborativeTitleCleanup?.();
    activeCollaborativeTitleCleanup = null;
    activeCollaborationSession?.destroy?.();
    activeCollaborationSession = null;
    reviewPanelBootstrapCleanup?.();
    reviewPanelBootstrapCleanup = null;
    reviewPanelController?.close?.();
    reviewPanelController = null;
    document.removeEventListener('click', handleNotePrintClick, true);
    document.removeEventListener('keydown', handleNotePrintShortcut, true);
    noteEditorReactRoot?.unmount();
    noteEditorReactRoot = null;
    editorInstance = null;
    latestDocumentSnapshot = null;
    editorChromeSyncSnapshot = null;
    lastSelectedBlockIds.clear();
    setNotePrintReady(false);
}

const NOTES_EDITOR_RUNTIME_KEY = Symbol.for('apstudy.notes.editor.runtime');

if (!window[NOTES_EDITOR_RUNTIME_KEY]) {
    window[NOTES_EDITOR_RUNTIME_KEY] = true;

    window.APStudyPageLifecycle?.register?.({
        pause: releaseNoteEditorRuntime,
        resume() {
            // Browser Back can still place the editor in bfcache. Restore it from a
            // fresh document after releasing the retained BlockNote heap.
            window.location.reload();
        },
        dispose: releaseNoteEditorRuntime,
    });

    saveRetry?.addEventListener('click', () => {
        void saveNote();
    });

    bindNotePrintControls();
    zoomIndex = loadStoredZoomIndex();
    applyEditorZoom();
    initEditorPage();
}
