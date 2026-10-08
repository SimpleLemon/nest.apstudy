import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { BlockNoteEditor, blockToNode } from '@blocknote/core';
import { notesEditorSchema } from '../../static/js/notes/editor-schema.js';
import { createDocumentSnapshot, projectDocument } from '../../collaboration/document-projection.mjs';
import { createDocumentAdmission } from '../../collaboration/document-admission.mjs';
import { createDocumentPersistence } from '../../collaboration/document-persistence.mjs';

const editor = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
export function documentWithBlocks(blocks) {
    const nodes = blocks.map((block) => blockToNode(block, editor.pmSchema, notesEditorSchema.styleSchema));
    const root = editor.pmSchema.node('doc', null, editor.pmSchema.node('blockGroup', null, nodes));
    return prosemirrorJSONToYDoc(editor.pmSchema, root.toJSON(), 'document-store');
}

test('production headless projection preserves nested blocks, rich styles, links and media', async () => {
    const document = documentWithBlocks([
        { id: 'heading', type: 'heading', props: { level: 2 },
            content: [{ type: 'text', text: 'Edited heading', styles: { bold: true, fontSize: '18px' } }],
            children: [{ id: 'child', type: 'paragraph', content: [{ type: 'link', href: 'https://example.com/',
                content: [{ type: 'text', text: 'A link', styles: { italic: true } }] }] }] },
        { id: 'image', type: 'image', props: { url: '/api/notes/media/media-1', caption: 'New caption', name: 'Image' } },
        { id: 'callout', type: 'callout', props: { tone: 'warning', icon: 'lightbulb' }, content: 'Callout body' },
    ]);
    document.getText('title').insert(0, 'Current title');
    document.getMap('note-settings').set('orientation', 'landscape');
    document.getMap('nest:meta').set('documentGeneration', 'generation-1');
    try {
        const payload = await createDocumentSnapshot(document);
        const blocks = JSON.parse(payload.content);
        assert.equal(payload.title, 'Current title');
        assert.equal(payload.document_generation, 'generation-1');
        assert.deepEqual(JSON.parse(payload.page_setup_json), { orientation: 'landscape' });
        assert.equal(blocks[0].props.level, 2);
        assert.deepEqual(blocks[0].content[0].styles, { bold: true, fontSize: '18px' });
        assert.equal(blocks[0].children[0].content[0].href, 'https://example.com/');
        assert.equal(blocks[1].props.url, '/api/notes/media/media-1');
        assert.equal(blocks[2].props.tone, 'warning');
        const restored = new Y.Doc();
        Y.applyUpdate(restored, Buffer.from(payload.ydoc_base64, 'base64'));
        assert.deepEqual(projectDocument(restored), { title: payload.title, content: payload.content, page_setup_json: payload.page_setup_json });
        assert.equal(Y.snapshotContainsUpdate(Y.decodeSnapshot(Buffer.from(payload.snapshot_base64, 'base64')), Y.encodeStateAsUpdate(restored)), true);
        restored.destroy();
    } finally { document.destroy(); }
});

test('snapshot projections cannot include edits accepted during an asynchronous conversion', async () => {
    const document = documentWithBlocks([{ id: 'paragraph', type: 'paragraph', content: 'Saved content' }]);
    document.getText('title').insert(0, 'Before');
    let resume;
    const frozen = createDocumentSnapshot(document, { project: async (snapshot) => {
        await new Promise((resolve) => { resume = resolve; });
        return projectDocument(snapshot);
    } });
    document.getText('title').insert(0, 'After ');
    document.getMap('note-settings').set('orientation', 'landscape');
    resume();
    const payload = await frozen;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(payload.ydoc_base64, 'base64'));
    assert.equal(payload.title, 'Before');
    assert.equal(restored.getText('title').toString(), payload.title);
    assert.deepEqual(JSON.parse(payload.page_setup_json), {});
    document.destroy();
    restored.destroy();
});

test('failed structural serialization retains the dirty document and retries without durable acknowledgment', async () => {
    const document = new Y.Doc();
    document.name = 'notes:invalid';
    document.getXmlFragment('document-store').insert(0, [new Y.XmlElement('unknownBlock')]);
    let puts = 0;
    const persistence = createDocumentPersistence({ noteIdFor: () => 'invalid', store: async (_note, doc) => {
        await createDocumentSnapshot(doc);
        puts += 1;
        return { durable_revision: puts };
    } });
    persistence.changed(document);
    await persistence.save(document);
    assert.equal(puts, 0);
    let unloaded = false;
    const unloading = persistence.beforeUnload(document).then(() => { unloaded = true; });
    await assert.rejects(persistence.flush(document), /Unknown node type/);
    assert.equal(unloaded, false);
    document.getXmlFragment('document-store').delete(0, 1);
    persistence.changed(document);
    await persistence.retry(document);
    await unloading;
    assert.equal(puts, 1);
    document.destroy();
});

test('aggregate admission reserves concurrent small updates before Hocuspocus applies them', () => {
    const document = new Y.Doc();
    const clientA = new Y.Doc();
    const clientB = new Y.Doc();
    clientA.getText('title').insert(0, 'a'.repeat(80));
    clientB.getText('title').insert(0, 'b'.repeat(80));
    const a = Y.encodeStateAsUpdate(clientA);
    const b = Y.encodeStateAsUpdate(clientB);
    const admission = createDocumentAdmission({ maxDocumentBytes: Math.max(a.byteLength, b.byteLength) + 10 });
    admission.accept(document, a);
    assert.throws(() => admission.accept(document, b), { reason: 'collaboration_document_too_large' });
    assert.equal(document.getText('title').toString(), '');
    Y.applyUpdate(document, a);
    assert.equal(document.getText('title').toString(), 'a'.repeat(80));
    document.destroy(); clientA.destroy(); clientB.destroy();
});

test('incoming editors cannot replace the authoritative generation or poison the accepted candidate', () => {
    const document = new Y.Doc();
    document.getMap('nest:meta').set('documentGeneration', 'current-generation');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
    const before = Y.encodeStateVector(client);
    client.getMap('nest:meta').set('documentGeneration', 'forged-generation');
    const admission = createDocumentAdmission({ maxDocumentBytes: 10000 });
    assert.throws(() => admission.accept(document, Y.encodeStateAsUpdate(client, before)),
        { reason: 'collaboration_document_generation_changed' });
    assert.equal(document.getMap('nest:meta').get('documentGeneration'), 'current-generation');
    const legitimate = new Y.Doc();
    Y.applyUpdate(legitimate, Y.encodeStateAsUpdate(document));
    legitimate.getText('title').insert(0, 'Still persistable');
    admission.accept(document, Y.encodeStateAsUpdate(legitimate));
    Y.applyUpdate(document, Y.encodeStateAsUpdate(legitimate));
    assert.equal(document.getText('title').toString(), 'Still persistable');
    document.destroy(); client.destroy(); legitimate.destroy();
});

function runCli(script, payload) {
    const result = spawnSync(process.execPath, [`collaboration/${script}.mjs`], {
        input: JSON.stringify(payload), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('actual converter and suggestion CLI preserve rich content and stamp replacement generations without a DOM', () => {
    const blocks = [
        { id: 'heading', type: 'heading', props: { level: 3 }, content: 'Heading', children: [
            { id: 'link', type: 'paragraph', content: [{ type: 'link', href: 'https://example.com/',
                content: [{ type: 'text', text: 'Styled link', styles: { italic: true } }] }] },
        ] },
        { id: 'image', type: 'image', props: { url: '/api/notes/media/image-1', caption: 'Image caption' } },
        { id: 'callout', type: 'callout', props: { tone: 'warning' }, content: 'Warning' },
    ];
    const converted = runCli('convert-note', { blocks, title: 'Migrated title', page_setup: { orientation: 'landscape' } });
    const document = new Y.Doc();
    Y.applyUpdate(document, Buffer.from(converted.ydoc_base64, 'base64'));
    const projection = projectDocument(document);
    const projected = JSON.parse(projection.content);
    assert.equal(projected[0].children[0].content[0].content[0].styles.italic, true);
    assert.equal(projected[1].props.url, '/api/notes/media/image-1');
    assert.equal(projected[2].props.tone, 'warning');
    assert.deepEqual(JSON.parse(projection.page_setup_json), { orientation: 'landscape' });
    const stamped = runCli('replace-generation', { ...converted, document_generation: 'restored-generation' });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(stamped.ydoc_base64, 'base64'));
    assert.equal(restored.getMap('nest:meta').get('documentGeneration'), 'restored-generation');
    const suggested = runCli('apply-suggestion', { ...stamped,
        base_state_vector: Buffer.from(Y.encodeStateVector(restored)).toString('base64'),
        target_kind: 'title', operations: [{ type: 'replace_title', after: 'Suggested title' }],
        document_generation: 'suggestion-generation' });
    const accepted = new Y.Doc();
    Y.applyUpdate(accepted, Buffer.from(suggested.ydoc_base64, 'base64'));
    assert.equal(accepted.getText('title').toString(), 'Suggested title');
    assert.equal(accepted.getMap('nest:meta').get('documentGeneration'), 'suggestion-generation');
    assert.equal(projectDocument(accepted).content, projection.content);
    document.destroy(); restored.destroy(); accepted.destroy();
});
