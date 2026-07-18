function uniqueBlockIds(blocks) {
    return [...new Set((blocks || []).map((block) => (
        typeof block === 'string' ? block : block?.id
    )).filter(Boolean))];
}

function existingBlocks(editor, blockIds) {
    return blockIds.map((id) => editor?.getBlock?.(id)).filter(Boolean);
}

export function removeBlocksAndRestoreCursor(editor, blocks) {
    if (!editor) return [];
    const blockIds = uniqueBlockIds(blocks);
    const blocksToRemove = existingBlocks(editor, blockIds);
    if (!blocksToRemove.length) return [];

    const first = blocksToRemove[0];
    const last = blocksToRemove[blocksToRemove.length - 1];
    const candidateIds = uniqueBlockIds([
        editor.getNextBlock?.(last),
        editor.getPrevBlock?.(first),
    ]).filter((id) => !blockIds.includes(id));

    editor.removeBlocks?.(blocksToRemove);

    const cursorTarget = existingBlocks(editor, candidateIds)[0]
        || editor.document?.[0]
        || null;
    if (cursorTarget) {
        editor.setTextCursorPosition?.(cursorTarget);
    }
    return blocksToRemove;
}

