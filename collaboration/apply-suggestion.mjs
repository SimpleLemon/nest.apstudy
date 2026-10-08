import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { BlockNoteEditor } from '@blocknote/core';
import { notesEditorSchema } from '../static/js/notes/editor-schema.js';
import { projectDocument } from './document-projection.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw || '{}');
const current = new Y.Doc();
Y.applyUpdate(current, Buffer.from(payload.ydoc_base64 || '', 'base64'));
const currentVector = Buffer.from(Y.encodeStateVector(current));
const expectedVector = Buffer.from(payload.base_state_vector || '', 'base64');
if (!expectedVector.length || !currentVector.equals(expectedVector)) throw new Error('suggestion_conflicted');

const operations = Array.isArray(payload.operations) ? payload.operations : [];
const operation = operations[operations.length - 1] || {};
let result = current;
let contentJson = null;
let title = current.getText('title').toString();
const pageSetup = Object.fromEntries(current.getMap('note-settings').entries());

if (payload.target_kind === 'body' && operation.type === 'replace_document') {
    const editor = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
    // State vectors count inserted structs, so a delete-only update can leave
    // the vector unchanged. Compare the captured document too before replacing
    // its body, otherwise accepting a proposal can resurrect deleted text.
    if (!operation.before) throw new Error('suggestion_conflicted');
    const before = editor.pmSchema.nodeFromJSON(operation.before);
    const live = editor.pmSchema.nodeFromJSON(yDocToProsemirrorJSON(current, 'document-store'));
    if (!before.eq(live)) throw new Error('suggestion_conflicted');
    const node = editor.pmSchema.nodeFromJSON(operation.after);
    node.check();
    result = prosemirrorJSONToYDoc(editor.pmSchema, node.toJSON(), 'document-store');
    result.getText('title').insert(0, title);
    Object.entries(pageSetup).forEach(([key, value]) => result.getMap('note-settings').set(key, value));
    result.getMap('nest:meta').set('schemaVersion', 1);
    contentJson = projectDocument(result).content;
} else if (payload.target_kind === 'title' && operation.type === 'replace_title') {
    if (Object.hasOwn(operation, 'before') && String(operation.before) !== title) {
        throw new Error('suggestion_conflicted');
    }
    const yTitle = current.getText('title');
    yTitle.delete(0, yTitle.length);
    title = String(operation.after || 'Untitled');
    yTitle.insert(0, title);
} else if (payload.target_kind === 'page_setup' && operation.type === 'patch_page_setup') {
    if (Object.hasOwn(operation, 'before')
        && JSON.stringify(operation.before) !== JSON.stringify(pageSetup[String(operation.key)])) {
        throw new Error('suggestion_conflicted');
    }
    current.getMap('note-settings').set(String(operation.key), operation.after);
} else {
    throw new Error('unsupported_suggestion_operation');
}

if (payload.document_generation) result.getMap('nest:meta').set('documentGeneration', payload.document_generation);

process.stdout.write(JSON.stringify({
    ydoc_base64: Buffer.from(Y.encodeStateAsUpdate(result)).toString('base64'),
    title,
    content_json: contentJson,
    page_setup: Object.fromEntries(result.getMap('note-settings').entries()),
}));

if (result !== current) result.destroy();
current.destroy();
