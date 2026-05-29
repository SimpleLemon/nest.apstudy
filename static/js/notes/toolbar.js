import * as React from 'react';
import {
    FormattingToolbar,
    BasicTextStyleButton,
    NestBlockButton,
    UnnestBlockButton,
    CreateLinkButton,
    SideMenu,
    AddBlockButton,
    DragHandleButton,
    DragHandleMenu,
    TableRowHeaderItem,
    TableColumnHeaderItem,
    useBlockNoteEditor,
    useComponentsContext,
    useEditorContentOrSelectionChange,
    useSelectedBlocks,
    createReactStyleSpec,
} from '@blocknote/react';
import {
    BlockNoteSchema,
    checkBlockHasDefaultProp,
    checkBlockTypeHasDefaultProp,
    defaultStyleSpecs,
    mapTableCell,
} from '@blocknote/core';

const TEXT_BLOCK_OPTIONS = [
    { label: 'Paragraph', type: 'paragraph', icon: 'subject' },
    { label: 'Heading 1', type: 'heading', props: { level: 1 }, icon: 'text:H1' },
    { label: 'Heading 2', type: 'heading', props: { level: 2 }, icon: 'text:H2' },
    { label: 'Heading 3', type: 'heading', props: { level: 3 }, icon: 'text:H3' },
];
const LIST_STYLE_OPTIONS = [
    { label: 'Bulleted list', type: 'bulletListItem', icon: 'format_list_bulleted' },
    { label: 'Numbered list', type: 'numberedListItem', icon: 'format_list_numbered' },
    { label: 'Checklist', type: 'checkListItem', icon: 'checklist' },
];
const ALIGNMENT_OPTIONS = [
    { label: 'Align left', value: 'left', icon: 'format_align_left' },
    { label: 'Align center', value: 'center', icon: 'format_align_center' },
    { label: 'Align right', value: 'right', icon: 'format_align_right' },
    { label: 'Justify', value: 'justify', icon: 'format_align_justify' },
];

const fontSizeStyle = createReactStyleSpec(
    {
        type: 'fontSize',
        propSchema: 'string',
    },
    {
        render: (props) => React.createElement('span', {
            ref: props.contentRef,
            style: { fontSize: props.value },
        }),
    }
);

export const notesEditorSchema = BlockNoteSchema.create({
    styleSpecs: {
        ...defaultStyleSpecs,
        fontSize: fontSizeStyle,
    },
});

function isMacPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
}

function shortcutLabel(keys) {
    const [firstKey, ...restKeys] = keys;
    if (firstKey !== 'Mod') return keys.join(' ');

    return isMacPlatform()
        ? `⌘${restKeys.join('')}`
        : `Ctrl ${restKeys.join(' ')}`;
}

function tooltipForLabel(label) {
    const normalizedLabel = (label || '').trim().toLowerCase();
    const tooltipMap = {
        bold: `Bold (${shortcutLabel(['Mod', 'B'])})`,
        italic: `Italic (${shortcutLabel(['Mod', 'I'])})`,
        underline: `Underline (${shortcutLabel(['Mod', 'U'])})`,
        strike: `Strikethrough (${shortcutLabel(['Mod', 'Shift', 'X'])})`,
        strikethrough: `Strikethrough (${shortcutLabel(['Mod', 'Shift', 'X'])})`,
        'create link': `Create link (${shortcutLabel(['Mod', 'K'])})`,
        link: `Create link (${shortcutLabel(['Mod', 'K'])})`,
        nest: 'Indent block (Tab)',
        unnest: 'Outdent block (Shift Tab)',
        lists: 'List style',
        'block style': 'Block style',
    };

    return tooltipMap[normalizedLabel] || label;
}

export function applyToolbarTooltips(rootElement) {
    const toolbar = rootElement?.querySelector('.bn-formatting-toolbar');
    if (!toolbar) return;

    toolbar.querySelectorAll('button').forEach((button) => {
        const label = button.getAttribute('aria-label') || button.textContent?.trim();
        if (!label) return;
        button.setAttribute('title', tooltipForLabel(label));
    });
}

function CleanDragHandleMenu(props) {
    return React.createElement(
        DragHandleMenu,
        props,
        React.createElement(TableRowHeaderItem, props, 'Header row'),
        React.createElement(TableColumnHeaderItem, props, 'Header column')
    );
}

export function CleanSideMenu(props) {
    return React.createElement(
        SideMenu,
        props,
        React.createElement(AddBlockButton, props),
        React.createElement(DragHandleButton, { ...props, dragHandleMenu: CleanDragHandleMenu })
    );
}

function ToolbarIcon({ name, className = '' }) {
    if (name.startsWith('text:')) {
        return React.createElement(
            'span',
            {
                className: `notes-toolbar-icon notes-toolbar-text-icon ${className}`.trim(),
                'aria-hidden': 'true',
            },
            name.slice(5)
        );
    }

    return React.createElement(
        'span',
        {
            className: `material-symbols-outlined notes-toolbar-icon ${className}`.trim(),
            'aria-hidden': 'true',
        },
        name
    );
}

function MenuChevron() {
    return React.createElement(ToolbarIcon, { name: 'expand_more', className: 'notes-toolbar-chevron' });
}

function isBlockStyleSelected(block, option) {
    if (!block || block.type !== option.type) return false;
    if (!option.props) return true;

    return Object.entries(option.props).every(([key, value]) => block.props?.[key] === value);
}

function ToolbarGroup({ label, children }) {
    return React.createElement(
        'div',
        {
            className: 'notes-toolbar-group',
            role: 'group',
            'aria-label': label,
        },
        children
    );
}

function BlockStyleDropdown({
    options,
    fallbackLabel = 'Block style',
    fallbackIcon = 'subject',
    triggerClassName = '',
    showLabel = true,
}) {
    const Components = useComponentsContext();
    const editor = useBlockNoteEditor();
    const selectedBlocks = useSelectedBlocks(editor);
    const [block, setBlock] = React.useState(editor.getTextCursorPosition().block);
    const filteredOptions = React.useMemo(
        () => options.filter((option) => option.type in editor.schema.blockSchema),
        [editor, options]
    );
    const selectedOption = filteredOptions.find((option) => isBlockStyleSelected(block, option));
    const displayedOption = selectedOption || {
        label: fallbackLabel,
        icon: fallbackIcon,
    };

    useEditorContentOrSelectionChange(() => {
        setBlock(editor.getTextCursorPosition().block);
    }, editor);

    if (!filteredOptions.length || !editor.isEditable) return null;

    const selectBlockStyle = (option) => {
        editor.focus();
        selectedBlocks.forEach((selectedBlock) => {
            editor.updateBlock(selectedBlock, {
                type: option.type,
                props: option.props,
            });
        });
    };

    return React.createElement(
        Components.Generic.Menu.Root,
        { position: 'bottom-start' },
        React.createElement(
            Components.Generic.Menu.Trigger,
            null,
            React.createElement(
                'button',
                {
                    type: 'button',
                    className: `notes-toolbar-menu-trigger ${triggerClassName}`.trim(),
                    title: fallbackLabel,
                    'aria-label': fallbackLabel,
                    onMouseDown: (event) => event.preventDefault(),
                },
                React.createElement(ToolbarIcon, { name: displayedOption.icon }),
                showLabel
                    ? React.createElement('span', { className: 'notes-toolbar-trigger-label' }, displayedOption.label)
                    : null,
                React.createElement(MenuChevron, null)
            )
        ),
        React.createElement(
            Components.Generic.Menu.Dropdown,
            { className: 'bn-menu-dropdown notes-toolbar-menu notes-style-menu' },
            filteredOptions.map((option) => (
                React.createElement(
                    Components.Generic.Menu.Item,
                    {
                        key: `${option.type}-${option.props?.level || ''}`,
                        className: 'notes-toolbar-menu-item',
                        checked: isBlockStyleSelected(block, option),
                        icon: React.createElement(ToolbarIcon, { name: option.icon }),
                        onClick: () => selectBlockStyle(option),
                    },
                    option.label
                )
            ))
        )
    );
}

function getSelectedTextAlignment(editor, selectedBlocks) {
    const block = selectedBlocks[0];
    if (!block) return 'left';

    if (checkBlockHasDefaultProp('textAlignment', block, editor)) {
        return block.props.textAlignment || 'left';
    }

    if (block.type === 'table') {
        const cellSelection = editor.tableHandles?.getCellSelection();
        if (!cellSelection) return 'left';

        const alignments = cellSelection.cells.map(({ row, col }) => (
            mapTableCell(block.content.rows[row].cells[col]).props.textAlignment
        ));
        const firstAlignment = alignments[0];

        if (alignments.every((alignment) => alignment === firstAlignment)) {
            return firstAlignment || 'left';
        }
    }

    return 'left';
}

function applyTextAlignment(editor, selectedBlocks, textAlignment) {
    editor.focus();

    selectedBlocks.forEach((block) => {
        if (checkBlockTypeHasDefaultProp('textAlignment', block.type, editor)) {
            editor.updateBlock(block, {
                props: { textAlignment },
            });
            return;
        }

        if (block.type !== 'table') return;

        const cellSelection = editor.tableHandles?.getCellSelection();
        if (!cellSelection) return;

        const newTable = block.content.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => mapTableCell(cell)),
        }));

        cellSelection.cells.forEach(({ row, col }) => {
            newTable[row].cells[col].props.textAlignment = textAlignment;
        });

        editor.updateBlock(block, {
            type: 'table',
            content: {
                ...block.content,
                type: 'tableContent',
                rows: newTable,
            },
        });
        editor.setTextCursorPosition(block);
    });
}

function AlignmentDropdown() {
    const Components = useComponentsContext();
    const editor = useBlockNoteEditor();
    const selectedBlocks = useSelectedBlocks(editor);
    const currentAlignment = getSelectedTextAlignment(editor, selectedBlocks);
    const selectedOption = ALIGNMENT_OPTIONS.find((option) => option.value === currentAlignment) || ALIGNMENT_OPTIONS[0];
    const show = selectedBlocks.some((block) => (
        'textAlignment' in block.props || (block.type === 'table' && block.children)
    ));

    if (!show || !editor.isEditable) return null;

    return React.createElement(
        Components.Generic.Menu.Root,
        { position: 'bottom-start' },
        React.createElement(
            Components.Generic.Menu.Trigger,
            null,
            React.createElement(
                'button',
                {
                    type: 'button',
                    className: 'notes-toolbar-menu-trigger notes-align-trigger',
                    title: selectedOption.label,
                    'aria-label': selectedOption.label,
                    onMouseDown: (event) => event.preventDefault(),
                },
                React.createElement(ToolbarIcon, { name: selectedOption.icon }),
                React.createElement(MenuChevron, null)
            )
        ),
        React.createElement(
            Components.Generic.Menu.Dropdown,
            { className: 'bn-menu-dropdown notes-toolbar-menu notes-align-menu' },
            ALIGNMENT_OPTIONS.map((option) => (
                React.createElement(
                    Components.Generic.Menu.Item,
                    {
                        key: option.value,
                        className: 'notes-toolbar-menu-item',
                        checked: currentAlignment === option.value,
                        icon: React.createElement(ToolbarIcon, { name: option.icon }),
                        onClick: () => applyTextAlignment(editor, selectedBlocks, option.value),
                    },
                    option.label
                )
            ))
        )
    );
}

export function ContextualNotesToolbar() {
    return React.createElement(
        FormattingToolbar,
        null,
        React.createElement(
            ToolbarGroup,
            { label: 'Block type' },
            React.createElement(BlockStyleDropdown, {
                options: TEXT_BLOCK_OPTIONS,
                fallbackLabel: 'Block style',
                fallbackIcon: 'subject',
                triggerClassName: 'notes-style-trigger',
            })
        ),
        React.createElement(
            ToolbarGroup,
            { label: 'Text style' },
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'bold' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'italic' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'underline' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'strike' })
        ),
        React.createElement(
            ToolbarGroup,
            { label: 'Code' },
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'code' })
        ),
        React.createElement(
            ToolbarGroup,
            { label: 'Alignment' },
            React.createElement(AlignmentDropdown, null)
        ),
        React.createElement(
            ToolbarGroup,
            { label: 'Lists' },
            React.createElement(BlockStyleDropdown, {
                options: LIST_STYLE_OPTIONS,
                fallbackLabel: 'Lists',
                fallbackIcon: 'format_list_bulleted',
                triggerClassName: 'notes-list-trigger',
                showLabel: false,
            }),
            React.createElement(NestBlockButton, null),
            React.createElement(UnnestBlockButton, null)
        ),
        React.createElement(
            ToolbarGroup,
            { label: 'Link' },
            React.createElement(CreateLinkButton, null)
        )
    );
}
