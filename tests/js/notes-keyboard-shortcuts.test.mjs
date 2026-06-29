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
