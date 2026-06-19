export const FORMAT_COLORS = [
    { value: 'default', label: 'Default' },
    { value: 'gray', label: 'Gray' },
    { value: 'brown', label: 'Brown' },
    { value: 'red', label: 'Red' },
    { value: 'orange', label: 'Orange' },
    { value: 'yellow', label: 'Yellow' },
    { value: 'green', label: 'Green' },
    { value: 'blue', label: 'Blue' },
    { value: 'purple', label: 'Purple' },
    { value: 'pink', label: 'Pink' },
];

export const FONT_SIZE_PRESETS = [
    { value: 'default', label: 'Normal', cssValue: '' },
    { value: 'small', label: 'Small', cssValue: '0.875em' },
    { value: 'large', label: 'Large', cssValue: '1.125em' },
    { value: 'xl', label: 'XL', cssValue: '1.35em' },
    { value: 'title', label: 'Title', cssValue: '1.7em' },
];

export const BLOCK_CATALOG = [
    {
        key: 'paragraph',
        group: 'Basic',
        label: 'Paragraph',
        description: 'Start with plain text',
        icon: 'subject',
        aliases: ['text', 'plain'],
        type: 'paragraph',
        turnInto: true,
    },
    {
        key: 'heading-1',
        group: 'Basic',
        label: 'Heading 1',
        description: 'Top-level section title',
        icon: 'H1',
        aliases: ['h1', 'title'],
        type: 'heading',
        props: { level: 1, indentLevel: 0, isCollapsed: false },
        turnInto: true,
    },
    {
        key: 'heading-2',
        group: 'Basic',
        label: 'Heading 2',
        description: 'Major subsection title',
        icon: 'H2',
        aliases: ['h2', 'subtitle'],
        type: 'heading',
        props: { level: 2, indentLevel: 0, isCollapsed: false },
        turnInto: true,
    },
    {
        key: 'heading-3',
        group: 'Basic',
        label: 'Heading 3',
        description: 'Small section label',
        icon: 'H3',
        aliases: ['h3'],
        type: 'heading',
        props: { level: 3, indentLevel: 0, isCollapsed: false },
        turnInto: true,
    },
    {
        key: 'bullet-list',
        group: 'Lists',
        label: 'Bulleted list',
        description: 'Collect quick points',
        icon: 'format_list_bulleted',
        aliases: ['bullet', 'ul'],
        type: 'bulletListItem',
        turnInto: true,
    },
    {
        key: 'numbered-list',
        group: 'Lists',
        label: 'Numbered list',
        description: 'Track ordered steps',
        icon: 'format_list_numbered',
        aliases: ['number', 'ordered', 'ol'],
        type: 'numberedListItem',
        turnInto: true,
    },
    {
        key: 'check-list',
        group: 'Lists',
        label: 'Checklist',
        description: 'Make a quick task list',
        icon: 'checklist',
        aliases: ['todo', 'task', 'checkbox'],
        type: 'checkListItem',
        props: { checked: false },
        turnInto: true,
    },
    {
        key: 'quote',
        group: 'Structure',
        label: 'Quote',
        description: 'Call out an important idea',
        icon: 'format_quote',
        aliases: ['blockquote'],
        type: 'quote',
        turnInto: true,
    },
    {
        key: 'code-block',
        group: 'Structure',
        label: 'Code block',
        description: 'Write code or commands',
        icon: 'code_blocks',
        aliases: ['code', 'pre'],
        type: 'codeBlock',
        props: { language: '' },
        turnInto: true,
    },
    {
        key: 'table',
        group: 'Structure',
        label: 'Table',
        description: 'Insert a 3 by 3 table',
        icon: 'table',
        aliases: ['grid', 'cells'],
        type: 'table',
        atom: true,
    },
    {
        key: 'divider',
        group: 'Structure',
        label: 'Divider',
        description: 'Separate sections',
        icon: 'horizontal_rule',
        aliases: ['line', 'rule', 'hr'],
        type: 'divider',
        atom: true,
    },
    {
        key: 'callout',
        group: 'Rich',
        label: 'Callout',
        description: 'Highlight a note',
        icon: 'lightbulb',
        aliases: ['notice', 'alert', 'info'],
        type: 'callout',
        props: { tone: 'info', icon: 'lightbulb' },
        turnInto: true,
    },
    {
        key: 'bookmark',
        group: 'Rich',
        label: 'Bookmark',
        description: 'Preview a web link',
        icon: 'bookmarks',
        aliases: ['link preview', 'url', 'embed'],
        type: 'bookmark',
        requiresUrl: true,
        atom: true,
    },
    {
        key: 'image',
        group: 'Media',
        label: 'Image',
        description: 'Embed an image URL',
        icon: 'image',
        aliases: ['photo', 'picture'],
        type: 'image',
        requiresUrl: true,
        atom: true,
    },
    {
        key: 'video',
        group: 'Media',
        label: 'Video',
        description: 'Embed a video URL',
        icon: 'smart_display',
        aliases: ['movie', 'media'],
        type: 'video',
        requiresUrl: true,
        atom: true,
    },
];

export function blockIconClass(icon) {
    return icon?.startsWith?.('H') ? 'notes-toolbar-text-icon' : 'material-symbols-outlined';
}

export function blockMatchesQuery(item, query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return true;
    const haystack = [
        item.label,
        item.description,
        item.group,
        item.type,
        item.key,
        ...(item.aliases || []),
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
}

export function filterBlockCatalog(query, { includeAtoms = true, turnIntoOnly = false } = {}) {
    return BLOCK_CATALOG.filter((item) => {
        if (!includeAtoms && item.atom) return false;
        if (turnIntoOnly && !item.turnInto) return false;
        return blockMatchesQuery(item, query);
    });
}

export function tableBlockPayload() {
    return {
        type: 'table',
        content: {
            type: 'tableContent',
            rows: Array.from({ length: 3 }, () => ({
                cells: Array.from({ length: 3 }, () => [{
                    type: 'paragraph',
                    content: [],
                }]),
            })),
        },
    };
}

export function blockPayloadForCatalogItem(item, extra = {}) {
    if (!item) return { type: 'paragraph' };
    if (item.type === 'table') return tableBlockPayload();
    if (item.type === 'image' || item.type === 'video') {
        return {
            type: item.type,
            props: {
                url: extra.url || '',
                name: extra.name || '',
                caption: extra.caption || '',
                showPreview: true,
                previewWidth: 512,
            },
        };
    }
    if (item.type === 'bookmark') {
        return {
            type: 'bookmark',
            props: {
                url: extra.url || '',
                title: extra.title || extra.url || '',
                description: extra.description || '',
                imageUrl: extra.imageUrl || extra.image_url || '',
                siteName: extra.siteName || extra.site_name || '',
                faviconUrl: extra.faviconUrl || '',
                contentType: extra.contentType || extra.content_type || '',
            },
        };
    }
    const block = { type: item.type };
    if (item.props) block.props = { ...item.props };
    return block;
}

export function catalogItemByKey(key) {
    return BLOCK_CATALOG.find((item) => item.key === key) || null;
}

export function catalogItemByType(type, props = {}) {
    if (type === 'heading') {
        const level = Number(props.level || 1);
        return BLOCK_CATALOG.find((item) => item.type === 'heading' && Number(item.props?.level) === level) || null;
    }
    return BLOCK_CATALOG.find((item) => item.type === type) || null;
}
