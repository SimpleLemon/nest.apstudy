import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function importBrowserModule(relativePath) {
    const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return import(url);
}

function createEditor(ids) {
    let blocks = ids.map((id) => ({ id, type: 'paragraph' }));
    let cursorId = null;
    return {
        get document() { return blocks; },
        get cursorId() { return cursorId; },
        getBlock(id) { return blocks.find((block) => block.id === id); },
        getNextBlock(block) { return blocks[blocks.indexOf(block) + 1]; },
        getPrevBlock(block) { return blocks[blocks.indexOf(block) - 1]; },
        removeBlocks(removed) {
            const removedIds = new Set(removed.map((block) => block.id));
            blocks = blocks.filter((block) => !removedIds.has(block.id));
        },
        setTextCursorPosition(block) {
            assert.ok(blocks.includes(block), 'cursor target must still exist');
            cursorId = block.id;
        },
    };
}

test('block deletion restores the cursor outside the removed range', async () => {
    const { removeBlocksAndRestoreCursor } = await importBrowserModule('static/js/notes/editor/block-operations.js');
    const editor = createEditor(['a', 'b', 'c', 'd']);

    const removed = removeBlocksAndRestoreCursor(editor, ['b', 'c']);

    assert.deepEqual(removed.map((block) => block.id), ['b', 'c']);
    assert.deepEqual(editor.document.map((block) => block.id), ['a', 'd']);
    assert.equal(editor.cursorId, 'd');
});

test('delayed cuts remove the captured blocks instead of the current selection', async () => {
    const { removeBlocksAndRestoreCursor } = await importBrowserModule('static/js/notes/editor/block-operations.js');
    const editor = createEditor(['source-1', 'source-2', 'new-paste-block']);

    removeBlocksAndRestoreCursor(editor, ['source-1', 'source-2']);

    assert.deepEqual(editor.document.map((block) => block.id), ['new-paste-block']);
    assert.equal(editor.cursorId, 'new-paste-block');
});

