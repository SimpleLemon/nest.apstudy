
export function createHistoryActions({
    getEditor,
    getCanEdit = () => true,
    focusEditorBody,
    updateEditorChrome,
}) {
    let historyBaselineDepths = { undo: 0, redo: 0 };
    function canRunHistoryAction(action) {
        const editorInstance = getEditor();
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
        } catch {
            return false;
        }
    }

    function runHistoryAction(action) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance || !canRunHistoryAction(action)) return;

        if (typeof editorInstance[action] === 'function') {
            editorInstance[action]();
        } else {
            editorInstance._tiptapEditor?.commands?.[action]?.();
        }

        focusEditorBody();
        updateEditorChrome();
    }

    function historyDepth(action) {
        const editorInstance = getEditor();
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

    return {
        canRunHistoryAction,
        runHistoryAction,
        captureHistoryBaseline,
    };
}
