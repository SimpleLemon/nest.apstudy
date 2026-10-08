
export function createDocumentState({
    getEditor,
}) {
    let latestDocumentSnapshot = null;
    function blockCountForDocument(documentValue) {
        return Array.isArray(documentValue) ? documentValue.length : 0;
    }

    function editorTopLevelBlockCount() {
        const editorInstance = getEditor();
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
        const editorInstance = getEditor();
        if (!editorInstance) return [];
        if (!latestDocumentSnapshot) {
            latestDocumentSnapshot = editorInstance.document || [];
        }
        return latestDocumentSnapshot;
    }

    return {
        editorTopLevelBlockCount,
        invalidateDocumentSnapshot,
        currentDocumentSnapshot,
        getLatestDocumentSnapshot: () => latestDocumentSnapshot,
        dispose: invalidateDocumentSnapshot,
    };
}
