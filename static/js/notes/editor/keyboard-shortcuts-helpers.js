const LIST_ITEM_BLOCK_TYPES = new Set([
    'bulletListItem',
    'numberedListItem',
    'checkListItem',
]);

export function isListItemBlockType(blockType) {
    return LIST_ITEM_BLOCK_TYPES.has(blockType);
}

export function insertListHardBreak(state, blockType, dispatch) {
    if (!isListItemBlockType(blockType)) return false;
    const hardBreak = state?.schema?.nodes?.hardBreak;
    if (!hardBreak || !state?.tr?.replaceSelectionWith) return false;

    const transaction = state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView();
    dispatch?.(transaction);
    return true;
}
