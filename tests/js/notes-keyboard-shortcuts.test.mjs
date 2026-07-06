import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function importKeyboardHelpers() {
    const source = await readFile(
        path.join(repoRoot, 'static/js/notes/editor/keyboard-shortcuts-helpers.js'),
        'utf8',
    );
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function importSelectAllHelpers() {
    const headingCollapse = await readFile(
        path.join(repoRoot, 'static/js/notes/editor/heading-collapse.js'),
        'utf8',
    );
    const selectAll = await readFile(
        path.join(repoRoot, 'static/js/notes/editor/keyboard-shortcuts-select-all.js'),
        'utf8',
    );
    const bundled = `${headingCollapse}\n${selectAll.replace(/^import .*heading-collapse\.js';\n/, '')}`;
    return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`);
}

function editorState() {
    const insertedNode = { type: 'hardBreak' };
    const transaction = {
        insertedNode: null,
        scrolled: false,
        replaceSelectionWith(node) {
            this.insertedNode = node;
            return this;
        },
        scrollIntoView() {
            this.scrolled = true;
            return this;
        },
    };
    return {
        insertedNode,
        state: {
            schema: { nodes: { hardBreak: { create: () => insertedNode } } },
            tr: transaction,
        },
        transaction,
    };
}

for (const blockType of ['bulletListItem', 'numberedListItem', 'checkListItem']) {
    test(`Shift+Enter inserts a hard break in ${blockType}`, async () => {
        const { insertListHardBreak } = await importKeyboardHelpers();
        const { state, insertedNode, transaction } = editorState();
        let dispatched = null;

        assert.equal(insertListHardBreak(state, blockType, (value) => { dispatched = value; }), true);
        assert.equal(transaction.insertedNode, insertedNode);
        assert.equal(transaction.scrolled, true);
        assert.equal(dispatched, transaction);
    });
}

test('Shift+Enter falls through outside list items', async () => {
    const { insertListHardBreak } = await importKeyboardHelpers();
    const { state, transaction } = editorState();
    let dispatched = false;

    assert.equal(insertListHardBreak(state, 'paragraph', () => { dispatched = true; }), false);
    assert.equal(transaction.insertedNode, null);
    assert.equal(dispatched, false);
});

test('visibleTopLevelBlocks skips blocks hidden by collapsed headings', async () => {
    const { visibleTopLevelBlocks } = await importSelectAllHelpers();
    const blocks = [
        { id: 'h1', type: 'heading', props: { level: 1, isCollapsed: true } },
        { id: 'hidden', type: 'paragraph', content: [{ type: 'text', text: 'Hidden' }] },
        { id: 'h2', type: 'heading', props: { level: 1, isCollapsed: false } },
        { id: 'visible', type: 'paragraph', content: [{ type: 'text', text: 'Visible' }] },
    ];
    assert.deepEqual(visibleTopLevelBlocks(blocks).map((block) => block.id), ['h1', 'h2', 'visible']);
});

test('shouldSelectAllBlocks advances when the current block text is fully selected', async () => {
    const { shouldSelectAllBlocks } = await importSelectAllHelpers();
    const blockNoteEditor = {
        getSelection: () => undefined,
        getTextCursorPosition: () => ({
            block: { id: 'p1', content: [{ type: 'text', text: 'Hello' }] },
        }),
        _tiptapEditor: {
            state: {
                selection: { empty: false, from: 1, to: 6 },
                doc: { textBetween: () => 'Hello' },
            },
        },
    };
    assert.equal(shouldSelectAllBlocks(blockNoteEditor), true);
});

test('selectAllVisibleBlocks selects the first and last visible blocks', async () => {
    const { selectAllVisibleBlocks } = await importSelectAllHelpers();
    const first = { id: 'a', type: 'paragraph' };
    const last = { id: 'c', type: 'paragraph' };
    let selected = null;
    let forceVisible = false;
    const blockNoteEditor = {
        document: [first, { id: 'b', type: 'paragraph' }, last],
        setSelection: (start, end) => { selected = [start, end]; },
        setForceSelectionVisible: (value) => { forceVisible = value; },
    };
    assert.equal(selectAllVisibleBlocks(blockNoteEditor), true);
    assert.deepEqual(selected, [first, last]);
    assert.equal(forceVisible, true);
});

test('select-all shortcut module wires Mod-a with editor-body focus guard', async () => {
    const source = await readFile(
        path.join(repoRoot, 'static/js/notes/editor/keyboard-shortcuts.js'),
        'utf8',
    );
    assert.match(source, /export function createSelectAllShortcuts\(getBlockNoteEditor\)/);
    assert.match(source, /'Mod-a'/);
    assert.match(source, /isEditorBodyFocused\(\)/);
    assert.match(source, /shouldSelectAllBlocks\(blockNoteEditor\)/);
    assert.match(source, /selectAllVisibleBlocks\(blockNoteEditor\)/);
});
