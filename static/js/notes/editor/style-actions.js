import { checkBlockHasDefaultProp, checkBlockTypeHasDefaultProp, mapTableCell } from '@blocknote/core';
import { FONT_SIZE_PRESETS } from './block-catalog.js';
import { LIST_BLOCK_TYPES, MAX_INDENT_LEVEL, blockSupportsVisualIndent, visualIndentLevel, mergedPropsForBlockType } from './block-properties.js';

export function createStyleActions({
    getEditor,
    getCanEdit = () => true,
    selectedBlocks,
    focusEditorBody,
    updateEditorChrome,
    triggerDebouncedSave,
    closeToolbarMenus,
}) {

    function getSelectedTextAlignment() {
        const editorInstance = getEditor();
        if (!editorInstance) return 'left';
        const inlineSelection = editorInstance._tiptapEditor?.state?.selection;
        if (inlineSelection?.node?.type?.name === 'inlineImage') {
            return inlineSelection.node.attrs?.alignment || 'left';
        }
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
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        editorInstance.focus();

        const inlineSelection = editorInstance._tiptapEditor?.state?.selection;
        if (inlineSelection?.node?.type?.name === 'inlineImage') {
            const transaction = editorInstance._tiptapEditor.state.tr.setNodeMarkup(
                inlineSelection.from,
                undefined,
                { ...inlineSelection.node.attrs, layout: 'break', alignment: textAlignment === 'justify' ? 'left' : textAlignment }
            );
            editorInstance.dispatch(transaction);
            updateEditorChrome();
            triggerDebouncedSave();
            return;
        }

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

    function setSelectedBlockType(type, props = undefined) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
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
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
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

    function applyInlineStyle(style, value) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        editorInstance.focus?.();
        if (value === 'default' || value === '') {
            editorInstance.removeStyles?.({ [style]: value });
        } else {
            editorInstance.addStyles?.({ [style]: value });
        }
        updateEditorChrome();
        triggerDebouncedSave();
    }

    function applyTextColor(color) {
        applyInlineStyle('textColor', color);
    }

    function applyHighlightColor(color) {
        applyInlineStyle('backgroundColor', color);
    }

    function applyFontSizePreset(value) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        const preset = FONT_SIZE_PRESETS.find((item) => item.value === value) || FONT_SIZE_PRESETS[0];
        if (preset.value === 'default') {
            editorInstance?.removeStyles?.({ fontSize: '' });
        } else {
            editorInstance?.addStyles?.({ fontSize: preset.cssValue });
        }
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
    }

    function canRunIndentAction(action) {
        const editorInstance = getEditor();
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
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
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
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
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

    function removeSelectedLink() {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        editorInstance.focus?.();
        editorInstance._tiptapEditor?.chain?.().focus().unsetLink().run();
        closeToolbarMenus();
        updateEditorChrome();
        triggerDebouncedSave();
    }

    return {
        getSelectedTextAlignment,
        applyTextAlignment,
        setSelectedBlockType,
        toggleBasicStyle,
        applyTextColor,
        applyHighlightColor,
        applyFontSizePreset,
        canRunIndentAction,
        runIndentAction,
        applyLinkFromMenu,
        removeSelectedLink,
    };
}
