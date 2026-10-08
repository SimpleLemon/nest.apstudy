import { normalizeCopiedPlainText } from './markdown-repair.js';
import { removeBlocksAndRestoreCursor } from './block-operations.js';

export function createSelectionActions({
    getEditor,
    getCanEdit = () => true,
    updateEditorChrome,
    triggerDebouncedSave,
}) {
    let selectedBlockAnchorId = null;

    function textFromInlineContent(content) {
        if (!Array.isArray(content)) return '';
        return content.map((item) => {
            if (typeof item === 'string') return item;
            if (item?.type === 'link') return textFromInlineContent(item.content);
            return item?.text || '';
        }).join('');
    }

    function focusEditorBody() {
        const editorInstance = getEditor();
        if (!editorInstance) return;
        editorInstance.focus?.();
    }

    function selectedBlocks() {
        const editorInstance = getEditor();
        if (!editorInstance) return [];
        return editorInstance.getSelection?.()?.blocks || [editorInstance.getTextCursorPosition?.()?.block].filter(Boolean);
    }

    function safeSetBlockSelection(anchor, head = anchor) {
        const editorInstance = getEditor();
        if (!editorInstance || !anchor) return false;
        const nextHead = head || anchor;
        if (anchor.id && nextHead.id && anchor.id !== nextHead.id) {
            editorInstance.setSelection?.(anchor, nextHead);
        } else {
            editorInstance.setTextCursorPosition?.(anchor);
        }
        selectedBlockAnchorId = anchor.id || null;
        editorInstance.setForceSelectionVisible?.(true);
        return true;
    }

    function deleteSelectedBlocks() {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        const blocks = selectedBlocks();
        if (!blocks.length) return;
        removeBlocksAndRestoreCursor(editorInstance, blocks);
        selectedBlockAnchorId = null;
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
    }

    function duplicateSelectedBlocks() {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        const blocks = selectedBlocks();
        if (!blocks.length) return;
        const copied = JSON.parse(JSON.stringify(blocks)).map((block) => {
            delete block.id;
            return block;
        });
        const inserted = editorInstance.insertBlocks?.(copied, blocks[blocks.length - 1], 'after') || [];
        if (inserted[0]) {
            safeSetBlockSelection(inserted[0], inserted[inserted.length - 1] || inserted[0]);
        }
        focusEditorBody();
        updateEditorChrome();
        triggerDebouncedSave();
    }

    async function copySelectedBlocks({ cut = false } = {}) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        const blocks = selectedBlocks();
        if (!blocks.length) return;
        const blockIds = blocks.map((block) => block.id).filter(Boolean);
        const [markdown, html] = await Promise.all([
            editorInstance.blocksToMarkdownLossy?.(blocks),
            editorInstance.blocksToHTMLLossy?.(blocks),
        ]);
        const copiedMarkdown = markdown || blocks.map((block) => textFromInlineContent(block.content)).join('\n\n');
        const plainText = normalizeCopiedPlainText(copiedMarkdown);
        try {
            if (window.ClipboardItem && navigator.clipboard?.write) {
                const clipboardPayload = {
                    'text/plain': new Blob([plainText], { type: 'text/plain' }),
                    'text/html': new Blob([html || plainText], { type: 'text/html' }),
                };
                if (window.ClipboardItem.supports?.('text/markdown')) {
                    clipboardPayload['text/markdown'] = new Blob([copiedMarkdown], { type: 'text/markdown' });
                }
                await navigator.clipboard.write([
                    new ClipboardItem(clipboardPayload),
                ]);
            } else {
                await navigator.clipboard?.writeText(plainText);
            }
        } catch {
            try {
                await navigator.clipboard?.writeText(plainText);
            } catch (clipboardError) {
                console.warn('Unable to write selected note blocks to clipboard', clipboardError);
            }
        }
        if (cut && getCanEdit() && getEditor() === editorInstance) {
            removeBlocksAndRestoreCursor(editorInstance, blockIds);
        }
    }

    function moveSelectedBlocks(direction) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance) return;
        if (direction === 'up') {
            editorInstance.moveBlocksUp?.();
        } else {
            editorInstance.moveBlocksDown?.();
        }
        focusEditorBody();
        updateEditorChrome({ structureChanged: true });
        triggerDebouncedSave();
    }

    function firstSelectedHeading() {
        return selectedBlocks().find((block) => block?.type === 'heading') || null;
    }

    function toggleHeadingCollapse(block = firstSelectedHeading()) {
        const editorInstance = getEditor();
        if (!getCanEdit()) return;
        if (!editorInstance || !block || block.type !== 'heading') return;
        editorInstance.updateBlock(block, {
            props: {
                ...block.props,
                isCollapsed: !Boolean(block.props?.isCollapsed),
            },
        });
        focusEditorBody();
        updateEditorChrome({ structureChanged: true });
        triggerDebouncedSave();
    }

    function selectBlockRange(block, extend = false) {
        const editorInstance = getEditor();
        if (!editorInstance || !block) return;
        const anchor = extend && selectedBlockAnchorId ? editorInstance.getBlock?.(selectedBlockAnchorId) : null;
        if (anchor) {
            safeSetBlockSelection(anchor, block);
        } else {
            safeSetBlockSelection(block, block);
        }
        updateEditorChrome();
    }

    function selectedBlockIds() {
        return new Set(selectedBlocks().map((block) => block?.id).filter(Boolean));
    }

    return {
        focusEditorBody,
        selectedBlocks,
        safeSetBlockSelection,
        deleteSelectedBlocks,
        duplicateSelectedBlocks,
        copySelectedBlocks,
        moveSelectedBlocks,
        toggleHeadingCollapse,
        selectBlockRange,
        selectedBlockIds,
    };
}
