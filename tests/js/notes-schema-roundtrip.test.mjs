import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockNoteEditor, blockToNode, nodeToBlock } from '@blocknote/core';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { notesEditorSchema } from '../../static/js/notes/editor-schema.js';
import { projectDocument } from '../../collaboration/document-projection.mjs';

// Exercise the installed BlockNote implementation, including its actual
// ProseMirror node attributes. A propSchema-only test misses dropped props.
const editor = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
const textProps = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

function roundtrip(block) {
    // JSON reconstruction also normalizes mark ordering in BlockNote 0.28's
    // styled links, matching the document serialized for collaboration.
    const node = editor.pmSchema.nodeFromJSON(
        blockToNode(block, editor.pmSchema, notesEditorSchema.styleSchema).toJSON(),
    );
    node.check();
    return nodeToBlock(node, notesEditorSchema.blockSchema,
        notesEditorSchema.inlineContentSchema, notesEditorSchema.styleSchema);
}

function richNestedBlocks() {
    return [{
        id: 'collapsed-heading', type: 'heading',
        props: { ...textProps, textColor: 'blue', textAlignment: 'center', level: 2, indentLevel: 4, isCollapsed: true },
        content: [
            { type: 'text', text: 'A heading ', styles: { bold: true, fontSize: '18px' } },
            { type: 'link', href: 'https://example.com/notes', content: [
                { type: 'text', text: 'with a link', styles: { italic: true } },
            ] },
        ],
        children: [{
            id: 'indented-child', type: 'paragraph',
            props: { ...textProps, backgroundColor: 'yellow', textAlignment: 'right', indentLevel: 3 },
            content: [{ type: 'text', text: 'Indented child', styles: { underline: true } }],
            children: [{
                id: 'expanded-grandchild', type: 'heading',
                props: { ...textProps, level: 3, indentLevel: 1, isCollapsed: false },
                content: [{ type: 'text', text: 'Expanded grandchild', styles: {} }],
                children: [],
            }],
        }],
    }];
}

test('real heading and paragraph nodes retain each indentation and collapse value', () => {
    for (const indentLevel of [0, 1, 2, 3, 4]) {
        for (const level of [1, 2, 3]) {
            for (const isCollapsed of [false, true]) {
                const heading = roundtrip({
                    id: 'heading', type: 'heading',
                    props: { level, indentLevel, isCollapsed }, content: 'Heading',
                });
                assert.equal(heading.props.level, level);
                assert.equal(heading.props.indentLevel, indentLevel);
                assert.equal(heading.props.isCollapsed, isCollapsed);
            }
        }
        const paragraph = roundtrip({ id: 'paragraph', type: 'paragraph', props: { indentLevel }, content: 'Text' });
        assert.equal(paragraph.props.indentLevel, indentLevel);
    }
});

test('real block/node roundtrip preserves rich text, nesting and existing block properties', () => {
    const blocks = richNestedBlocks();
    assert.deepEqual(blocks.map(roundtrip), blocks);
});

test('legacy blocks without the added properties receive the same document defaults', () => {
    const heading = roundtrip({ id: 'legacy-heading', type: 'heading', props: { level: 2 }, content: 'Heading' });
    const paragraph = roundtrip({ id: 'legacy-paragraph', type: 'paragraph', content: 'Paragraph' });
    assert.deepEqual(heading.props, { ...textProps, level: 2, indentLevel: 0, isCollapsed: false });
    assert.deepEqual(paragraph.props, { ...textProps, indentLevel: 0 });
});

test('binary Yjs replication and production projection retain rich nested indentation and collapse state', () => {
    const blocks = richNestedBlocks();
    const nodes = blocks.map((block) => blockToNode(block, editor.pmSchema, notesEditorSchema.styleSchema));
    const root = editor.pmSchema.nodeFromJSON(
        editor.pmSchema.node('doc', null, editor.pmSchema.node('blockGroup', null, nodes)).toJSON(),
    );
    root.check();
    const source = prosemirrorJSONToYDoc(editor.pmSchema, root.toJSON(), 'document-store');
    const restored = new Y.Doc();
    try {
        source.getText('title').insert(0, 'Nested notes');
        source.getMap('note-settings').set('orientation', 'landscape');
        Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
        const projection = projectDocument(restored);
        assert.deepEqual(JSON.parse(projection.content), blocks);
        assert.equal(projection.title, 'Nested notes');
        assert.deepEqual(JSON.parse(projection.page_setup_json), { orientation: 'landscape' });
    } finally {
        source.destroy();
        restored.destroy();
    }
});
