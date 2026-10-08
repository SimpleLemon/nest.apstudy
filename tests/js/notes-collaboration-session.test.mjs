import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as Y from 'yjs';
import { createCollaborationSession } from '../../static/js/notes/editor/collaboration/collaboration-session.js';
import { bindCollaborativeTitle } from '../../static/js/notes/editor/collaboration/collaborative-title.js';
import { FakeElement } from './helpers/notes-runtime.mjs';

function setup(requestToken, overrides = {}) {
    const document = new Y.Doc();
    const tokens = [];
    const accessChanges = [];
    const statuses = [];
    const timers = new Map();
    let timerId = 0;
    let provider;
    const session = createCollaborationSession({
        noteId: 'note', document, access: { role: 'editor', can_edit: true, can_view: true },
        draftStore: { read: async () => [], write: async () => {}, remove: async () => {} },
        draftMemory: new Map(),
        requestToken: requestToken || (async () => {
            const next = tokens.shift();
            if (next instanceof Error) throw next;
            return next;
        }),
        userFromToken: (payload, access) => ({ id: payload.user?.id || 'user', role: access.role }),
        onStatus: (status) => statuses.push(status),
        onAccessChange: (access, state) => accessChanges.push({ ...state, access }),
        schedule: (callback) => { timers.set(++timerId, callback); return timerId; },
        cancel: (id) => timers.delete(id),
        createProvider: (configuration) => {
            const handlers = new Map();
            provider = {
                configuration, connectCount: 0, disconnectCount: 0, hasUnsyncedChanges: false,
                awareness: { state: null, setLocalState(value) { this.state = value; }, on() {}, off() {} },
                connect() { this.connectCount++; }, disconnect() { this.disconnectCount++; }, destroy() {},
                on(event, handler) { handlers.set(event, handler); }, off(event) { handlers.delete(event); },
                emit(event, value) { handlers.get(event)?.(value); },
            };
            return provider;
        },
        ...overrides,
    });
    function tokenFor(role = 'editor', token = 'fresh') {
        return { token, document_generation: 'initial', awareness_allowed: true, user: { id: 'user' }, access: { role, can_view: true, can_edit: role === 'editor', can_review: role !== 'viewer' } };
    }
    async function admit(role = 'editor', token = 'fresh') {
        tokens.push(tokenFor(role, token));
        return provider.configuration.token();
    }
    return { document, provider, session, statuses, accessChanges, timers, tokens, tokenFor, admit };
}

test('every reconnect requests a fresh ticket and editing waits for authentication and sync', async () => {
    const h = setup();
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    assert.equal(h.provider.configuration.broadcast, false, 'all disclosure must cross the sidecar ACL boundary');
    assert.equal(await h.admit('editor', 'first'), 'first');
    h.provider.configuration.onStatus({ status: 'connected' });
    assert.equal(h.statuses.includes('saved'), false);
    h.provider.configuration.onAuthenticated();
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.accessChanges.at(-1).readOnly, false);
    assert.equal(h.statuses.at(-1), 'saved');
    h.document.getMap('body').set('pending', 'Retained');
    h.provider.configuration.onStatus({ status: 'disconnected' });
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    await assert.rejects(h.admit('viewer', 'second'), /fresh document/);
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.session.ready, false, 'a dirty Y.Doc must not sync under viewer credentials');
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    assert.equal(h.document.getMap('body').get('pending'), 'Retained');
    h.session.destroy();
});

test('missing current generation fails closed before any draft replay or sync', async () => {
    const h = setup();
    const credentials = h.tokenFor();
    delete credentials.document_generation;
    h.tokens.push(credentials);
    await assert.rejects(h.provider.configuration.token(), /generation is unavailable/);
    assert.equal(h.session.ready, false);
    assert.equal(h.timers.size, 1);
    h.session.destroy();
});

test('token HTTP failures retain status, response and decoding cause without admitting editing', async (t) => {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    for (const [status, body, expectedMessage] of [
        [200, '<!doctype html>Login', 'Invalid collaboration token response.'],
        [403, '{broken', 'Unable to connect to note collaboration.'],
        [403, '{"error":"Note access was revoked."}', 'Note access was revoked.'],
    ]) {
        const h = setup(undefined, { requestToken: undefined });
        const response = new Response(body, { status });
        globalThis.fetch = async (url, options) => {
            assert.equal(url, '/api/notes/note/collaboration-token');
            assert.equal(options.method, 'POST');
            return response;
        };
        try {
            await assert.rejects(h.provider.configuration.token(), error => {
                assert.equal(error.message, expectedMessage);
                assert.equal(error.status, status);
                assert.equal(error.response, response);
                assert.equal(error.cause instanceof SyntaxError, !body.startsWith('{"error"'));
                return true;
            });
            assert.equal(h.session.ready, false);
            assert.equal(h.accessChanges.at(-1).readOnly, true);
            assert.equal(h.timers.size, 1);
        } finally { h.session.destroy(); }
    }
});

test('generation replacement rejects credentials before sync and asks the shell for a fresh document', async () => {
    let replacements = 0;
    const h = setup(undefined, { initialGeneration: 'first', onDocumentChange: () => { replacements++; } });
    h.tokens.push({ ...h.tokenFor(), document_generation: 'restored' });
    await assert.rejects(h.provider.configuration.token(), /fresh document/);
    assert.equal(replacements, 1);
    assert.equal(h.session.ready, false);
    assert.equal(h.provider.disconnectCount, 1);
    h.session.destroy();
});

test('BFCache pauses and resumes the same document, with editing gated on a fresh admission', async () => {
    const h = setup();
    await h.admit();
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    h.document.getText('title').insert(0, 'Kept while cached');
    h.session.pause();
    assert.equal(h.session.ready, false);
    assert.equal(h.provider.awareness.state, null);
    h.session.resume();
    assert.equal(h.session.document, h.document);
    assert.equal(h.session.ready, false);
    await h.admit();
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.session.ready, true);
    assert.equal(h.document.getText('title').toString(), 'Kept while cached');
    h.session.destroy();
});

test('denied admission pauses editing, schedules a recoverable retry, and keeps pending Yjs state', async () => {
    const h = setup();
    h.document.getMap('body').set('pending', 'Never discard on outage');
    h.tokens.push(new Error('permissions unavailable'));
    await assert.rejects(h.provider.configuration.token(), /permissions unavailable/);
    assert.equal(h.statuses.at(-1), 'offline-readonly');
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0]();
    assert.equal(h.provider.connectCount, 2);
    assert.equal(await h.admit(), 'fresh');
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.accessChanges.at(-1).readOnly, false);
    assert.equal(h.document.getMap('body').get('pending'), 'Never discard on outage');
    h.session.destroy();
});

test('awareness is withheld while unverified and refreshed after admitted roles change', async () => {
    const h = setup();
    assert.equal(h.provider.awareness.state, null);
    await h.admit('reviewer');
    assert.equal(h.provider.awareness.state, null);
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.provider.awareness.state.user.role, 'reviewer');
    assert.equal(h.provider.awareness.state.user.mode, 'suggesting');
    h.provider.configuration.onAuthenticationFailed();
    assert.equal(h.provider.awareness.state, null);
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    h.session.destroy();
});

test('disposal rejects late credentials without restoring editing or scheduling recovery', async () => {
    let respond;
    const h = setup(() => new Promise((resolve) => { respond = resolve; }));
    const pending = h.provider.configuration.token();
    const accessCount = h.accessChanges.length;
    h.session.destroy();
    respond(h.tokenFor());
    await assert.rejects(pending, /superseded/);
    assert.equal(h.accessChanges.length, accessCount);
    assert.equal(h.timers.size, 0);
});

test('superseded credentials cannot pause a newer authenticated admission', async () => {
    const responses = [];
    const h = setup(() => new Promise((resolve) => responses.push(resolve)));
    const stale = h.provider.configuration.token();
    const current = h.provider.configuration.token();
    responses[1](h.tokenFor('editor', 'current'));
    assert.equal(await current, 'current');
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.session.ready, false);
    h.provider.configuration.onAuthenticated();
    assert.equal(h.session.ready, true, 'authentication after sync opens the same permission gate');
    assert.equal(h.provider.awareness.state.user.role, 'editor');
    responses[0](h.tokenFor('viewer', 'old'));
    await assert.rejects(stale, /superseded/);
    assert.equal(h.session.ready, true);
    assert.equal(h.session.access.role, 'editor');
    assert.equal(h.timers.size, 0);
    h.session.destroy();
});

test('late authentication and sync callbacks cannot open a disconnected admission', async () => {
    const h = setup();
    await h.admit();
    h.provider.configuration.onStatus({ status: 'disconnected' });
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(h.session.ready, false);
    assert.equal(h.accessChanges.at(-1).readOnly, true);
    h.session.destroy();
});

test('collaborative title initializes only when ready and editable and keeps unsaved title across reconnect', async () => {
    const h = setup();
    const title = new FakeElement();
    title.value = 'Original';
    let canEdit = false;
    const cleanup = bindCollaborativeTitle({ session: h.session, fallbackTitle: 'Original', titleInput: title, getCanEdit: () => canEdit });
    const text = h.document.getText('title');
    assert.equal(text.toString(), '');
    await h.admit();
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    canEdit = true;
    h.provider.emit('synced', { state: true });
    assert.equal(text.toString(), 'Original');
    title.value = 'Pending title';
    title.dispatch('input');
    h.provider.configuration.onStatus({ status: 'disconnected' });
    canEdit = false;
    assert.equal(text.toString(), 'Pending title');
    title.value = 'Blocked local input';
    title.dispatch('input');
    assert.equal(text.toString(), 'Pending title');
    cleanup();
    h.session.destroy();
});

test('title input requires admission even with stale external edit permission and preserves a deleted title', async () => {
    const h = setup();
    const title = new FakeElement();
    title.value = 'Loaded title';
    const cleanup = bindCollaborativeTitle({ session: h.session, fallbackTitle: 'Loaded title', titleInput: title, getCanEdit: () => true });
    const text = h.document.getText('title');
    title.value = 'Unauthenticated draft';
    title.dispatch('input');
    assert.equal(text.toString(), '');
    await h.admit();
    h.provider.configuration.onSynced({ state: true });
    h.provider.configuration.onAuthenticated();
    assert.equal(text.toString(), 'Loaded title', 'access subscription handles authentication arriving after sync');
    title.value = '';
    title.dispatch('input');
    h.provider.configuration.onStatus({ status: 'disconnected' });
    title.value = 'Blocked during reconnect';
    title.dispatch('input');
    assert.equal(text.toString(), '');
    await h.admit();
    h.provider.configuration.onAuthenticated();
    h.provider.configuration.onSynced({ state: true });
    assert.equal(text.toString(), '', 'reconnect never replaces a deliberately deleted title with its loaded fallback');
    assert.equal(title.value, '');
    cleanup();
    h.session.destroy();
});

test('actual readonly setter enforces current role on BlockNote, title and toolbar throughout recovery', () => {
    const source = readFileSync(new URL('../../static/js/notes/editor.js', import.meta.url), 'utf8');
    const start = source.indexOf('function setEditorReadOnlyMode(');
    const end = source.indexOf('function initializeEditorRuntimes', start);
    const titleInput = new FakeElement();
    const writingToolbar = new FakeElement();
    const editorInstance = { isEditable: true };
    const noteContext = { access: { can_edit: true } };
    const document = { body: { dataset: {} } };
    const context = vm.createContext({ titleInput, writingToolbar, editorInstance, noteContext, document,
        closeToolbarMenus() {}, closePageSetupPopover() {}, updateToolbarState() {}, toolbarDom: { bindWritingToolbar() {} } });
    vm.runInContext(`let canEdit = true; ${source.slice(start, end)}`, context);
    const setReadonly = (value) => { context.requestedReadOnly = value; vm.runInContext('setEditorReadOnlyMode(requestedReadOnly)', context); };
    setReadonly(true);
    assert.equal(editorInstance.isEditable, false);
    assert.equal(titleInput.readOnly, true);
    assert.equal(writingToolbar.hidden, true);
    noteContext.access = { can_edit: false, role: 'viewer' };
    setReadonly(false);
    assert.equal(editorInstance.isEditable, false);
    assert.equal(document.body.dataset.noteReadOnly, 'true');
    noteContext.access = { can_edit: true, role: 'editor' };
    setReadonly(false);
    assert.equal(editorInstance.isEditable, true);
    assert.equal(titleInput.readOnly, false);
    assert.equal(writingToolbar.hidden, false);
    assert.equal(document.body.dataset.noteReadOnly, 'false');
});
