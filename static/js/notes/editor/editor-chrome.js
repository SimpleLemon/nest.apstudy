import { hiddenBlocksForCollapsedHeadings } from './heading-collapse.js';
import { documentHasText } from './utils.js';

export function createEditorChrome({
    getEditor,
    getCanEdit,
    getLatestDocumentSnapshot,
    currentDocumentSnapshot,
    selectedBlockIds,
    blocknoteRoot,
    editorHint,
    updateToolbarState,
}) {
    const EDITOR_CHROME_THROTTLE_MS = 120;
    let editorChromeThrottleTimer = null;
    let editorChromeRafId = null;
    let editorChromeSyncNeedsStructure = false;
    let editorChromeSyncSnapshot = null;
    let lastSelectedBlockIds = new Set();
    let lastHeadingCollapseSignature = '';

    function updateEditorHint(documentSnapshot = getLatestDocumentSnapshot()) {
        const editorInstance = getEditor();
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
        if (!getCanEdit()) {
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
        const editorInstance = getEditor();
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
            if (!getCanEdit()) {
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

    function dispose() {
        if (editorChromeThrottleTimer) window.clearTimeout(editorChromeThrottleTimer);
        if (editorChromeRafId) window.cancelAnimationFrame(editorChromeRafId);
        editorChromeThrottleTimer = null;
        editorChromeRafId = null;
        editorChromeSyncNeedsStructure = false;
        editorChromeSyncSnapshot = null;
        lastSelectedBlockIds.clear();
    }

    return {
        updateEditorChrome,
        dispose,
    };
}
