import {
    ALIGNMENT_OPTIONS,
    LIST_BLOCK_TYPES,
    LIST_STYLE_OPTIONS,
    MAX_INDENT_LEVEL,
    TEXT_BLOCK_OPTIONS,
    VISUAL_INDENT_BLOCKS,
    ZOOM_LEVELS,
    blockOwnContentIsEmpty,
    documentHasText,
    editorHint,
    editorState,
    writingToolbar,
} from './runtime.js';
import {
    getSelectedTextAlignment,
    iconHtml,
    isBlockStyleSelected,
} from './page-setup.js';
import {
    closeToolbarMenus,
} from './toolbar-menus.js';
import {
    triggerDebouncedSave,
} from './document.js';

export function focusEditorBody() {
    if (!editorState.editorInstance) return;
    editorState.editorInstance.focus?.();
}

export function getCurrentBlock() {
    if (!editorState.editorInstance) return null;
    return editorState.editorInstance.getTextCursorPosition?.()?.block || selectedBlocks()[0] || null;
}

export function openBlockSuggestionMenu(block) {
    if (!editorState.editorInstance || !block) return;
    editorState.editorInstance.setTextCursorPosition?.(block);
    editorState.editorInstance.openSuggestionMenu?.('/');
    focusEditorBody();
}

export function blockPropsFromDataset(button) {
    const type = button?.dataset.blockType || 'paragraph';
    if (type === 'heading') {
        return { level: Number(button.dataset.level) || 1, indentLevel: 0 };
    }
    if (type === 'codeBlock') {
        return { language: '' };
    }
    return undefined;
}

export function insertBlockFromMenu(button) {
    if (!editorState.editorInstance) return;

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
        editorState.editorInstance.updateBlock(currentBlock, block);
        editorState.editorInstance.setTextCursorPosition?.(currentBlock);
        closeToolbarMenus();
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
        return;
    }

    const insertedBlock = editorState.editorInstance.insertBlocks?.(
        [block],
        currentBlock,
        'after'
    )?.[0];

    if (insertedBlock) editorState.editorInstance.setTextCursorPosition?.(insertedBlock);
    closeToolbarMenus();
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

export function selectedBlocks() {
    if (!editorState.editorInstance) return [];
    return editorState.editorInstance.getSelection?.()?.blocks || [editorState.editorInstance.getTextCursorPosition?.()?.block].filter(Boolean);
}

export function blockSupportsVisualIndent(block) {
    return VISUAL_INDENT_BLOCKS.has(block?.type);
}

export function visualIndentLevel(block) {
    return Math.min(MAX_INDENT_LEVEL, Math.max(0, Number(block?.props?.indentLevel || 0)));
}

export function mergedPropsForBlockType(type, block, props = undefined) {
    const merged = {};
    if (block?.props?.textAlignment) merged.textAlignment = block.props.textAlignment;
    if (block?.props?.textColor) merged.textColor = block.props.textColor;
    if (block?.props?.backgroundColor) merged.backgroundColor = block.props.backgroundColor;
    if (VISUAL_INDENT_BLOCKS.has(type)) merged.indentLevel = visualIndentLevel(block);
    if (type === 'heading') merged.level = Number(props?.level || block?.props?.level || 1);
    if (type === 'checkListItem') merged.checked = Boolean(block?.props?.checked);
    return { ...merged, ...(props || {}) };
}

export function setSelectedBlocks(type, props = undefined) {
    if (!editorState.editorInstance) return;
    selectedBlocks().forEach((block) => {
        if (!block) return;
        editorState.editorInstance.updateBlock(block, {
            type,
            props: mergedPropsForBlockType(type, block, props),
        });
    });
    focusEditorBody();
    updateEditorChrome();
    triggerDebouncedSave();
}

export function toggleBasicStyle(style) {
    if (!editorState.editorInstance) return;
    if (typeof editorState.editorInstance.toggleStyles === 'function') {
        editorState.editorInstance.toggleStyles({ [style]: true });
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
        return;
    }
    focusEditorBody();
}

export function canRunHistoryAction(action) {
    if (!editorState.editorInstance) return false;

    const depth = historyDepth(action);
    if (typeof depth === 'number') {
        return depth > (editorState.historyBaselineDepths[action] || 0);
    }

    const commandCan = editorState.editorInstance._tiptapEditor?.can?.();
    const canAction = commandCan?.[action];
    if (typeof canAction !== 'function') return false;

    try {
        return Boolean(canAction.call(commandCan));
    } catch (error) {
        return false;
    }
}

export function runHistoryAction(action) {
    if (!editorState.editorInstance || !canRunHistoryAction(action)) return;

    if (typeof editorState.editorInstance[action] === 'function') {
        editorState.editorInstance[action]();
    } else {
        editorState.editorInstance._tiptapEditor?.commands?.[action]?.();
    }

    focusEditorBody();
    updateEditorChrome();
}

export function canRunIndentAction(action) {
    if (!editorState.editorInstance) return false;
    const blocks = selectedBlocks();
    if (!blocks.length) return false;
    if (blocks.some((block) => LIST_BLOCK_TYPES.has(block?.type))) {
        if (action === 'indent') return Boolean(editorState.editorInstance.canNestBlock?.());
        if (action === 'outdent') return Boolean(editorState.editorInstance.canUnnestBlock?.());
    }
    if (blocks.some(blockSupportsVisualIndent)) {
        if (action === 'indent') return blocks.some((block) => visualIndentLevel(block) < MAX_INDENT_LEVEL);
        if (action === 'outdent') return blocks.some((block) => visualIndentLevel(block) > 0);
    }
    return false;
}

export function runIndentAction(action) {
    if (!editorState.editorInstance || !canRunIndentAction(action)) return;
    const blocks = selectedBlocks();
    const listMode = blocks.some((block) => LIST_BLOCK_TYPES.has(block?.type));
    if (listMode && action === 'indent') {
        editorState.editorInstance.nestBlock?.();
    } else if (listMode && action === 'outdent') {
        editorState.editorInstance.unnestBlock?.();
    } else {
        blocks.forEach((block) => {
            if (!blockSupportsVisualIndent(block)) return;
            const currentLevel = visualIndentLevel(block);
            const nextLevel = action === 'indent'
                ? Math.min(MAX_INDENT_LEVEL, currentLevel + 1)
                : Math.max(0, currentLevel - 1);
            editorState.editorInstance.updateBlock(block, {
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

export function applyLinkFromMenu(menu) {
    if (!editorState.editorInstance || !menu) return;
    const input = menu.querySelector('[data-link-url]');
    const url = input?.value?.trim();
    if (!url) return;

    const selectedText = editorState.editorInstance.getSelectedText?.() || '';
    editorState.editorInstance.focus();
    editorState.editorInstance.createLink?.(url, selectedText ? undefined : url);
    closeToolbarMenus();
    updateEditorChrome();
    triggerDebouncedSave();
}

export function historyDepth(action) {
    const state = editorState.editorInstance?._tiptapEditor?.state;
    if (!state?.plugins) return null;

    const historyPlugin = state.plugins.find((plugin) => String(plugin.key || '').startsWith('history$'));
    const historyState = historyPlugin?.getState?.(state);
    const branch = action === 'redo' ? historyState?.undone : historyState?.done;
    return typeof branch?.eventCount === 'number' ? branch.eventCount : null;
}

export function captureHistoryBaseline() {
    editorState.historyBaselineDepths = {
        undo: historyDepth('undo') || 0,
        redo: historyDepth('redo') || 0,
    };
}

export function updateToolbarState() {
    if (!writingToolbar || !editorState.editorInstance) return;
    const block = selectedBlocks()[0];
    const activeStyles = typeof editorState.editorInstance.getActiveStyles === 'function'
        ? editorState.editorInstance.getActiveStyles()
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
            disabled = editorState.zoomIndex === 0;
        } else if (action === 'zoom-in') {
            disabled = editorState.zoomIndex === ZOOM_LEVELS.length - 1;
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

export function updateEditorHint() {
    if (!editorHint || !editorState.editorInstance) return;
    editorHint.hidden = documentHasText(editorState.editorInstance.document);
}

export function updateEditorChrome() {
    updateToolbarState();
    updateEditorHint();
}
