import { hiddenBlocksForCollapsedHeadings } from './heading-collapse.js';

function isApplePlatform(navigatorRef) {
    const platform = navigatorRef?.userAgentData?.platform
        || navigatorRef?.platform
        || navigatorRef?.userAgent
        || '';
    return /Mac|iPhone|iPad|iPod/i.test(platform)
        || (platform === 'MacIntel' && Number(navigatorRef?.maxTouchPoints) > 1);
}

export function isSelectAllShortcut(event, navigatorRef = globalThis.navigator) {
    if (!event || event.altKey || event.shiftKey) return false;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'a' && event.code !== 'KeyA') return false;

    if (isApplePlatform(navigatorRef)) {
        return event.metaKey && !event.ctrlKey;
    }
    return event.ctrlKey && !event.metaKey;
}

export function isEditorBodyFocused() {
    const active = document.activeElement;
    if (!active) return false;
    return Boolean(active.closest?.('.blocknote-container .ProseMirror'));
}

export function inlineTextFromBlock(block) {
    if (!block || !Array.isArray(block.content)) return '';
    return block.content.map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'link') return inlineTextFromBlock({ content: item.content });
        return item?.text || '';
    }).join('');
}

export function visibleTopLevelBlocks(blocks) {
    const documentBlocks = Array.isArray(blocks) ? blocks : [];
    const { hidden } = hiddenBlocksForCollapsedHeadings(documentBlocks);
    return documentBlocks.filter((block) => block?.id && !hidden.has(block.id));
}

export function shouldSelectAllBlocks(blockNoteEditor) {
    const blockSelection = blockNoteEditor?.getSelection?.();
    if ((blockSelection?.blocks?.length || 0) > 1) return true;

    const tiptap = blockNoteEditor?._tiptapEditor;
    const pmSelection = tiptap?.state?.selection;
    if (!pmSelection || pmSelection.empty) return false;

    const block = blockNoteEditor.getTextCursorPosition?.()?.block;
    if (!block) return false;

    const blockText = inlineTextFromBlock(block);
    if (!blockText) return true;

    const selectedText = tiptap.state.doc.textBetween(pmSelection.from, pmSelection.to, '');
    return selectedText === blockText;
}

export function selectAllVisibleBlocks(blockNoteEditor) {
    const visible = visibleTopLevelBlocks(blockNoteEditor?.document || []);
    if (!visible.length) return false;
    const first = visible[0];
    const last = visible[visible.length - 1];
    blockNoteEditor.setSelection?.(first, last);
    blockNoteEditor.setForceSelectionVisible?.(true);
    return true;
}
