import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
    useCreateBlockNote,
    FormattingToolbar,
    FormattingToolbarController,
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
let noteHasPendingChanges = false;

const titleInput = document.getElementById('note-title-input');
const saveStatus = document.getElementById('save-status');

function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
    return window.APStudyLoader.html(label, options);
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
        lists: 'List style',
        'block style': 'Block style',
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
        const response = await (window.APStudyPendingMutations?.track(fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        }), 'notes-save') || fetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: titleInput.value,
                content: JSON.stringify(editorInstance.document),
            }),
        }));

        if (!response.ok) {
            throw new Error('Save request failed');
        }

        const updatedNote = await response.json();
        noteHasPendingChanges = false;
        setSaveStatus('saved', { savedAt: updatedNote?.updated_at });
    } catch (error) {
        console.error(error);
        setSaveStatus('error');
    }
}

function triggerDebouncedSave() {
    noteHasPendingChanges = true;
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = window.setTimeout(() => {
        saveNote();
    }, SAVE_DEBOUNCE_MS);
}

window.addEventListener('beforeunload', (event) => {
    if (!noteHasPendingChanges) return;
    event.preventDefault();
    event.returnValue = '';
});

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

function ContextualNotesToolbar() {
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
        React.createElement(FormattingToolbarController, {
            formattingToolbar: ContextualNotesToolbar,
        }),
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
        const response = await fetch(`/api/notes/${noteId}`);
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
