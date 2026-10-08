import * as Y from 'yjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw || '{}');
if (typeof payload.document_generation !== 'string' || !payload.document_generation) {
    throw new Error('document_generation is required');
}
const document = new Y.Doc();
try {
    Y.applyUpdate(document, Buffer.from(payload.ydoc_base64 || '', 'base64'));
    document.getMap('nest:meta').set('documentGeneration', payload.document_generation);
    process.stdout.write(JSON.stringify({
        ...payload, ydoc_base64: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
    }));
} finally { document.destroy(); }
