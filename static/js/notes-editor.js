import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    useCreateBlockNote,
    FormattingToolbar,
    BasicTextStyleButton,
    NestBlockButton,
    UnnestBlockButton,
    CreateLinkButton,
    SideMenuController,
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
import { BlockNoteView } from '@blocknote/mantine';
import {
    BlockNoteSchema,
    checkBlockHasDefaultProp,
    checkBlockTypeHasDefaultProp,
    defaultStyleSpecs,
    mapTableCell,
} from '@blocknote/core';

const noteId = window.location.pathname.split('/').pop();
const SAVE_DEBOUNCE_MS = 800;
const SAVED_TIME_REFRESH_MS = 60000;
const LOADER_STYLE_ID = 'apstudy-theme-loader-styles';
const COLOR_OPTIONS = [
    { key: 'default', label: 'Default', text: 'currentColor', highlight: 'transparent' },
    { key: 'gray', label: 'Gray', text: '#9b9a97', highlight: '#ebeced' },
    { key: 'brown', label: 'Brown', text: '#64473a', highlight: '#e9e5e3' },
    { key: 'red', label: 'Red', text: '#e03e3e', highlight: '#fbe4e4' },
    { key: 'orange', label: 'Orange', text: '#d9730d', highlight: '#f6e9d9' },
    { key: 'yellow', label: 'Yellow', text: '#dfab01', highlight: '#fbf3db' },
    { key: 'green', label: 'Green', text: '#4d6461', highlight: '#ddedea' },
    { key: 'blue', label: 'Blue', text: '#0b6e99', highlight: '#ddebf1' },
    { key: 'purple', label: 'Purple', text: '#6940a5', highlight: '#eae4f2' },
    { key: 'pink', label: 'Pink', text: '#ad1a72', highlight: '#f4dfeb' },
];
const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 24, 28, 32, 40];
const DEFAULT_FONT_SIZE = 16;
const BLOCK_STYLE_OPTIONS = [
    { label: 'Paragraph', type: 'paragraph', icon: 'subject' },
    { label: 'Heading 1', type: 'heading', props: { level: 1 }, icon: 'text:H1' },
    { label: 'Heading 2', type: 'heading', props: { level: 2 }, icon: 'text:H2' },
    { label: 'Heading 3', type: 'heading', props: { level: 3 }, icon: 'text:H3' },
    { label: 'Quote', type: 'quote', icon: 'format_quote' },
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
const notesEditorSchema = BlockNoteSchema.create({
    styleSpecs: {
        ...defaultStyleSpecs,
        fontSize: fontSizeStyle,
    },
});

let editorInstance = null;
let saveDebounceTimer = null;
let savedTimeRefreshTimer = null;
let lastSavedAt = null;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');

function ensureThemeLoaderStyles() {
    if (document.getElementById(LOADER_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = LOADER_STYLE_ID;
    style.textContent = `
        .loader {
            display: inline-block;
            border-radius: 9999px;
            background: linear-gradient(180deg, rgba(99, 102, 241, 0.25), rgba(99, 102, 241, 0.08));
            position: relative;
            overflow: hidden;
        }
        .loader::before,
        .loader::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
        }
        .loader::before {
            border: 2px solid rgba(255, 255, 255, 0.14);
        }
        .loader::after {
            inset: 18%;
            border-radius: 9999px;
            border: 3px solid transparent;
            border-top-color: var(--border-accent, #6366f1);
            animation: apstudyLoaderRotation 0.85s linear infinite;
        }
        @keyframes apstudyLoaderRotation {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
}

function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
    ensureThemeLoaderStyles();
    const sizePx = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
    const textToneClass = options.textToneClass || 'text-on-surface-variant';
    return `
        <div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${textToneClass}">
            <span class="loader" style="width:${sizePx}px; height:${sizePx}px;" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
}

function getColorOption(colorKey) {
    return COLOR_OPTIONS.find((option) => option.key === colorKey) || COLOR_OPTIONS[0];
}

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
        colors: 'Text color',
    };

    return tooltipMap[normalizedLabel] || label;
}

function applyToolbarTooltips(rootElement) {
    const toolbar = rootElement?.querySelector('.bn-formatting-toolbar');
    if (!toolbar) return;

    toolbar.querySelectorAll('button').forEach((button) => {
        const label = button.getAttribute('aria-label') || button.textContent?.trim();
        if (!label) return;
        button.setAttribute('title', tooltipForLabel(label));
    });
}

function parseSavedDate(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeSavedTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds} sec ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes} min ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours} hr ago`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) {
        return `${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
    }

    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    });
}

function clearSavedTimeRefresh() {
    if (savedTimeRefreshTimer) {
        clearInterval(savedTimeRefreshTimer);
        savedTimeRefreshTimer = null;
    }
}

function renderSavedTime() {
    if (!saveStatus || !lastSavedAt) return;
    saveStatus.textContent = `Saved ${formatRelativeSavedTime(lastSavedAt)}`;
}

function setLastSavedAt(value) {
    lastSavedAt = parseSavedDate(value) || new Date();
    renderSavedTime();
    clearSavedTimeRefresh();
    savedTimeRefreshTimer = window.setInterval(renderSavedTime, SAVED_TIME_REFRESH_MS);
}

function setSaveStatus(status, options = {}) {
    if (!saveStatus) return;

    saveStatus.classList.remove(
        'save-status-hidden',
        'save-status-saving',
        'save-status-saved',
        'save-status-error'
    );

    if (status === 'saving') {
        clearSavedTimeRefresh();
        saveStatus.textContent = 'Saving...';
        saveStatus.classList.add('save-status-saving');
        return;
    }

    if (status === 'saved') {
        setLastSavedAt(options.savedAt);
        saveStatus.classList.add('save-status-saved');
        return;
    }

    if (status === 'error') {
        clearSavedTimeRefresh();
        saveStatus.textContent = 'Save failed';
        saveStatus.classList.add('save-status-error');
    }
}

async function saveNote() {
    if (!noteId || !titleInput || !editorInstance) return;

    setSaveStatus('saving');

    try {
        const response = await fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        });

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        const updatedNote = await response.json();
        setSaveStatus('saved', { savedAt: updatedNote?.updated_at });
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}

function triggerDebouncedSave() {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, SAVE_DEBOUNCE_MS);
}

function CleanDragHandleMenu(props) {
    return React.createElement(
        DragHandleMenu,
        props,
        React.createElement(TableRowHeaderItem, props, 'Header row'),
        React.createElement(TableColumnHeaderItem, props, 'Header column')
    );
}

function CleanSideMenu(props) {
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

function BlockStyleDropdown() {
    const Components = useComponentsContext();
    const editor = useBlockNoteEditor();
    const selectedBlocks = useSelectedBlocks(editor);
    const [block, setBlock] = React.useState(editor.getTextCursorPosition().block);
    const filteredOptions = React.useMemo(
        () => BLOCK_STYLE_OPTIONS.filter((option) => option.type in editor.schema.blockSchema),
        [editor]
    );
    const selectedOption = filteredOptions.find((option) => isBlockStyleSelected(block, option));

    useEditorContentOrSelectionChange(() => {
        setBlock(editor.getTextCursorPosition().block);
    }, editor);

    if (!selectedOption || !editor.isEditable) return null;

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
                    className: 'notes-toolbar-menu-trigger notes-style-trigger',
                    title: 'Block style',
                    'aria-label': 'Block style',
                    onMouseDown: (event) => event.preventDefault(),
                },
                React.createElement(ToolbarIcon, { name: selectedOption.icon }),
                React.createElement('span', { className: 'notes-toolbar-trigger-label' }, selectedOption.label),
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

function normalizeFontSize(value) {
    if (typeof value !== 'string') return DEFAULT_FONT_SIZE;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_FONT_SIZE;
}

function clampFontSize(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;

    return Math.min(96, Math.max(8, parsed));
}

function nearestFontSizeIndex(fontSize) {
    const nearest = FONT_SIZE_OPTIONS.reduce((bestIndex, option, index) => {
        const bestDistance = Math.abs(FONT_SIZE_OPTIONS[bestIndex] - fontSize);
        const nextDistance = Math.abs(option - fontSize);
        return nextDistance < bestDistance ? index : bestIndex;
    }, 0);

    return nearest;
}

function FontSizeControl() {
    const Components = useComponentsContext();
    const editor = useBlockNoteEditor();
    const selectedBlocks = useSelectedBlocks(editor);
    const fontSizeInSchema = editor.schema.styleSchema.fontSize?.propSchema === 'string';
    const [currentFontSize, setCurrentFontSize] = React.useState(
        normalizeFontSize(editor.getActiveStyles().fontSize)
    );
    const [fontSizeDraft, setFontSizeDraft] = React.useState(String(currentFontSize));
    const show = fontSizeInSchema && selectedBlocks.some((block) => block.content !== undefined);

    useEditorContentOrSelectionChange(() => {
        if (fontSizeInSchema) {
            const nextFontSize = normalizeFontSize(editor.getActiveStyles().fontSize);
            setCurrentFontSize(nextFontSize);
            setFontSizeDraft(String(nextFontSize));
        }
    }, editor);

    const applyFontSize = React.useCallback((fontSize) => {
        if (fontSize === DEFAULT_FONT_SIZE) {
            editor.removeStyles({ fontSize: `${fontSize}px` });
        } else {
            editor.addStyles({ fontSize: `${fontSize}px` });
        }

        setCurrentFontSize(fontSize);
        window.setTimeout(() => {
            editor.focus();
        });
    }, [editor]);

    const applyDraftFontSize = React.useCallback(() => {
        const nextFontSize = clampFontSize(fontSizeDraft);
        applyFontSize(nextFontSize);
        setFontSizeDraft(String(nextFontSize));
    }, [applyFontSize, fontSizeDraft]);

    if (!show || !editor.isEditable) return null;

    const currentIndex = nearestFontSizeIndex(currentFontSize);
    const smallerSize = FONT_SIZE_OPTIONS[Math.max(0, currentIndex - 1)];
    const largerSize = FONT_SIZE_OPTIONS[Math.min(FONT_SIZE_OPTIONS.length - 1, currentIndex + 1)];

    return React.createElement(
        'div',
        { className: 'notes-font-size-control', role: 'group', 'aria-label': 'Font size' },
        React.createElement(
            'button',
            {
                type: 'button',
                className: 'notes-font-size-step',
                title: 'Decrease font size',
                'aria-label': 'Decrease font size',
                disabled: currentFontSize <= FONT_SIZE_OPTIONS[0],
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => applyFontSize(smallerSize),
            },
            React.createElement(ToolbarIcon, { name: 'remove' })
        ),
        React.createElement(
            Components.Generic.Menu.Root,
            { position: 'bottom-start' },
            React.createElement(
                Components.Generic.Menu.Trigger,
                null,
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        className: 'notes-font-size-value',
                        title: 'Font size',
                        'aria-label': 'Font size',
                        onMouseDown: (event) => event.preventDefault(),
                    },
                    React.createElement('span', { className: 'notes-font-size-value-text' }, currentFontSize),
                    React.createElement(MenuChevron, null)
                )
            ),
            React.createElement(
                Components.Generic.Menu.Dropdown,
                { className: 'bn-menu-dropdown notes-toolbar-menu notes-font-size-menu' },
                React.createElement(
                    'div',
                    {
                        className: 'notes-font-size-custom',
                        onClick: (event) => event.stopPropagation(),
                        onMouseDown: (event) => event.stopPropagation(),
                    },
                    React.createElement('label', { className: 'notes-font-size-custom-label', htmlFor: 'notes-font-size-input' }, 'Custom size'),
                    React.createElement(
                        'div',
                        { className: 'notes-font-size-input-row' },
                        React.createElement('input', {
                            id: 'notes-font-size-input',
                            className: 'notes-font-size-input',
                            inputMode: 'numeric',
                            min: '8',
                            max: '96',
                            type: 'number',
                            value: fontSizeDraft,
                            onChange: (event) => setFontSizeDraft(event.target.value),
                            onKeyDown: (event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    applyDraftFontSize();
                                }
                            },
                        }),
                        React.createElement(
                            'button',
                            {
                                type: 'button',
                                className: 'notes-font-size-apply',
                                onClick: applyDraftFontSize,
                            },
                            'Apply'
                        )
                    )
                ),
                FONT_SIZE_OPTIONS.map((fontSize) => (
                    React.createElement(
                        Components.Generic.Menu.Item,
                        {
                            key: fontSize,
                            className: 'notes-toolbar-menu-item',
                            checked: currentFontSize === fontSize,
                            onClick: () => applyFontSize(fontSize),
                        },
                        `${fontSize}px`
                    )
                ))
            )
        ),
        React.createElement(
            'button',
            {
                type: 'button',
                className: 'notes-font-size-step',
                title: 'Increase font size',
                'aria-label': 'Increase font size',
                disabled: currentFontSize >= FONT_SIZE_OPTIONS[FONT_SIZE_OPTIONS.length - 1],
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => applyFontSize(largerSize),
            },
            React.createElement(ToolbarIcon, { name: 'add' })
        )
    );
}

function ColorSwatch({ color, type }) {
    const colorOption = getColorOption(color);
    const backgroundColor = type === 'highlight' ? colorOption.highlight : colorOption.text;
    const className = [
        'notes-color-swatch',
        type === 'highlight' ? 'notes-color-swatch-highlight' : 'notes-color-swatch-text',
        color === 'default' ? 'notes-color-swatch-default' : '',
    ].filter(Boolean).join(' ');

    return React.createElement('span', {
        className,
        style: { '--notes-swatch-color': backgroundColor },
        'aria-hidden': 'true',
    });
}

function ColorMenuSection({ title, type, currentColor, onSelect }) {
    const Components = useComponentsContext();

    return React.createElement(
        React.Fragment,
        null,
        React.createElement(Components.Generic.Menu.Label, { className: 'notes-color-menu-label' }, title),
        COLOR_OPTIONS.map((color) => (
            React.createElement(
                Components.Generic.Menu.Item,
                {
                    key: `${type}-${color.key}`,
                    className: 'notes-color-menu-item',
                    checked: currentColor === color.key,
                    icon: React.createElement(ColorSwatch, { color: color.key, type }),
                    onClick: () => onSelect(color.key),
                },
                color.label
            )
        ))
    );
}

function TextColorDropdown() {
    const Components = useComponentsContext();
    const editor = useBlockNoteEditor();
    const selectedBlocks = useSelectedBlocks(editor);
    const textColorInSchema = editor.schema.styleSchema.textColor?.propSchema === 'string';
    const highlightColorInSchema = editor.schema.styleSchema.backgroundColor?.propSchema === 'string';
    const [currentTextColor, setCurrentTextColor] = React.useState(
        textColorInSchema ? editor.getActiveStyles().textColor || 'default' : 'default'
    );
    const [currentHighlightColor, setCurrentHighlightColor] = React.useState(
        highlightColorInSchema ? editor.getActiveStyles().backgroundColor || 'default' : 'default'
    );

    useEditorContentOrSelectionChange(() => {
        if (textColorInSchema) {
            setCurrentTextColor(editor.getActiveStyles().textColor || 'default');
        }
        if (highlightColorInSchema) {
            setCurrentHighlightColor(editor.getActiveStyles().backgroundColor || 'default');
        }
    }, editor);

    const applyStyle = React.useCallback((styleName, color) => {
        if (color === 'default') {
            editor.removeStyles({ [styleName]: color });
        } else {
            editor.addStyles({ [styleName]: color });
        }

        window.setTimeout(() => {
            editor.focus();
        });
    }, [editor]);

    const show = React.useMemo(() => {
        if (!textColorInSchema && !highlightColorInSchema) return false;
        return selectedBlocks.some((block) => block.content !== undefined);
    }, [highlightColorInSchema, selectedBlocks, textColorInSchema]);

    if (!show || !editor.isEditable) return null;

    return React.createElement(
        Components.Generic.Menu.Root,
        { position: 'bottom-start' },
        React.createElement(
            Components.Generic.Menu.Trigger,
            null,
            React.createElement(Components.FormattingToolbar.Button, {
                className: 'bn-button notes-color-trigger',
                label: 'Text color',
                mainTooltip: 'Text color',
                icon: React.createElement(
                    'span',
                    {
                        className: 'notes-color-trigger-icon',
                        style: {
                            '--notes-current-text-color': getColorOption(currentTextColor).text,
                            '--notes-current-highlight-color': getColorOption(currentHighlightColor).highlight,
                        },
                        'aria-hidden': 'true',
                    },
                    'A'
                ),
            })
        ),
        React.createElement(
            Components.Generic.Menu.Dropdown,
            { className: 'bn-menu-dropdown bn-color-picker-dropdown notes-color-menu' },
            textColorInSchema
                ? React.createElement(ColorMenuSection, {
                    title: 'Text color',
                    type: 'text',
                    currentColor: currentTextColor,
                    onSelect: (color) => applyStyle('textColor', color),
                })
                : null,
            highlightColorInSchema
                ? React.createElement(ColorMenuSection, {
                    title: 'Highlight color',
                    type: 'highlight',
                    currentColor: currentHighlightColor,
                    onSelect: (color) => applyStyle('backgroundColor', color),
                })
                : null
        )
    );
}

function NoteEditor({ initialContent }) {
    const editor = useCreateBlockNote({
        initialContent,
        schema: notesEditorSchema,
        placeholders: {
            default: undefined,
            emptyDocument: "Enter text or type '/' for commands",
        },
    });

    React.useEffect(() => {
        editorInstance = editor;

        return () => {
            if (editorInstance === editor) {
                editorInstance = null;
            }
        };
    }, [editor]);

    React.useEffect(() => {
        const rootElement = document.getElementById('blocknote-root');
        if (!rootElement) return undefined;

        applyToolbarTooltips(rootElement);
        const observer = new MutationObserver(() => {
            applyToolbarTooltips(rootElement);
        });
        observer.observe(rootElement, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, []);

    return React.createElement(
        BlockNoteView,
        {
            editor,
            formattingToolbar: false,
            sideMenu: false,
            theme: 'dark',
            onChange: () => {
                triggerDebouncedSave();
            },
        },
        React.createElement(
            FormattingToolbar,
            null,
            React.createElement(BlockStyleDropdown, null),
            React.createElement(FontSizeControl, null),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'bold' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'italic' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'underline' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'strike' }),
            React.createElement(BasicTextStyleButton, { basicTextStyle: 'code' }),
            React.createElement(TextColorDropdown, null),
            React.createElement(AlignmentDropdown, null),
            React.createElement(NestBlockButton, null),
            React.createElement(UnnestBlockButton, null),
            React.createElement(CreateLinkButton, null)
        ),
        React.createElement(SideMenuController, { sideMenu: CleanSideMenu })
    );
}

async function initEditorPage() {
    if (!noteId || !titleInput) return;

    const rootElement = document.getElementById('blocknote-root');
    if (!rootElement) return;

    rootElement.innerHTML = `
        <div class="rounded-2xl border border-outline-variant/20 bg-surface-container p-10 text-center min-h-[320px] flex items-center justify-center">
            ${buildLoadingIndicatorHtml('Loading note...', { sizePx: 54, textToneClass: 'text-on-surface' })}
        </div>
    `;

    let note = null;

    try {
        const response = await fetch(`/api/notes/${noteId}`, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Failed to fetch note');
        }
        note = await response.json();
    } catch (error) {
        console.error(error);
    }

    const noteTitle = typeof note?.title === 'string' ? note.title : '';
    titleInput.value = noteTitle;
    if (note?.updated_at) {
        setSaveStatus('saved', { savedAt: note.updated_at });
    }

    let parsedContent = undefined;
    if (typeof note?.content === 'string' && note.content.trim() !== '') {
        try {
            parsedContent = JSON.parse(note.content);
        } catch (error) {
            parsedContent = undefined;
        }
    }

    const root = createRoot(rootElement);

    try {
        root.render(React.createElement(NoteEditor, { initialContent: parsedContent }));
    } catch (error) {
        console.error('Failed to mount note editor', error);
        setSaveStatus('error');
    }

    titleInput.addEventListener('input', () => {
        triggerDebouncedSave();
    });
}

initEditorPage();
