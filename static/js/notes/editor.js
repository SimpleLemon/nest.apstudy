import { noteIdFromPath } from './editor/utils.js';
import { bindImageRuntime } from './editor/image-runtime.js';
import { createNoteSaveRuntime, notePayloadFingerprint } from './editor/save.js';
import { createPageSetupRuntime } from './editor/page-setup.js';
import { createReactShell } from './editor/react-shell.js';
import { createNotesMenuComponents } from './editor/menu-components.js';
import { blockPayloadForCatalogItem, catalogItemByKey } from './editor/block-catalog.js';
import { createToolbarDom } from './editor/toolbar-dom.js';
import { createDocumentState } from './editor/document-state.js';
import { createSelectionActions } from './editor/selection-actions.js';
import { createStyleActions } from './editor/style-actions.js';
import { createHistoryActions } from './editor/history-actions.js';
import { createCatalogActions } from './editor/catalog-actions.js';
import { createEditorChrome } from './editor/editor-chrome.js';
import { createPrintRuntime } from './editor/print-runtime.js';
import { createReviewRuntime } from './editor/review/review-runtime.js';
import { bindCollaborativeTitle } from './editor/collaboration/collaborative-title.js';
import { isBlockStyleSelected, updateBlockPayloadForPreservedText } from './editor/block-properties.js';

const noteContext = window.APSTUDY_NOTE_CONTEXT || {};
const noteId = noteContext.noteId || noteIdFromPath();
let canEdit = noteContext.access?.can_edit === true;
let editorInstance = null;
let editorPageDisposed = false;
let noteCollaborationEnabled = false;
let saveRuntime = null;
let pageSetupRuntime = null;
let toolbarDom = null;
let reactShell = null;
let catalogActions = null;
let editorChrome = null;
let printRuntime = null;
let reviewRuntime = null;

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

const getEditor = () => editorInstance;
const documentState = createDocumentState({ getEditor });
const { currentDocumentSnapshot, invalidateDocumentSnapshot, editorTopLevelBlockCount } = documentState;
const closeToolbarMenus = () => toolbarDom?.closeToolbarMenus();
const updateToolbarState = () => toolbarDom?.updateToolbarState();
const setSaveStatus = (status, options = {}) => saveRuntime?.setSaveStatus(status, options);
const triggerDebouncedSave = () => saveRuntime?.triggerDebouncedSave();
const updateEditorChrome = (options) => editorChrome?.updateEditorChrome(options);
const closePageSetupPopover = (options = {}) => pageSetupRuntime?.closePageSetupPopover(options);

function setEditorReadOnlyMode(readOnly) {
    canEdit = !readOnly && noteContext.access?.can_edit === true;
    document.body.dataset.noteReadOnly = canEdit ? 'false' : 'true';
    if (editorInstance) editorInstance.isEditable = canEdit;
    if (titleInput) {
        titleInput.readOnly = !canEdit;
        titleInput.setAttribute('aria-readonly', canEdit ? 'false' : 'true');
    }
    if (writingToolbar) writingToolbar.hidden = !canEdit;
    if (!canEdit) {
        closeToolbarMenus();
        closePageSetupPopover();
    } else {
        toolbarDom?.bindWritingToolbar();
    }
    updateToolbarState();
}

function initializeEditorRuntimes() {
    if (saveRuntime) return;

    saveRuntime = createNoteSaveRuntime({
        noteId,
        titleInput,
        saveStatus,
        saveRetry,
        getCanEdit: () => canEdit,
        getEditor: () => editorInstance,
        getNoteCollaborationEnabled: () => noteCollaborationEnabled,
        getCurrentDocumentSnapshot: currentDocumentSnapshot,
        getTopLevelBlockCount: editorTopLevelBlockCount,
    });

    pageSetupRuntime = createPageSetupRuntime({
        noteId,
        editorPage,
        pageSetupPopover,
        zoomValue,
        pageSetupScopeInput,
        sideMarginsValue,
        getCanEdit: () => canEdit,
        getNoteCollaborationEnabled: () => noteCollaborationEnabled,
        setSaveStatus,
        closeToolbarMenus,
        updateToolbarState,
        refreshToolbar: () => toolbarDom?.refresh(),
    });

    const {
        focusEditorBody, selectedBlocks, safeSetBlockSelection, selectBlockRange,
        copySelectedBlocks, duplicateSelectedBlocks, deleteSelectedBlocks,
        moveSelectedBlocks, toggleHeadingCollapse, selectedBlockIds,
    } = createSelectionActions({ getEditor, getCanEdit: () => canEdit, updateEditorChrome, triggerDebouncedSave });

    const {
        getSelectedTextAlignment, applyTextAlignment, setSelectedBlockType,
        toggleBasicStyle, applyTextColor, applyHighlightColor, applyFontSizePreset,
        canRunIndentAction, runIndentAction, applyLinkFromMenu, removeSelectedLink,
    } = createStyleActions({
        getEditor, getCanEdit: () => canEdit, selectedBlocks, focusEditorBody, updateEditorChrome,
        triggerDebouncedSave, closeToolbarMenus,
    });
    const { canRunHistoryAction, runHistoryAction, captureHistoryBaseline } = createHistoryActions({
        getEditor, getCanEdit: () => canEdit, focusEditorBody, updateEditorChrome,
    });

    catalogActions = createCatalogActions({
        getEditor, getCanEdit: () => canEdit, noteId, editorPage, closeToolbarMenus, focusEditorBody,
        updateEditorChrome, triggerDebouncedSave,
    });
    const {
        insertImageFromDialog, insertCatalogItem, insertBlockFromMenu,
        hasUrlBlockPopover, getUrlBlockPopover, removeUrlBlockPopover,
    } = catalogActions;

    editorChrome = createEditorChrome({
        getEditor, getCanEdit: () => canEdit, currentDocumentSnapshot,
        getLatestDocumentSnapshot: documentState.getLatestDocumentSnapshot,
        selectedBlockIds, blocknoteRoot, editorHint, updateToolbarState,
    });
    printRuntime = createPrintRuntime({
        getEditor, titleInput, notePrintButtons, currentDocumentSnapshot,
        getPageSetup: () => pageSetupRuntime.effectivePageSetup(),
        getFontFamily: () => pageSetupRuntime.getPageSetupFontFamily?.() || 'var(--font-body)',
        closeToolbarMenus, closePageSetupPopover,
    });
    reviewRuntime = createReviewRuntime({ noteId, reviewPanel, reviewButton, historyButton });

    toolbarDom = createToolbarDom({
        writingToolbar,
        pageSetupPopover,
        editorPage,
        getCanEdit: () => canEdit,
        getEditor: () => editorInstance,
        getSelectedBlocks: selectedBlocks,
        getSelectedTextAlignment,
        isBlockStyleSelected,
        canRunHistoryAction,
        canRunIndentAction,
        getZoomIndex: () => pageSetupRuntime.getZoomIndex(),
        getZoomLevels: () => pageSetupRuntime.getZoomLevels(),
        pageSetup: pageSetupRuntime,
        actions: {
            focusEditorBody,
            insertBlockFromMenu,
            runHistoryAction,
            toggleBasicStyle,
            applyTextColor,
            applyHighlightColor,
            applyFontSizePreset,
            removeSelectedLink,
            setSelectedBlockType,
            applyTextAlignment,
            runIndentAction,
            copySelectedBlocks,
            duplicateSelectedBlocks,
            deleteSelectedBlocks,
            moveSelectedBlocks,
            toggleHeadingCollapse,
            applyLinkFromMenu,
            hasUrlBlockPopover,
            getUrlBlockPopover,
            removeUrlBlockPopover,
            getActivePageSetupTrigger: () => pageSetupRuntime.getActivePageSetupTrigger(),
        },
    });

    const runBlockAction = (block, action) => {
        if (!getEditor() || !block) return;
        safeSetBlockSelection(block, block);
        return action();
    };
    const menus = createNotesMenuComponents({
        blockActions: {
            select: selectBlockRange,
            insertCatalogItem,
            addBelow: (block, anchorRect) => {
                getEditor()?.setTextCursorPosition?.(block);
                return insertCatalogItem(catalogItemByKey('paragraph'), anchorRect);
            },
            copy: (block) => runBlockAction(block, copySelectedBlocks),
            duplicate: (block) => runBlockAction(block, duplicateSelectedBlocks),
            remove: (block) => runBlockAction(block, deleteSelectedBlocks),
            move: (block, direction) => runBlockAction(block, () => moveSelectedBlocks(direction)),
            toggleHeading: (block) => runBlockAction(block, () => toggleHeadingCollapse(block)),
            turnInto: (block, item) => runBlockAction(block, () => {
                if (!canEdit) return;
                const payload = blockPayloadForCatalogItem(item);
                getEditor().updateBlock(block, updateBlockPayloadForPreservedText(block, payload));
                updateEditorChrome();
                triggerDebouncedSave();
            }),
        },
    });

    reactShell = createReactShell({
        noteContext,
        noteId,
        titleInput,
        blocknoteRoot,
        writingToolbar,
        editorPage,
        shareButton,
        collaboratorsRoot,
        getCanEdit: () => canEdit,
        setEditorReadOnlyMode,
        getEditor: () => editorInstance,
        setEditorInstance: (value) => { editorInstance = value; },
        setNotePrintReady: printRuntime.setReady,
        setNoteCollaborationEnabled: (value) => { noteCollaborationEnabled = Boolean(value); },
        setSaveStatus,
        setCollaborationPendingChanges: (value) => saveRuntime?.setCollaborationPendingChanges(value),
        setLastSavedPayloadFingerprint: (value) => saveRuntime?.setLastSavedPayloadFingerprint(value),
        notePayloadFingerprint,
        getEditorPageDisposed: () => editorPageDisposed,
        currentDocumentSnapshot,
        invalidateDocumentSnapshot,
        captureHistoryBaseline,
        updateEditorChrome,
        triggerDebouncedSave,
        bindWritingToolbar: () => toolbarDom.bindWritingToolbar(),
        bindImageRuntime,
        insertImageFromDialog,
        bindCollaborativeTitle: (session, fallbackTitle) => bindCollaborativeTitle({
            session, fallbackTitle, titleInput, getCanEdit: () => canEdit,
        }),
        bindLazyReviewPanel: reviewRuntime.bind,
        invalidateReviewPanel: reviewRuntime.invalidate,
        resetReviewPanel: reviewRuntime.reset,
        pageSetup: pageSetupRuntime,
        menus,
        toggleHeadingCollapse,
        focusEditorBody,
    });
}

function releaseNoteEditorRuntime() {
    if (editorPageDisposed) return;
    editorPageDisposed = true;
    saveRuntime?.clearTimers();
    pageSetupRuntime?.clearTimers();
    reactShell?.clearTimers();
    editorChrome?.dispose();
    toolbarDom?.disconnect();
    closeToolbarMenus();
    closePageSetupPopover();
    pageSetupRuntime?.clearPageSetupDropdowns();
    saveRuntime?.dispose();
    pageSetupRuntime?.dispose();
    catalogActions?.dispose();
    reactShell?.release();
    reviewRuntime?.dispose();
    printRuntime?.dispose();
    editorInstance = null;
    documentState.dispose();
}

const NOTES_EDITOR_RUNTIME_KEY = Symbol.for('apstudy.notes.editor.runtime');

if (!window[NOTES_EDITOR_RUNTIME_KEY]) {
    window[NOTES_EDITOR_RUNTIME_KEY] = true;
    initializeEditorRuntimes();

    window.APStudyPageLifecycle?.register?.({
        pause() {
            saveRuntime?.clearTimers();
            pageSetupRuntime?.clearTimers();
            reactShell?.pause();
        },
        resume() {
            reactShell?.resume();
            if (!noteCollaborationEnabled && saveRuntime?.hasPendingChanges()) void saveRuntime.saveNote();
            void pageSetupRuntime?.savePageSetup();
        },
        dispose: releaseNoteEditorRuntime,
    });

    saveRetry?.addEventListener('click', () => {
        if (saveRuntime?.exportRecoveryDraft()) return;
        void saveRuntime?.saveNote();
        void pageSetupRuntime?.savePageSetup();
    });

    printRuntime.bind();
    pageSetupRuntime.setInitialZoom();
    reactShell.initEditorPage();
}
