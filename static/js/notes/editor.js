import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { useCreateBlockNote, useEditorContentOrSelectionChange } from '@blocknote/react';
import { checkBlockHasDefaultProp, checkBlockTypeHasDefaultProp, mapTableCell } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { notesEditorSchema } from './toolbar.js';
import { blockOwnContentIsEmpty, buildLoadingIndicatorHtml, documentHasText, formatRelativeSavedTime, isBlankTitle, noteIdFromPath, parseSavedDate } from './editor/utils.js';

const noteId = noteIdFromPath();
const SAVE_DEBOUNCE_MS = 800;
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
const MAX_INDENT_LEVEL = 4;
const TEXT_BLOCK_OPTIONS = [
    { label: 'Paragraph', type: 'paragraph', icon: 'subject', key: 'paragraph' },
    { label: 'Heading 1', type: 'heading', props: { level: 1 }, icon: 'H1', key: 'heading-1' },
    { label: 'Heading 2', type: 'heading', props: { level: 2 }, icon: 'H2', key: 'heading-2' },
    { label: 'Heading 3', type: 'heading', props: { level: 3 }, icon: 'H3', key: 'heading-3' },
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
let pageSetupSaveTimer = null;
let addBlockActiveIndex = 0;
let defaultSideMarginPercent = null;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');
const saveRetry = document.getElementById('save-retry');
const blocknoteRoot = document.getElementById('blocknote-root');
const writingToolbar = document.getElementById('notes-writing-toolbar');
const editorHint = document.getElementById('notes-editor-hint');
const editorPage = document.getElementById('editor-page');
const zoomValue = document.getElementById('notes-zoom-value');
const pageSetupPopover = document.getElementById('notes-page-setup-popover');
const pageSetupScopeInput = document.querySelector('[data-page-setup-scope]');
const sideMarginsValue = document.getElementById('notes-side-margins-value');

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

function isBlockStyleSelected(block, option) {
    if (!block || block.type !== option.type) return false;
    if (!option.props) return true;
    return Object.entries(option.props).every(([key, value]) => block.props?.[key] === value);
}

function getSelectedTextAlignment() {
    if (!editorInstance) return 'left';
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

function closePageSetupPopover() {
    if (!pageSetupPopover) return;
    pageSetupPopover.hidden = true;
    closePageSetupDropdowns();
    writingToolbar?.querySelector('[data-editor-action="page-setup"]')?.setAttribute('aria-expanded', 'false');
}

function positionPageSetupPopover(trigger) {
    if (!pageSetupPopover || !trigger) return;
    pageSetupPopover.style.removeProperty('left');
    pageSetupPopover.style.removeProperty('top');
}

function openPageSetupPopover(trigger) {
    if (!pageSetupPopover) return;
    const opening = pageSetupPopover.hidden;
    closeToolbarMenus();
    if (!opening) {
        closePageSetupPopover();
        return;
    }
    pageSetupPopover.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');
    updatePageSetupControls();
    positionPageSetupPopover(trigger);
}

async function saveNotePageSetup() {
    if (!noteId) return;
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

function positionToolbarMenu(trigger, menu, triggerRectOverride = null) {
    if (!trigger || !menu) return;
    const triggerRect = triggerRectOverride || trigger.getBoundingClientRect();
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.minWidth = `${Math.max(triggerRect.width, 150)}px`;

    const editorRect = editorPage?.getBoundingClientRect();
    const viewportRight = window.innerWidth - 8;
    const boundaryRight = Math.min(viewportRight, editorRect ? editorRect.right - 8 : viewportRight);
    const menuRect = menu.getBoundingClientRect();
    let left = triggerRect.left;

    if (left + menuRect.width > boundaryRight) {
        left = triggerRect.right - menuRect.width;
    }

    left = Math.max(8, left);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(triggerRect.bottom + 6)}px`;
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
    }

    positionToolbarMenu(trigger, menu, triggerRect);
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
    menu?.querySelectorAll('.notes-add-block-item').forEach((item) => {
        const text = item.textContent.toLowerCase();
        item.hidden = Boolean(query && !text.includes(query));
    });
    setActiveAddBlockItem(menu, 0);
}

function prepareAddBlockMenu(menu) {
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

function blockPropsFromDataset(button) {
    const type = button?.dataset.blockType || 'paragraph';
    if (type === 'heading') {
        return { level: Number(button.dataset.level) || 1, indentLevel: 0 };
    }
    if (type === 'codeBlock') {
        return { language: '' };
    }
    return undefined;
}

function insertBlockFromMenu(button) {
    if (!editorInstance) return;

    const currentBlock = getCurrentBlock();
    if (!currentBlock) {
        focusEditorBody();
        return;
    }

    const type = button?.dataset.blockType || 'paragraph';
    const props = blockPropsFromDataset(button);
    const block = { type };
    if (props) block.props = props;

    if (blockOwnContentIsEmpty(currentBlock)) {
        editorInstance.updateBlock(currentBlock, block);
        editorInstance.setTextCursorPosition?.(currentBlock);
        closeToolbarMenus();
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
        return;
    }

    const insertedBlock = editorInstance.insertBlocks?.(
        [block],
        currentBlock,
        'after'
    )?.[0];

    if (insertedBlock) editorInstance.setTextCursorPosition?.(insertedBlock);
    closeToolbarMenus();
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

function selectedBlocks() {
    if (!editorInstance) return [];
    return editorInstance.getSelection?.()?.blocks || [editorInstance.getTextCursorPosition?.()?.block].filter(Boolean);
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
        } else if (action === 'undo' || action === 'redo') {
            disabled = !canRunHistoryAction(action);
        } else if (action === 'indent' || action === 'outdent') {
            disabled = !canRunIndentAction(action);
        } else if (action === 'zoom-out') {
            disabled = zoomIndex === 0;
        } else if (action === 'zoom-in') {
            disabled = zoomIndex === ZOOM_LEVELS.length - 1;
        }
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
    });

    writingToolbar.querySelectorAll('[data-menu-check]').forEach((item) => {
        const key = item.dataset.menuCheck;
        const checked = key === activeBlockOption.key || key === activeListOption?.key || key === activeAlignment.key;
        item.classList.toggle('is-active', checked);
        item.setAttribute('aria-checked', String(checked));
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

        const actionButton = event.target.closest('button[data-editor-action]');
        if (!actionButton || !writingToolbar.contains(actionButton)) return;
        event.preventDefault();

        const action = actionButton.dataset.editorAction;
        if (action === 'page-setup') {
            openPageSetupPopover(actionButton);
        } else if (action === 'focus-body') {
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
        if (!pageSetupPopover || pageSetupPopover.hidden) return;
        const trigger = writingToolbar.querySelector('[data-editor-action="page-setup"]');
        if (pageSetupPopover.contains(event.target) || trigger?.contains(event.target)) return;
        closePageSetupDropdowns();
        closePageSetupPopover();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (activeToolbarMenu) closeToolbarMenus();
        if (pageSetupPopover && !pageSetupPopover.hidden) closePageSetupPopover();
    });

    pageSetupPopover?.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-page-setup-close]');
        if (closeButton) {
            event.preventDefault();
            closePageSetupPopover();
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
                updateEditorChrome();
                triggerDebouncedSave();
            },
        }
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
    notePageSetup = normalizePageSetup(note?.page_setup);
    globalPageSetup = normalizePageSetup(note?.global_page_setup);
    applyPageSetupVariables();
    updatePageSetupControls();
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

zoomIndex = loadStoredZoomIndex();
applyEditorZoom();
initEditorPage();
