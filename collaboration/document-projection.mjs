import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { BlockNoteEditor, nodeToBlock } from '@blocknote/core';
import { notesEditorSchema } from '../static/js/notes/editor-schema.js';

let editor;

/** Use the same schema and block conversion as the browser, without a DOM. */
export function projectDocument(document) {
    editor ||= BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
    const body = document.getXmlFragment('document-store');
    const blocks = [];
    if (body.length) {
        const root = editor.pmSchema.nodeFromJSON(yDocToProsemirrorJSON(document, 'document-store'));
        // nodeFromJSON alone accepts structurally invalid nodes. Never replace
        // a durable projection with a silently repaired or partial document.
        root.check();
        root.firstChild.forEach((node) => blocks.push(nodeToBlock(
            node, notesEditorSchema.blockSchema, notesEditorSchema.inlineContentSchema,
            notesEditorSchema.styleSchema,
        )));
    }
    return {
        title: document.getText('title').toString(),
        content: JSON.stringify(blocks),
        page_setup_json: JSON.stringify(Object.fromEntries(document.getMap('note-settings').entries())),
    };
}

/** Freeze all projections and durable bytes at the same accepted revision. */
export async function createDocumentSnapshot(document, { maxDocumentBytes, project = projectDocument } = {}) {
    // Capture before any asynchronous work so later accepted edits cannot leak
    // into projections for an older Yjs update.
    const update = Y.encodeStateAsUpdate(document);
    if (maxDocumentBytes !== undefined && update.byteLength > maxDocumentBytes) {
        throw new Error(`Collaboration document ${document.name || ''} exceeds size limit.`);
    }
    const snapshot = new Y.Doc();
    try {
        Y.applyUpdate(snapshot, update);
        const projection = await project(snapshot);
        if (typeof projection?.title !== 'string' || typeof projection?.content !== 'string'
            || typeof projection?.page_setup_json !== 'string') {
            throw new Error('Collaboration document projection is incomplete.');
        }
        return {
            ydoc_base64: Buffer.from(update).toString('base64'),
            schema_version: 1,
            state_vector_base64: Buffer.from(Y.encodeStateVector(snapshot)).toString('base64'),
            snapshot_base64: Buffer.from(Y.encodeSnapshot(Y.snapshot(snapshot))).toString('base64'),
            document_generation: String(snapshot.getMap('nest:meta').get('documentGeneration') || 'initial'),
            ...projection,
        };
    } finally {
        snapshot.destroy();
    }
}
