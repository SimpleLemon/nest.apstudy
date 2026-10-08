/* global window, Element */
import { Hocuspocus } from '@hocuspocus/server';
import { BlockNoteEditor, blockToNode } from '@blocknote/core';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { notesEditorSchema } from '../../../static/js/notes/editor-schema.js';

/** A real wire-protocol peer for the compiled editor's public lifecycle hooks. */
export async function createNotesCollaborationFixture({ blocks, title }) {
    const editor = BlockNoteEditor.create({ schema: notesEditorSchema, _headless: true });
    const nodes = blocks.map((block) => blockToNode(block, editor.pmSchema, notesEditorSchema.styleSchema));
    const root = editor.pmSchema.nodeFromJSON(editor.pmSchema.node('doc', null,
        editor.pmSchema.node('blockGroup', null, nodes)).toJSON());
    const initial = prosemirrorJSONToYDoc(editor.pmSchema, root.toJSON(), 'document-store');
    initial.getText('title').insert(0, title);
    initial.getMap('nest:meta').set('documentGeneration', 'initial');
    let stored = Y.encodeStateAsUpdate(initial);
    initial.destroy();
    const server = new Hocuspocus({
        address: '127.0.0.1', port: 0, quiet: true, stopOnSignals: false,
        debounce: 0, maxDebounce: 0,
        async onAuthenticate() { return { userId: 'fixture-user' }; },
        async onLoadDocument({ document }) { Y.applyUpdate(document, stored); },
        async onStoreDocument({ document }) { stored = Y.encodeStateAsUpdate(document); },
    });
    await server.listen();
    return {
        url: `ws://127.0.0.1:${server.address.port}`,
        connections: () => server.getConnectionsCount(),
        broadcast(event) { for (const document of server.documents.values()) document.broadcastStateless(JSON.stringify(event)); },
        dispose: () => server.destroy(),
    };
}

/** Observe DOM subscriptions without exposing private editor closures. */
export function installNotesLifecycleObservation() {
    window.notesLifecycle = null;
    window.APStudyPageLifecycle = { register(handlers) { window.notesLifecycle = handlers; } };
    const subscriptions = new Map();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    function tracked(target, type) {
        return (target instanceof Element && target.id === 'note-title-input' && type === 'input')
            || (target === window && ['resize', 'scroll', 'beforeunload', 'online', 'offline'].includes(type));
    }
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (tracked(this, type) && !options?.signal?.aborted) {
            let listeners = subscriptions.get(this);
            if (!listeners) subscriptions.set(this, listeners = new Map());
            let active = listeners.get(type);
            if (!active) listeners.set(type, active = new Set());
            active.add(listener);
            if (options?.signal) add.call(options.signal, 'abort', () => active.delete(listener), { once: true });
        }
        return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        subscriptions.get(this)?.get(type)?.delete(listener);
        return remove.call(this, type, listener, options);
    };
    window.notesSubscriptions = () => Object.fromEntries(
        [...subscriptions.entries()].flatMap(([target, types]) => [...types.entries()]
            .map(([type, listeners]) => [`${target === window ? 'window' : target.id}:${type}`, listeners.size])),
    );
}
