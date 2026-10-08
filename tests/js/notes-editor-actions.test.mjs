import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement, settle } from './helpers/notes-runtime.mjs';

function setupActions() {
    const h = createHarness();
    Object.assign(h.context, h.load('markdown-repair.js', ['normalizeCopiedPlainText']));
    Object.assign(h.context, h.load('block-operations.js', ['removeBlocksAndRestoreCursor']));
    const blocks = ['first', 'second', 'third'].map((id) => ({ id, type: 'paragraph', content: [{ text: id }] }));
    let selected = [blocks[0]];
    let canEdit = true;
    const calls = [];
    const editor = {
        document: blocks,
        getSelection: () => ({ blocks: selected }), getBlock: (id) => blocks.find((block) => block.id === id),
        getTextCursorPosition: () => ({ block: blocks[0] }),
        getNextBlock: (block) => blocks[blocks.indexOf(block) + 1],
        setTextCursorPosition: (block) => calls.push(['cursor', block.id]),
        setSelection: (anchor, head) => calls.push(['selection', anchor.id, head.id]),
        setForceSelectionVisible: (value) => calls.push(['visible', value]),
        focus: () => calls.push(['focus']), removeBlocks: (removed) => calls.push(['remove', removed.map((block) => block.id)]),
        insertBlocks: (copies) => { calls.push(['insert', copies]); return [{ ...copies[0], id: 'copy' }]; },
        moveBlocksUp: () => calls.push(['up']), moveBlocksDown: () => calls.push(['down']),
        updateBlock: (block, payload) => calls.push(['update', block.id, payload]),
    };
    const { createSelectionActions } = h.load('selection-actions.js', ['createSelectionActions']);
    const runtime = createSelectionActions({
        getEditor: () => editor, getCanEdit: () => canEdit,
        updateEditorChrome: () => calls.push(['chrome']), triggerDebouncedSave: () => calls.push(['save']),
    });
    return { ...h, blocks, editor, runtime, calls, select: (values) => { selected = values; }, permit: (value) => { canEdit = value; } };
}

test('block range selection retains its anchor and duplication selects fresh blocks', () => {
    const h = setupActions();
    h.runtime.selectBlockRange(h.blocks[0]);
    h.runtime.selectBlockRange(h.blocks[2], true);
    assert.ok(h.calls.some((call) => call.join() === 'selection,first,third'));
    h.select([h.blocks[0], h.blocks[1]]);
    h.runtime.duplicateSelectedBlocks();
    const copies = h.calls.find(([action]) => action === 'insert')[1];
    assert.equal(copies.length, 2);
    assert.equal(copies[0].id, undefined);
    assert.equal(h.blocks[0].id, 'first', 'original block identity is retained');
    assert.ok(h.calls.some((call) => call.join() === 'cursor,copy'));
    assert.equal(h.calls.filter(([action]) => action === 'save').length, 1);
});

test('selection mutations consult current edit permission at invocation', () => {
    const h = setupActions();
    h.permit(false);
    h.runtime.duplicateSelectedBlocks();
    h.runtime.deleteSelectedBlocks();
    h.runtime.moveSelectedBlocks('up');
    h.runtime.toggleHeadingCollapse({ id: 'heading', type: 'heading', props: {} });
    assert.deepEqual(h.calls, []);
    h.permit(true);
    h.runtime.moveSelectedBlocks('up');
    h.runtime.moveSelectedBlocks('down');
    assert.equal(h.calls.filter(([action]) => action === 'save').length, 2);
});

test('delayed cut removes captured blocks and respects permission changes while copying', async () => {
    for (const revokePermission of [false, true]) {
        const h = setupActions();
        let finishCopy;
        const texts = [];
        h.context.navigator = { clipboard: { writeText: (text) => { texts.push(text); return new Promise((resolve) => { finishCopy = resolve; }); } } };
        const copying = h.runtime.copySelectedBlocks({ cut: true });
        await settle();
        h.select([h.blocks[2]]);
        if (revokePermission) h.permit(false);
        finishCopy();
        await copying;
        assert.deepEqual(texts, ['first']);
        const deletion = h.calls.find(([action]) => action === 'remove');
        assert.equal(Boolean(deletion), !revokePermission);
        if (deletion) assert.equal(deletion[1].join(), 'first');
    }
});

test('history protects initial load baseline and falls back to editor commands', () => {
    const h = createHarness();
    const { createHistoryActions } = h.load('history-actions.js', ['createHistoryActions']);
    let depth = 1;
    let canEdit = true;
    let undos = 0;
    let refreshes = 0;
    const editor = { _tiptapEditor: {
        state: { plugins: [{ key: 'history$test', getState: () => ({ done: { eventCount: depth }, undone: { eventCount: 0 } }) }] },
        commands: { undo: () => { undos++; } }, can: () => ({ undo: () => true }),
    } };
    const runtime = createHistoryActions({ getEditor: () => editor, getCanEdit: () => canEdit, focusEditorBody() {}, updateEditorChrome: () => { refreshes++; } });
    runtime.captureHistoryBaseline();
    runtime.runHistoryAction('undo');
    assert.equal(undos, 0);
    depth++;
    canEdit = false;
    runtime.runHistoryAction('undo');
    assert.equal(undos, 0);
    canEdit = true;
    runtime.runHistoryAction('undo');
    assert.equal(undos, 1);
    editor._tiptapEditor.state.plugins = [];
    runtime.runHistoryAction('undo');
    assert.equal(undos, 2);
    assert.equal(refreshes, 2);
    editor._tiptapEditor.can = () => ({ undo: () => { throw new Error('disposed editor'); } });
    assert.equal(runtime.canRunHistoryAction('undo'), false);
});

test('block conversions preserve text, children and supported visual properties', () => {
    const h = createHarness();
    const properties = h.load('block-properties.js', ['updateBlockPayloadForPreservedText', 'mergedPropsForBlockType']);
    const block = { type: 'paragraph', props: { textAlignment: 'right', textColor: 'red', indentLevel: 3 }, content: [{ text: 'Keep this' }], children: [{ id: 'child' }] };
    const heading = properties.updateBlockPayloadForPreservedText(block, { type: 'heading', props: { level: 2 } });
    assert.equal(heading.content, block.content);
    assert.equal(heading.children, block.children);
    assert.equal(heading.props.textAlignment, 'right');
    assert.equal(heading.props.indentLevel, 3);
    assert.equal(heading.props.level, 2);
    const list = properties.mergedPropsForBlockType('bulletListItem', block);
    assert.equal(list.indentLevel, undefined);
    const table = { type: 'table', content: { rows: [] } };
    assert.equal(properties.updateBlockPayloadForPreservedText(block, table), table);
});

test('style actions preserve inline image attributes and read dynamic permission', () => {
    const h = createHarness();
    Object.assign(h.context, h.load('block-catalog.js', ['FONT_SIZE_PRESETS']));
    Object.assign(h.context, h.load('block-properties.js', ['LIST_BLOCK_TYPES', 'MAX_INDENT_LEVEL', 'blockSupportsVisualIndent', 'visualIndentLevel', 'mergedPropsForBlockType']));
    const { createStyleActions } = h.load('style-actions.js', ['createStyleActions']);
    const calls = [];
    let canEdit = false;
    const editor = { focus() {}, dispatch: (transaction) => calls.push(transaction), _tiptapEditor: { state: {
        selection: { from: 5, node: { type: { name: 'inlineImage' }, attrs: { url: 'image.png', width: 300, alignment: 'right' } } },
        tr: { setNodeMarkup: (position, type, attrs) => ({ position, attrs }) },
    } } };
    const runtime = createStyleActions({
        getEditor: () => editor, getCanEdit: () => canEdit, selectedBlocks: () => [],
        updateEditorChrome() {}, triggerDebouncedSave() {}, focusEditorBody() {}, closeToolbarMenus() {},
    });
    assert.equal(runtime.getSelectedTextAlignment(), 'right');
    runtime.applyTextAlignment('center');
    assert.equal(calls.length, 0);
    canEdit = true;
    runtime.applyTextAlignment('justify');
    assert.equal(calls[0].position, 5);
    assert.equal(calls[0].attrs.url, 'image.png');
    assert.equal(calls[0].attrs.width, 300);
    assert.equal(calls[0].attrs.alignment, 'left');
    assert.equal(calls[0].attrs.layout, 'break');
});

test('collaborative title stops publishing when edit permission changes and cleans observers', () => {
    const h = createHarness();
    const { bindCollaborativeTitle } = h.load('collaboration/collaborative-title.js', ['bindCollaborativeTitle']);
    const title = new FakeElement();
    let value = 'Remote title';
    let observer;
    let canEdit = true;
    let removedObserver = false;
    let removedSynced = false;
    const text = { get length() { return value.length; }, toString: () => value,
        insert: (at, next) => { value = next; }, delete: () => { value = ''; },
        observe: (callback) => { observer = callback; }, unobserve: (callback) => { removedObserver = callback === observer; },
    };
    const cleanup = bindCollaborativeTitle({
        titleInput: title, fallbackTitle: 'Fallback', getCanEdit: () => canEdit,
        session: { ready: true, document: { getText: () => text, transact: (callback) => callback() }, provider: { on() {}, off: () => { removedSynced = true; } } },
    });
    assert.equal(title.value, 'Remote title');
    title.value = 'Local title';
    title.dispatch('input');
    assert.equal(value, 'Local title');
    canEdit = false;
    title.value = 'Unauthorized title';
    title.dispatch('input');
    assert.equal(value, 'Local title');
    value = 'New remote title';
    observer();
    assert.equal(title.value, value);
    cleanup();
    assert.equal(removedObserver && removedSynced, true);
    assert.equal(title.listeners.get('input').size, 0);
});

test('setSelectedBlockType changes selected content, preserves props, and respects permission', () => {
    const h = createHarness();
    Object.assign(h.context, h.load('block-catalog.js', ['FONT_SIZE_PRESETS']));
    Object.assign(h.context, h.load('block-properties.js', ['LIST_BLOCK_TYPES', 'MAX_INDENT_LEVEL', 'blockSupportsVisualIndent', 'visualIndentLevel', 'mergedPropsForBlockType']));
    const { createStyleActions } = h.load('style-actions.js', ['createStyleActions']);
    const blocks = [{ id: 'one', type: 'paragraph', props: { textAlignment: 'right', textColor: 'red' } }, { id: 'two', type: 'paragraph', props: {} }];
    const changes = [];
    let canEdit = false;
    let saves = 0;
    const runtime = createStyleActions({
        getEditor: () => ({ updateBlock: (block, payload) => changes.push({ block, payload }) }),
        getCanEdit: () => canEdit, selectedBlocks: () => blocks,
        focusEditorBody() {}, updateEditorChrome() {}, closeToolbarMenus() {}, triggerDebouncedSave: () => { saves++; },
    });
    runtime.setSelectedBlockType('heading', { level: 2 });
    assert.equal(changes.length, 0);
    canEdit = true;
    runtime.setSelectedBlockType('heading', { level: 2 });
    assert.equal(changes.length, 2);
    assert.equal(changes[0].block, blocks[0]);
    assert.equal(changes[0].payload.type, 'heading');
    assert.equal(changes[0].payload.props.level, 2);
    assert.equal(changes[0].payload.props.textAlignment, 'right');
    assert.equal(changes[0].payload.props.textColor, 'red');
    assert.equal(saves, 1);
});
