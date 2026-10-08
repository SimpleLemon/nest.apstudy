import * as Y from 'yjs';

/** Bound the complete accepted document, including updates awaiting application. */
export function createDocumentAdmission({ maxDocumentBytes }) {
    const candidates = new WeakMap();
    function candidateFor(document) {
        let candidate = candidates.get(document);
        if (!candidate) {
            candidate = new Y.Doc({ gc: document.gc });
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
            document.on('update', (update) => Y.applyUpdate(candidate, update));
            document.on('destroy', () => candidate.destroy());
            candidates.set(document, candidate);
        }
        return candidate;
    }
    function accept(document, update) {
        const accepted = candidateFor(document);
        const candidate = new Y.Doc({ gc: document.gc });
        try {
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(accepted));
            Y.applyUpdate(candidate, update);
            if ((candidate.getMap('nest:meta').get('documentGeneration') || 'initial')
                !== (accepted.getMap('nest:meta').get('documentGeneration') || 'initial')) {
                const error = new Error('Collaboration document generation cannot be edited.');
                error.code = 4409;
                error.reason = 'collaboration_document_generation_changed';
                throw error;
            }
            if (Y.encodeStateAsUpdate(candidate).byteLength > maxDocumentBytes) {
                const error = new Error('Collaboration document exceeds size limit.');
                error.code = 4409;
                error.reason = 'collaboration_document_too_large';
                throw error;
            }
            // Reserve synchronously: Hocuspocus applies the frame after this
            // hook's promise resolves, so another frame can be checked first.
            Y.applyUpdate(accepted, update);
        } finally { candidate.destroy(); }
    }
    return { accept };
}
