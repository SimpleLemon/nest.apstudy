import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { BlockNoteEditor, blockToNode } from '@blocknote/core';
import { notesEditorSchema } from '../static/js/notes/editor-schema.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw || '{}');
if (!Array.isArray(payload.blocks)) throw new Error('blocks must be an array');

const editor = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
const nodes = payload.blocks.map((block) => blockToNode(block, editor.pmSchema, notesEditorSchema.styleSchema));
// Normalize mark order using the schema, as the browser's document parser
// does; BlockNote's link converter can append a lower-rank link mark last.
const root = editor.pmSchema.nodeFromJSON(
    editor.pmSchema.node('doc', null, editor.pmSchema.node('blockGroup', null, nodes)).toJSON(),
);
root.check();
const ydoc = prosemirrorJSONToYDoc(editor.pmSchema, root.toJSON(), 'document-store');
ydoc.getText('title').insert(0, String(payload.title || ''));
const settings = ydoc.getMap('note-settings');
Object.entries(payload.page_setup || {}).forEach(([key, value]) => settings.set(key, value));
ydoc.getMap('nest:meta').set('schemaVersion', 1);
if (payload.document_generation) ydoc.getMap('nest:meta').set('documentGeneration', payload.document_generation);

const roundTrip = yDocToProsemirrorJSON(ydoc, 'document-store');
const roundTripNode = editor.pmSchema.nodeFromJSON(roundTrip);
roundTripNode.check();
if (!root.eq(roundTripNode)) {
    throw new Error('BlockNote JSON did not survive the Yjs round trip');
}

process.stdout.write(JSON.stringify({
    ydoc_base64: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
    state_vector_base64: Buffer.from(Y.encodeStateVector(ydoc)).toString('base64'),
    block_count: payload.blocks.length,
    schema_version: 1,
}));

ydoc.destroy();
