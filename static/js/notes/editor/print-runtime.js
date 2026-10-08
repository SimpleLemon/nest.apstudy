import { hiddenBlocksForCollapsedHeadings } from './heading-collapse.js';

export function createPrintRuntime({
    getEditor,
    titleInput,
    notePrintButtons,
    currentDocumentSnapshot,
    getPageSetup,
    getFontFamily,
    closeToolbarMenus,
    closePageSetupPopover,
    loadModule = () => import('./print.js'),
}) {
    let notePrintReady = false;
    let notePrintInProgress = false;
    let disposed = false;

    function syncNotePrintControls() {
        notePrintButtons.forEach((button) => {
            const disabled = !notePrintReady || notePrintInProgress;
            button.disabled = disabled;
            button.setAttribute('aria-disabled', String(disabled));
            button.toggleAttribute('aria-busy', notePrintInProgress);
        });
    }

    function setNotePrintReady(ready) {
        notePrintReady = !disposed && Boolean(ready);
        syncNotePrintControls();
    }

    async function requestCurrentNotePrint() {
        const editorInstance = getEditor();
        if (!notePrintReady || notePrintInProgress || !editorInstance || !titleInput) return;
        notePrintInProgress = true;
        syncNotePrintControls();
        closeToolbarMenus();
        closePageSetupPopover();

        try {
            const { printNote } = await loadModule();
            if (disposed) return;
            const documentSnapshot = currentDocumentSnapshot();
            const { hidden } = hiddenBlocksForCollapsedHeadings(documentSnapshot);
            const setup = getPageSetup();
            await printNote({
                editor: editorInstance,
                blocks: documentSnapshot,
                hiddenBlockIds: hidden.keys(),
                title: titleInput.value,
                fontFamily: getFontFamily(),
                sideMargins: setup.sideMargins,
            });
        } catch (error) {
            if (disposed) return;
            console.error('Failed to prepare note for printing', error);
            window.APStudyToast?.error?.('Try again in a moment.', { title: 'Couldn’t prepare note for printing' });
        } finally {
            notePrintInProgress = false;
            syncNotePrintControls();
        }
    }

    function bindNotePrintControls() {
        if (disposed) return;
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

    function dispose() {
        disposed = true;
        document.removeEventListener('click', handleNotePrintClick, true);
        document.removeEventListener('keydown', handleNotePrintShortcut, true);
        setNotePrintReady(false);
    }

    return {
        bind: bindNotePrintControls,
        setReady: setNotePrintReady,
        dispose,
    };
}
