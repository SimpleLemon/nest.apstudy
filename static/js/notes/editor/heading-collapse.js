export function hiddenBlocksForCollapsedHeadings(blocks) {
    const hidden = new Map();
    const counts = new Map();
    const documentBlocks = Array.isArray(blocks) ? blocks : [];
    let activeHeading = null;

    for (const block of documentBlocks) {
        if (block?.type === 'heading') {
            const level = Number(block.props?.level || 1);
            if (activeHeading && level <= activeHeading.level) {
                activeHeading = null;
            }
            if (block.props?.isCollapsed) {
                activeHeading = { id: block.id, level };
                counts.set(block.id, 0);
            }
            continue;
        }
        if (activeHeading) {
            hidden.set(block.id, activeHeading.id);
            counts.set(activeHeading.id, (counts.get(activeHeading.id) || 0) + 1);
        }
    }

    return { hidden, counts };
}
