const BULLET_MARKER_LEVELS = {
    '•': 0,
    '‣': 0,
    '⁃': 0,
    '◦': 1,
    '▪': 2,
    '■': 2,
};

const DEFAULT_TEXT_PROPS = {
    textColor: 'default',
    backgroundColor: 'default',
    textAlignment: 'left',
};

function ownText(block) {
    if (!Array.isArray(block?.content)) return '';
    return block.content.map((item) => {
        if (typeof item === 'string') return item;
        return item?.text || '';
    }).join('').trim();
}

function contentFromText(text) {
    return text
        ? [{ type: 'text', text, styles: {} }]
        : [];
}

function normalizeChildren(block) {
    const result = normalizeImportedMarkdownBlocks(block?.children || []);
    return result.blocks;
}

function textLikeBlock(block, overrides = {}) {
    const props = {
        ...DEFAULT_TEXT_PROPS,
        ...(block?.props || {}),
        ...(overrides.props || {}),
    };
    delete props.indentLevel;
    if (overrides.type !== 'heading') delete props.level;
    if (overrides.type === 'checkListItem' && props.checked === undefined) {
        props.checked = false;
    }

    return {
        ...block,
        ...overrides,
        props,
        content: overrides.content || block?.content || [],
        children: overrides.children || normalizeChildren(block),
    };
}

function pageBreakBlock(block) {
    return {
        id: block?.id,
        type: 'pageBreak',
        props: {},
        children: [],
    };
}

function markerForText(text) {
    if (Object.prototype.hasOwnProperty.call(BULLET_MARKER_LEVELS, text)) {
        return {
            type: 'bulletListItem',
            level: BULLET_MARKER_LEVELS[text],
            source: 'glyph',
        };
    }

    const numbered = text.match(/^(\d+)[.)]$/);
    if (numbered) {
        return {
            type: 'numberedListItem',
            level: 0,
            number: Number(numbered[1]),
            source: 'numbered',
        };
    }

    return null;
}

function directMarkdownMarker(text) {
    const quote = text.match(/^>\s+(.+)$/);
    if (quote) {
        return { type: 'quote', level: 0, text: quote[1] };
    }

    const list = text.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (!list) return null;

    const marker = markerForText(list[2].replace(/[*)]/, '.')) || {
        type: 'bulletListItem',
        level: 0,
    };
    return {
        ...marker,
        level: Math.min(4, Math.floor(list[1].replace(/\t/g, '  ').length / 2)),
        text: list[3],
    };
}

function isPageBreakText(text) {
    return /^-{3,}$/.test(text) || /^_{3,}$/.test(text) || /^—{3,}$/.test(text);
}

function listItemEndsWithColon(block) {
    return /:\s*$/.test(ownText(block));
}

function appendListItem(output, listStack, block, level) {
    if (level <= 0 || !listStack[level - 1]) {
        output.push(block);
        listStack[0] = block;
        listStack.length = 1;
        return;
    }

    const parent = listStack[level - 1];
    parent.children = parent.children || [];
    parent.children.push(block);
    listStack[level] = block;
    listStack.length = level + 1;
}

function inferredNumberedLevel(marker, listStack) {
    if (marker.source !== 'numbered') return marker.level;
    if (marker.number > 1 && listStack[1]?.type === 'numberedListItem') return 1;
    if (marker.number === 1 && listStack[0]?.type === 'bulletListItem' && listItemEndsWithColon(listStack[0])) {
        return 1;
    }
    return 0;
}

function normalizeImportedMarkdownBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return { blocks: Array.isArray(blocks) ? blocks : [], changed: false };
    }

    const output = [];
    const listStack = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const text = ownText(block);

        if (isPageBreakText(text)) {
            output.push(pageBreakBlock(block));
            listStack.length = 0;
            changed = true;
            continue;
        }

        if (text === '>' && blocks[index + 1]) {
            output.push(textLikeBlock(blocks[index + 1], { type: 'quote' }));
            listStack.length = 0;
            changed = true;
            index += 1;
            continue;
        }

        const marker = markerForText(text);
        if (marker && blocks[index + 1]) {
            const nextBlock = blocks[index + 1];
            const nextText = ownText(nextBlock);
            if (!markerForText(nextText) && !isPageBreakText(nextText)) {
                const level = inferredNumberedLevel(marker, listStack);
                const listItem = textLikeBlock(nextBlock, { type: marker.type });
                appendListItem(output, listStack, listItem, level);
                changed = true;
                index += 1;
                continue;
            }
        }

        const directMarker = directMarkdownMarker(text);
        if (directMarker) {
            const converted = textLikeBlock(block, {
                type: directMarker.type,
                content: contentFromText(directMarker.text),
            });
            if (directMarker.type === 'quote') {
                output.push(converted);
                listStack.length = 0;
            } else {
                appendListItem(output, listStack, converted, directMarker.level);
            }
            changed = true;
            continue;
        }

        const normalizedChildResult = normalizeImportedMarkdownBlocks(block?.children || []);
        const nextBlock = normalizedChildResult.changed
            ? { ...block, children: normalizedChildResult.blocks }
            : block;
        output.push(nextBlock);
        if (LIST_BLOCK_TYPES.has(nextBlock?.type)) {
            listStack[0] = nextBlock;
            listStack.length = 1;
        } else {
            listStack.length = 0;
        }
        changed = changed || normalizedChildResult.changed;
    }

    return { blocks: output, changed };
}

const LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

function clipboardTextLooksStructured(text) {
    if (typeof text !== 'string') return false;
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    return lines.some((line) => (
        isPageBreakText(line)
        || /^#{1,6}\s+\S/.test(line)
        || /^>\s+\S/.test(line)
        || /^[-*+]\s+\S/.test(line)
        || /^\d+[.)]\s+\S/.test(line)
        || Object.prototype.hasOwnProperty.call(BULLET_MARKER_LEVELS, line)
    ));
}

export {
    clipboardTextLooksStructured,
    normalizeImportedMarkdownBlocks,
};
