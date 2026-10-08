import { positionFloatingElement } from './utils.js';

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
export const PAGE_SETUP_FONT_TYPES = {
    default: 'var(--font-body)',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    display: 'var(--font-display)',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'var(--font-mono)',
};
const PAGE_SETUP_MARGIN_MIN = 2;
const PAGE_SETUP_MARGIN_MAX = 18;

export function createPageSetupRuntime({
    noteId,
    editorPage,
    pageSetupPopover,
    zoomValue,
    pageSetupScopeInput,
    sideMarginsValue,
    getCanEdit,
    getNoteCollaborationEnabled,
    setSaveStatus,
    closeToolbarMenus,
    updateToolbarState,
    refreshToolbar,
}) {
    let zoomIndex = DEFAULT_ZOOM_INDEX;
    let notePageSetup = {};
    let globalPageSetup = {};
    let pageSetupScope = 'note';
    let activePageSetupTrigger = null;
    let activePageSetupTriggerRect = null;
    let pageSetupSaveTimer = null;
    let pageSetupPositionRafId = null;
    let defaultSideMarginPercent = null;
    let bound = false;
    let disposed = false;
    let pageSetupSaveTask = null;
    let pageSetupSaveController = null;
    const pageSetupVersions = { note: 0, global: 0 };
    const dirtyPageSetupScopes = new Set();
    const requestedPageSetupScopes = new Set();
    const bindingsController = new AbortController();

    function clampZoomIndex(index) {
        return Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
    }

    function loadStoredZoomIndex() {
        try {
            const stored = Number(window.localStorage?.getItem(ZOOM_STORAGE_KEY));
            const index = ZOOM_LEVELS.findIndex((level) => Math.round(level * 100) === stored);
            return index >= 0 ? index : DEFAULT_ZOOM_INDEX;
        } catch {
            return DEFAULT_ZOOM_INDEX;
        }
    }

    function storeZoomLevel(level) {
        try {
            window.localStorage?.setItem(ZOOM_STORAGE_KEY, String(Math.round(level * 100)));
        } catch {
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
        if (disposed || !pageSetupPopover || pageSetupPopover.hidden || pageSetupPositionRafId) return;
        pageSetupPositionRafId = window.requestAnimationFrame(() => {
            pageSetupPositionRafId = null;
            positionPageSetupPopover(activePageSetupTrigger, activePageSetupTriggerRect);
        });
    }

    function openPageSetupPopover(trigger, triggerRect = null) {
        if (disposed || !pageSetupPopover) return;
        closeToolbarMenus?.();
        activePageSetupTrigger = trigger || null;
        activePageSetupTriggerRect = triggerRect || usableTriggerRect(trigger);
        pageSetupPopover.hidden = false;
        activePageSetupTrigger?.setAttribute('aria-expanded', 'true');
        updatePageSetupControls();
        positionPageSetupPopover(activePageSetupTrigger, activePageSetupTriggerRect);
        window.requestAnimationFrame(() => {
            if (disposed || pageSetupPopover.hidden) return;
            pageSetupPopover.querySelector('[data-page-setup-dropdown-trigger]')?.focus({ preventScroll: true });
        });
    }

    function canSaveScope(scope) {
        return !disposed && getCanEdit() && (scope === 'global' || (noteId && !getNoteCollaborationEnabled()));
    }

    async function saveRequestedPageSetup() {
        while (requestedPageSetupScopes.size && !disposed) {
            const scope = requestedPageSetupScopes.values().next().value;
            requestedPageSetupScopes.delete(scope);
            if (!canSaveScope(scope)) continue;
            const versions = { ...pageSetupVersions };
            const global = scope === 'global';
            const controller = new AbortController();
            pageSetupSaveController = controller;
            try {
                const request = fetch(global ? '/settings/api/notes-page-setup' : `/api/notes/${noteId}`, {
                    method: global ? 'POST' : 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(global ? { page_setup: globalPageSetup } : { page_setup_json: notePageSetup }),
                    signal: controller.signal,
                });
                const response = await (window.APStudyPendingMutations?.track(request, 'notes-page-setup') ?? request);
                if (disposed) return;
                if (!response.ok) throw new Error('Page setup save failed');
                const updated = await response.json();
                if (disposed) return;
                const savedSetup = global ? updated?.notes_page_setup : updated?.page_setup;
                if (!savedSetup || typeof savedSetup !== 'object' || Array.isArray(savedSetup)) {
                    throw new Error('Invalid page setup response');
                }
                if (!global && versions.note === pageSetupVersions.note) {
                    notePageSetup = normalizePageSetup(savedSetup);
                }
                if (versions.global === pageSetupVersions.global
                    && (global || !dirtyPageSetupScopes.has('global'))) {
                    globalPageSetup = normalizePageSetup(global ? updated?.notes_page_setup : updated?.global_page_setup);
                }
                if (versions[scope] === pageSetupVersions[scope]) dirtyPageSetupScopes.delete(scope);
                applyPageSetupVariables();
                updatePageSetupControls();
            } catch (error) {
                if (disposed) return;
                console.error(error);
                setSaveStatus('error', { message: 'Page setup save failed' });
            } finally {
                if (pageSetupSaveController === controller) pageSetupSaveController = null;
            }
        }
    }

    function savePageSetup() {
        if (disposed) return Promise.resolve();
        for (const scope of dirtyPageSetupScopes) {
            if (canSaveScope(scope)) requestedPageSetupScopes.add(scope);
        }
        if (!pageSetupSaveTask) {
            pageSetupSaveTask = saveRequestedPageSetup().finally(() => {
                pageSetupSaveTask = null;
                if (requestedPageSetupScopes.size && !disposed) return savePageSetup();
            });
        }
        return pageSetupSaveTask;
    }

    function schedulePageSetupSave() {
        if (disposed || !getCanEdit()) return;
        if (pageSetupSaveTimer) clearTimeout(pageSetupSaveTimer);
        pageSetupSaveTimer = window.setTimeout(() => {
            pageSetupSaveTimer = null;
            void savePageSetup();
        }, PAGE_SETUP_SAVE_DEBOUNCE_MS);
    }

    function updateCurrentPageSetup(key, value) {
        if (!canSaveScope(pageSetupScope)) return;
        const nextValue = key === 'sideMargins' ? clampSideMargins(value) : value;
        if (pageSetupScope === 'global') {
            globalPageSetup = normalizePageSetup({ ...globalPageSetup, [key]: nextValue });
        } else {
            notePageSetup = normalizePageSetup({ ...notePageSetup, [key]: nextValue });
        }
        pageSetupVersions[pageSetupScope] += 1;
        dirtyPageSetupScopes.add(pageSetupScope);
        applyPageSetupVariables();
        updatePageSetupControls();
        schedulePageSetupSave();
    }

    function setZoomIndex(nextIndex) {
        const clamped = clampZoomIndex(nextIndex);
        if (clamped === zoomIndex) return;
        zoomIndex = clamped;
        applyEditorZoom({ persist: true });
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
        updateToolbarState?.();
        refreshToolbar?.();
    }

    function bind() {
        if (disposed || bound) return;
        bound = true;

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
        }, { signal: bindingsController.signal });

        pageSetupPopover?.addEventListener('input', (event) => {
            const input = event.target.closest('[data-page-setup-input="sideMargins"]');
            if (!input) return;
            updateCurrentPageSetup('sideMargins', input.value);
        }, { signal: bindingsController.signal });

        editorPage?.addEventListener('scroll', schedulePageSetupPopoverPosition, { passive: true, signal: bindingsController.signal });
        window.addEventListener('resize', schedulePageSetupPopoverPosition, { signal: bindingsController.signal });
    }

    function clearTimers() {
        if (pageSetupSaveTimer) window.clearTimeout(pageSetupSaveTimer);
        if (pageSetupPositionRafId) window.cancelAnimationFrame(pageSetupPositionRafId);
        pageSetupSaveTimer = null;
        pageSetupPositionRafId = null;
    }

    function setLoadedPageSetup(noteSetup, globalSetup) {
        if (disposed) return;
        notePageSetup = normalizePageSetup(noteSetup);
        globalPageSetup = normalizePageSetup(globalSetup);
        applyPageSetupVariables();
        updatePageSetupControls();
    }

    function warnBeforeUnload(event) {
        if (!dirtyPageSetupScopes.size) return;
        event.preventDefault();
        event.returnValue = '';
    }

    window.addEventListener('beforeunload', warnBeforeUnload);

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearTimers();
        requestedPageSetupScopes.clear();
        pageSetupSaveController?.abort();
        bindingsController.abort();
        window.removeEventListener('beforeunload', warnBeforeUnload);
    }

    function setInitialZoom() {
        zoomIndex = loadStoredZoomIndex();
        applyEditorZoom();
    }

    return {
        applyEditorZoom,
        bind,
        clearPageSetupDropdowns: closePageSetupDropdowns,
        clearTimers,
        dispose,
        closePageSetupPopover,
        effectivePageSetup,
        getPageSetupFontFamily: () => PAGE_SETUP_FONT_TYPES[effectivePageSetup().fontType] || PAGE_SETUP_FONT_TYPES.default,
        getActivePageSetupTrigger: () => activePageSetupTrigger,
        getZoomIndex: () => zoomIndex,
        getZoomLevels: () => ZOOM_LEVELS,
        openPageSetupPopover,
        schedulePageSetupPopoverPosition,
        setInitialZoom,
        setLoadedPageSetup,
        savePageSetup,
        setZoomIndex,
        updatePageSetupControls,
    };
}
