import {
    DEFAULT_ZOOM_INDEX,
    PAGE_SETUP_COLORS,
    PAGE_SETUP_DEFAULTS,
    PAGE_SETUP_FONT_TYPES,
    PAGE_SETUP_MARGIN_MAX,
    PAGE_SETUP_MARGIN_MIN,
    PAGE_SETUP_SAVE_DEBOUNCE_MS,
    ZOOM_LEVELS,
    ZOOM_STORAGE_KEY,
    checkBlockHasDefaultProp,
    checkBlockTypeHasDefaultProp,
    editorPage,
    editorState,
    mapTableCell,
    noteId,
    pageSetupPopover,
    pageSetupScopeInput,
    sideMarginsValue,
    writingToolbar,
    zoomValue,
} from './runtime.js';
import {
    closeToolbarMenus,
} from './toolbar-menus.js';
import {
    setSaveStatus,
} from './save.js';
import {
    selectedBlocks,
    updateEditorChrome,
    updateToolbarState,
} from './editing.js';
import {
    triggerDebouncedSave,
} from './document.js';

export function clampZoomIndex(index) {
    return Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
}

export function loadStoredZoomIndex() {
    try {
        const stored = Number(window.localStorage?.getItem(ZOOM_STORAGE_KEY));
        const index = ZOOM_LEVELS.findIndex((level) => Math.round(level * 100) === stored);
        return index >= 0 ? index : DEFAULT_ZOOM_INDEX;
    } catch (error) {
        return DEFAULT_ZOOM_INDEX;
    }
}

export function storeZoomLevel(level) {
    try {
        window.localStorage?.setItem(ZOOM_STORAGE_KEY, String(Math.round(level * 100)));
    } catch (error) {
        // localStorage can be unavailable in private or restricted contexts.
    }
}

export function clampSideMargins(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultSideMargins();
    return Math.min(PAGE_SETUP_MARGIN_MAX, Math.max(PAGE_SETUP_MARGIN_MIN, Math.round(numeric)));
}

export function defaultSideMargins() {
    if (editorState.defaultSideMarginPercent !== null) return editorState.defaultSideMarginPercent;
    if (!editorPage) return 10;
    const rawValue = getComputedStyle(editorPage).getPropertyValue('--notes-page-side-margin').trim();
    const parsed = Number.parseFloat(rawValue);
    editorState.defaultSideMarginPercent = Number.isFinite(parsed) ? Math.round(parsed) : 10;
    return editorState.defaultSideMarginPercent;
}

export function normalizePageSetup(value) {
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

export function effectivePageSetup() {
    return normalizePageSetup({
        ...PAGE_SETUP_DEFAULTS,
        ...editorState.globalPageSetup,
        ...editorState.notePageSetup,
    });
}

export function setupForCurrentScope() {
    return editorState.pageSetupScope === 'global'
        ? normalizePageSetup({ ...PAGE_SETUP_DEFAULTS, ...editorState.globalPageSetup })
        : effectivePageSetup();
}

export function applyPageSetupVariables() {
    const setup = effectivePageSetup();
    const zoom = ZOOM_LEVELS[editorState.zoomIndex] || ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
    const zoomReduction = Math.max(0, Math.round((zoom - 1) * 12));
    const marginPercent = Math.max(PAGE_SETUP_MARGIN_MIN, clampSideMargins(setup.sideMargins) - zoomReduction);
    const paddingMax = zoom > 1 ? Math.max(30, Math.round(96 - (zoom - 1) * 96)) : 96;

    editorPage?.style.setProperty('--notes-page-setup-bg', PAGE_SETUP_COLORS[setup.pageColor] || PAGE_SETUP_COLORS.default);
    editorPage?.style.setProperty('--notes-page-font-family', PAGE_SETUP_FONT_TYPES[setup.fontType] || PAGE_SETUP_FONT_TYPES.default);
    editorPage?.style.setProperty('--notes-page-side-margin', `${marginPercent}%`);
    editorPage?.style.setProperty('--notes-editor-padding-max', `${paddingMax}px`);
}

export function closePageSetupDropdowns(except = null) {
    pageSetupPopover?.querySelectorAll('[data-page-setup-dropdown]').forEach((dropdown) => {
        if (dropdown === except) return;
        dropdown.querySelector('[data-page-setup-options]')?.setAttribute('hidden', '');
        dropdown.querySelector('[data-page-setup-dropdown-trigger]')?.setAttribute('aria-expanded', 'false');
    });
}

export function syncPageSetupDropdown(dropdown, value) {
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

export function updatePageSetupControls() {
    if (!pageSetupPopover) return;
    const setup = setupForCurrentScope();
    if (pageSetupScopeInput) {
        pageSetupScopeInput.value = editorState.pageSetupScope;
        syncPageSetupDropdown(pageSetupScopeInput.closest('.notes-setup-field')?.querySelector('[data-page-setup-dropdown]'), editorState.pageSetupScope);
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

export function applyEditorZoom({ persist = false } = {}) {
    const zoom = ZOOM_LEVELS[editorState.zoomIndex] || ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
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
    editorState.toolbarOverflowController?.refresh();
}

export function setZoomIndex(nextIndex) {
    const clamped = clampZoomIndex(nextIndex);
    if (clamped === editorState.zoomIndex) return;
    editorState.zoomIndex = clamped;
    applyEditorZoom({ persist: true });
}

export function iconHtml(icon) {
    if (!icon) return '';
    if (icon.startsWith?.('H')) {
        return icon;
    }
    return icon;
}

export function isBlockStyleSelected(block, option) {
    if (!block || block.type !== option.type) return false;
    if (!option.props) return true;
    return Object.entries(option.props).every(([key, value]) => block.props?.[key] === value);
}

export function getSelectedTextAlignment() {
    if (!editorState.editorInstance) return 'left';
    const blocks = selectedBlocks();
    const block = blocks[0];
    if (!block) return 'left';

    if (checkBlockHasDefaultProp('textAlignment', block, editorState.editorInstance)) {
        return block.props.textAlignment || 'left';
    }

    if (block.type === 'table') {
        const cellSelection = editorState.editorInstance.tableHandles?.getCellSelection();
        if (!cellSelection) return 'left';

        const alignments = cellSelection.cells.map(({ row, col }) => (
            mapTableCell(block.content.rows[row].cells[col]).props.textAlignment
        ));
        const firstAlignment = alignments[0];
        return alignments.every((alignment) => alignment === firstAlignment) ? firstAlignment || 'left' : 'left';
    }

    return 'left';
}

export function applyTextAlignment(textAlignment) {
    if (!editorState.editorInstance) return;
    editorState.editorInstance.focus();

    selectedBlocks().forEach((block) => {
        if (checkBlockTypeHasDefaultProp('textAlignment', block.type, editorState.editorInstance)) {
            editorState.editorInstance.updateBlock(block, { props: { ...block.props, textAlignment } });
            return;
        }

        if (block.type !== 'table') return;
        const cellSelection = editorState.editorInstance.tableHandles?.getCellSelection();
        if (!cellSelection) return;

        const newTable = block.content.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => mapTableCell(cell)),
        }));

        cellSelection.cells.forEach(({ row, col }) => {
            newTable[row].cells[col].props.textAlignment = textAlignment;
        });

        editorState.editorInstance.updateBlock(block, {
            type: 'table',
            content: {
                ...block.content,
                type: 'tableContent',
                rows: newTable,
            },
        });
        editorState.editorInstance.setTextCursorPosition(block);
    });

    updateEditorChrome();
    triggerDebouncedSave();
}

export function closePageSetupPopover() {
    if (!pageSetupPopover) return;
    pageSetupPopover.hidden = true;
    closePageSetupDropdowns();
    writingToolbar?.querySelector('[data-editor-action="page-setup"]')?.setAttribute('aria-expanded', 'false');
}

export function positionPageSetupPopover(trigger) {
    if (!pageSetupPopover || !trigger) return;
    pageSetupPopover.style.removeProperty('left');
    pageSetupPopover.style.removeProperty('top');
}

export function openPageSetupPopover(trigger) {
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

export async function saveNotePageSetup() {
    if (!noteId) return;
    try {
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup_json: editorState.notePageSetup }),
        }), 'notes-page-setup') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup_json: editorState.notePageSetup }),
        }));
        if (!response.ok) throw new Error('Page setup save failed');
        const updated = await response.json();
        editorState.notePageSetup = normalizePageSetup(updated?.page_setup);
        editorState.globalPageSetup = normalizePageSetup(updated?.global_page_setup);
        applyPageSetupVariables();
        updatePageSetupControls();
    } catch (error) {
        console.error(error);
        setSaveStatus('error', { message: 'Page setup save failed' });
    }
}

export async function saveGlobalPageSetup() {
    try {
        const response = await (window.APStudyPendingMutations?.track(fetch('/settings/api/notes-page-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup: editorState.globalPageSetup }),
        }), 'notes-page-setup') || fetch('/settings/api/notes-page-setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_setup: editorState.globalPageSetup }),
        }));
        if (!response.ok) throw new Error('Global page setup save failed');
        const updated = await response.json();
        editorState.globalPageSetup = normalizePageSetup(updated?.notes_page_setup);
        applyPageSetupVariables();
        updatePageSetupControls();
    } catch (error) {
        console.error(error);
        setSaveStatus('error', { message: 'Page setup save failed' });
    }
}

export function schedulePageSetupSave() {
    if (editorState.pageSetupSaveTimer) clearTimeout(editorState.pageSetupSaveTimer);
    editorState.pageSetupSaveTimer = window.setTimeout(() => {
        if (editorState.pageSetupScope === 'global') {
            void saveGlobalPageSetup();
        } else {
            void saveNotePageSetup();
        }
    }, PAGE_SETUP_SAVE_DEBOUNCE_MS);
}

export function updateCurrentPageSetup(key, value) {
    const nextValue = key === 'sideMargins' ? clampSideMargins(value) : value;
    if (editorState.pageSetupScope === 'global') {
        editorState.globalPageSetup = normalizePageSetup({ ...editorState.globalPageSetup, [key]: nextValue });
    } else {
        editorState.notePageSetup = normalizePageSetup({ ...editorState.notePageSetup, [key]: nextValue });
    }
    applyPageSetupVariables();
    updatePageSetupControls();
    schedulePageSetupSave();
}
