import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    SideMenuController,
    SuggestionMenuController,
    useCreateBlockNote,
    useEditorContentOrSelectionChange,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { History } from '@tiptap/extension-history';
import { notesEditorSchema } from '../editor-schema.js';
import { listItemHardBreakShortcuts, preserveRangeSelectionShortcuts, createSelectAllShortcuts } from './keyboard-shortcuts.js';
import { normalizeCopiedPlainText, normalizeImportedMarkdownBlocks } from './markdown-repair.js';
import { buildLoadingIndicatorHtml, documentHasText, isBlankTitle } from './utils.js';
import { handleNotesPaste } from './paste.js';

const NORMAL_HISTORY_DEPTH = 100;
const LONG_DOCUMENT_HISTORY_DEPTH = 35;
const LARGE_DOCUMENT_BLOCK_COUNT = 120;

export function createReactShell({
    noteContext,
    noteId,
    titleInput,
    blocknoteRoot,
    writingToolbar,
    editorPage,
    shareButton,
    collaboratorsRoot,
    getCanEdit,
    setEditorReadOnlyMode,
    getEditor,
    setEditorInstance,
    setNotePrintReady,
    setNoteCollaborationEnabled,
    setSaveStatus,
    setCollaborationPendingChanges,
    setLastSavedPayloadFingerprint,
    notePayloadFingerprint,
    getEditorPageDisposed,
    currentDocumentSnapshot,
    invalidateDocumentSnapshot,
    captureHistoryBaseline,
    updateEditorChrome,
    triggerDebouncedSave,
    bindWritingToolbar,
    bindImageRuntime,
    insertImageFromDialog,
    bindCollaborativeTitle,
    bindLazyReviewPanel,
    invalidateReviewPanel,
    resetReviewPanel,
    pageSetup,
    menus,
    toggleHeadingCollapse,
    focusEditorBody,
}) {
    let noteEditorReactRoot = null;
    let editorLoadController = null;
    let editorReadyTimer = null;
    let editorInitialFocusTimer = null;
    let activeCollaborationSession = null;
    let activeCollaborativeTitleCleanup = null;
    let pageEventController = null;
    let documentGeneration = 0;

    function historyDepthForDocument(documentValue) {
        return (Array.isArray(documentValue) ? documentValue.length : 0) >= LARGE_DOCUMENT_BLOCK_COUNT
            ? LONG_DOCUMENT_HISTORY_DEPTH
            : NORMAL_HISTORY_DEPTH;
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

    function NoteEditor({ initialContent, initialContentWasNormalized = false, collaborationSession = null }) {
        const [canEdit, setCanEdit] = React.useState(getCanEdit());
        React.useEffect(() => {
            const updatePermission = () => setCanEdit(getCanEdit());
            const unsubscribe = collaborationSession?.subscribeAccess(updatePermission);
            updatePermission();
            return unsubscribe;
        }, [collaborationSession]);
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
            pasteHandler: (options) => handleNotesPaste({
                ...options,
                noteId,
                onChange: triggerDebouncedSave,
            }),
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

        const getSlashItems = React.useCallback((query) => menus.getSlashItems(query, editor), [editor]);

        React.useEffect(() => {
            setEditorInstance(editor);
            editor.isEditable = getCanEdit();
            setNotePrintReady(true);
            editorReadyTimer = window.setTimeout(() => {
                editorReadyTimer = null;
                if (getEditor() !== editor) return;
                captureHistoryBaseline();
                invalidateDocumentSnapshot();
                const documentSnapshot = currentDocumentSnapshot();
                updateEditorChrome({ structureChanged: true, contentChanged: true, documentSnapshot });
                if (getCanEdit() && initialContentWasNormalized && !collaborationSession) {
                    triggerDebouncedSave();
                }
            }, 0);

            return () => {
                if (editorReadyTimer) {
                    window.clearTimeout(editorReadyTimer);
                    editorReadyTimer = null;
                }
                if (getEditor() === editor) {
                    setEditorInstance(null);
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
                    if (!getCanEdit()) return;
                    updateEditorChrome({ contentChanged: true });
                    triggerDebouncedSave();
                },
            },
            canEdit ? React.createElement(SuggestionMenuController, {
                triggerCharacter: '/',
                getItems: getSlashItems,
                suggestionMenuComponent: menus.NotesSlashMenu,
            }) : null,
            canEdit ? React.createElement(SideMenuController, {
                sideMenu: menus.NotesSideMenu,
            }) : null
        );
    }

    async function connectDocumentCollaboration(note, noteTitle, initialGeneration, isCurrentDocument) {
        setSaveStatus('connecting');
        try {
            const { createNoteCollaborationSession } = await import('./collaboration/collaboration.js');
            if (!isCurrentDocument()) return;
            const collaborationSession = await createNoteCollaborationSession({
                noteId,
                access: note?.access || noteContext.access,
                initialGeneration,
                presenceRoot: collaboratorsRoot,
                onStatus: (status, options) => setSaveStatus(status, options),
                onPendingChanges: setCollaborationPendingChanges,
                getDraftContent: currentDocumentSnapshot,
                onReviewEvent: (event) => {
                    if (isCurrentDocument()) invalidateReviewPanel?.(event);
                },
                onDocumentChange: () => {
                    // Replacement or lost edit permission requires a clean Y.Doc.
                    // The prior session checkpoints its draft before this callback.
                    window.setTimeout(() => {
                        if (!isCurrentDocument()) return;
                        release();
                        void initEditorPage();
                    }, 0);
                },
                onAccessChange: (access, { readOnly, ready }) => {
                    if (!isCurrentDocument()) return;
                    noteContext.access = access;
                    note.access = access;
                    setEditorReadOnlyMode(readOnly);
                    bindLazyReviewPanel({
                        canReview: ready && access.can_review === true,
                        canManageReviews: ready && access.can_manage_reviews === true,
                        canViewVersions: ready && access.can_edit === true,
                    });
                },
            });
            if (!isCurrentDocument()) {
                collaborationSession?.destroy();
                return;
            }
            activeCollaborationSession = collaborationSession;
            activeCollaborativeTitleCleanup = bindCollaborativeTitle(activeCollaborationSession, noteTitle);
        } catch (error) {
            if (!isCurrentDocument()) return;
            console.error('Failed to connect note collaboration', error);
            activeCollaborationSession = null;
            setEditorReadOnlyMode(true);
            setSaveStatus('offline-readonly');
        }
    }

    function bindEditorPageEvents(rootElement) {
        pageEventController?.abort();
        pageEventController = new AbortController();
        const pageEventOptions = { signal: pageEventController.signal };
        titleInput.addEventListener('input', () => {
            if (getCanEdit()) triggerDebouncedSave();
        }, pageEventOptions);
        titleInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || !getCanEdit()) return;
            event.preventDefault();
            focusEditorBody();
        }, pageEventOptions);
        rootElement.addEventListener('click', (event) => {
            if (!getCanEdit()) return;
            const collapseButton = event.target.closest('.notes-heading-collapse-toggle');
            if (collapseButton) {
                event.preventDefault();
                event.stopPropagation();
                const blockId = collapseButton.closest('.bn-block-outer[data-id]')?.dataset.id;
                const block = blockId ? getEditor()?.getBlock?.(blockId) : null;
                toggleHeadingCollapse(block);
                return;
            }
            focusEditorBody();
        }, pageEventOptions);
        rootElement.addEventListener('copy', normalizeNativeEditorCopy, pageEventOptions);
        rootElement.addEventListener('cut', normalizeNativeEditorCopy, pageEventOptions);
    }

    async function initEditorPage() {
        if (getEditorPageDisposed()) return;
        const mountingGeneration = ++documentGeneration;
        const isCurrentDocument = () => !getEditorPageDisposed() && mountingGeneration === documentGeneration;
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
        let initialGeneration = null;
        editorLoadController?.abort();
        const loadingController = new AbortController();
        editorLoadController = loadingController;

        try {
            const response = await fetch(`/api/notes/${noteId}`, { signal: loadingController.signal });
            if (!response.ok) {
                throw new Error('Failed to fetch note');
            }
            note = await response.json();
            initialGeneration = response.headers.get('X-Nest-Document-Generation');
        } catch (error) {
            if (error?.name === 'AbortError' || !isCurrentDocument()) return;
            console.error(error);
            renderMissingNoteState('The note may have been deleted or is unavailable.');
            return;
        } finally {
            if (editorLoadController === loadingController) editorLoadController = null;
        }

        if (!isCurrentDocument()) return;

        const noteTitle = typeof note?.title === 'string' ? note.title : '';
        titleInput.value = noteTitle;
        if (shareButton) shareButton.dataset.resourceTitle = noteTitle || 'Untitled';
        pageSetup.setLoadedPageSetup(note?.page_setup, note?.global_page_setup);
        setNoteCollaborationEnabled(note?.collaboration_enabled === true);
        if (note?.updated_at) {
            setSaveStatus('saved', { savedAt: note.updated_at });
        }
        if (typeof note?.content === 'string') {
            setLastSavedPayloadFingerprint(notePayloadFingerprint(noteTitle, note.content));
        }

        noteContext.access = note?.access || noteContext.access;
        setEditorReadOnlyMode(note?.collaboration_enabled === true || noteContext.access?.can_edit !== true);

        if (note?.collaboration_enabled === true) {
            await connectDocumentCollaboration(note, noteTitle, initialGeneration, isCurrentDocument);
            if (!isCurrentDocument()) return;
        }
        bindLazyReviewPanel({
            canReview: (!note?.collaboration_enabled || activeCollaborationSession?.ready === true) && note?.access?.can_review === true,
            canManageReviews: (!note?.collaboration_enabled || activeCollaborationSession?.ready === true) && note?.access?.can_manage_reviews === true,
            canViewVersions: (!note?.collaboration_enabled || activeCollaborationSession?.ready === true) && note?.access?.can_edit === true,
        });

        let parsedContent = undefined;
        let parsedContentWasNormalized = false;
        if (typeof note?.content === 'string' && note.content.trim() !== '') {
            try {
                parsedContent = JSON.parse(note.content);
            } catch {
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
            if (getCanEdit()) bindWritingToolbar();
        } catch (error) {
            console.error('Failed to mount note editor', error);
            setSaveStatus('error');
        }

        bindEditorPageEvents(rootElement);
        editorInitialFocusTimer = window.setTimeout(() => {
            editorInitialFocusTimer = null;
            if (getEditorPageDisposed()) return;
            const isNewBlankNote = isBlankTitle(noteTitle) && !documentHasText(parsedContent);
            const documentSnapshot = currentDocumentSnapshot();
            updateEditorChrome({ structureChanged: true, contentChanged: true, documentSnapshot });
            if (!getCanEdit() || !isNewBlankNote) return;
            titleInput.focus({ preventScroll: true });
            titleInput.select();
        }, 0);
    }

    function clearTimers() {
        editorLoadController?.abort();
        editorLoadController = null;
        if (editorReadyTimer) window.clearTimeout(editorReadyTimer);
        if (editorInitialFocusTimer) window.clearTimeout(editorInitialFocusTimer);
        editorReadyTimer = null;
        editorInitialFocusTimer = null;
    }

    function release() {
        documentGeneration += 1;
        resetReviewPanel?.();
        clearTimers();
        pageEventController?.abort();
        pageEventController = null;
        activeCollaborativeTitleCleanup?.();
        activeCollaborativeTitleCleanup = null;
        activeCollaborationSession?.destroy?.();
        activeCollaborationSession = null;
        noteEditorReactRoot?.unmount();
        noteEditorReactRoot = null;
    }

    function pause() {
        // A persisted page keeps its editor and pending Y.Doc for Browser Back.
        // Only transport pauses; resuming rechecks current admission permissions.
        activeCollaborationSession?.pause();
    }

    function resume() {
        if (!getEditorPageDisposed()) activeCollaborationSession?.resume();
    }

    function normalizeNativeEditorCopy(event) {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        const plainText = clipboardData.getData('text/plain');
        if (!plainText) return;
        clipboardData.setData('text/plain', normalizeCopiedPlainText(plainText));
    }

    return {
        clearTimers,
        initEditorPage,
        release,
        pause,
        resume,
        renderMissingNoteState,
    };
}
