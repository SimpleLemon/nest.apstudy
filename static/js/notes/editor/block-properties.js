export const VISUAL_INDENT_BLOCKS = new Set(['paragraph', 'heading']);
export const LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);
export const ATOM_BLOCK_TYPES = new Set(['divider', 'bookmark', 'image', 'video', 'audio', 'file']);
export const MAX_INDENT_LEVEL = 4;

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

export function updateBlockPayloadForPreservedText(block, payload) {
    if (!block || !payload) return payload;
    if (ATOM_BLOCK_TYPES.has(payload.type) || payload.type === 'table') return payload;
    return {
        ...payload,
        props: mergedPropsForBlockType(payload.type, block, payload.props),
        content: block.content,
        children: block.children || [],
    };
}

export function isBlockStyleSelected(block, option) {
    if (!block || block.type !== option.type) return false;
    if (!option.props) return true;
    return Object.entries(option.props).every(([key, value]) => block.props?.[key] === value);
}
