import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { createToolbarDom } from '../../static/js/notes/editor/toolbar-dom.js';
import { bindImageRuntime, uploadInlineImage } from '../../static/js/notes/editor/image-runtime.js';
import { resolveCommentAnchor } from '../../static/js/notes/editor/review/comments.js';
import { registerHooks } from 'node:module';

// Core browser .js modules sit beneath the repository's CommonJS package scope.
// Load their actual ESM definitions without editing source or publishing helpers.
const coreUrl = new URL('../../static/js/core/', import.meta.url).href;
const moduleHook = registerHooks({ load(url, context, nextLoad) {
    return nextLoad(url, url.startsWith(coreUrl) ? { ...context, format: 'module' } : context);
} });
const { bindReviewPanel } = await import('../../static/js/notes/editor/review/review-panel.js');
moduleHook.deregister();
import { FakeElement, settle } from './helpers/notes-runtime.mjs';

let httpFactory;

function environment(t) {
    const cleanups = [];
    const previous = new Map();
    const set = (key, value) => { previous.set(key, globalThis[key]); globalThis[key] = value; };
    const window = new EventTarget();
    window.location = { origin: 'https://nest.example', href: 'https://nest.example/notes' };
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    window.cancelAnimationFrame = () => {};
    const document = new FakeElement();
    set('window', window);
    set('document', document);
    set('requestAnimationFrame', () => 1);
    set('cancelAnimationFrame', () => {});
    t.after(() => { for (const cleanup of cleanups) cleanup(); for (const [key, value] of previous) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
    return { window, document, set, onCleanup: cleanup => cleanups.push(cleanup) };
}

function toolbarFixture(t) {
    const env = environment(t);
    const toolbar = new FakeElement();
    toolbar.contains = () => true;
    toolbar.getAttribute = key => toolbar.attributes.get(key);
    const menu = new FakeElement();
    toolbar.selectors.set('[data-toolbar-menu]', [menu]);
    const buttons = [];
    const button = data => {
        const node = new FakeElement(data);
        node.selectors.set('closest:button[data-editor-action]', [node]);
        buttons.push(node);
        return node;
    };
    toolbar.selectors.set('button[data-editor-action]', buttons);
    let blocks = [{ id: 'one', type: 'heading', props: { level: 2 } }, { id: 'two', type: 'paragraph' }];
    let editable = true;
    let history = false;
    let indent = false;
    let zoom = 0;
    let alignment = 'center';
    const calls = [];
    const actions = Object.fromEntries(['toggleBasicStyle', 'applyTextColor', 'applyHighlightColor', 'applyFontSizePreset', 'setSelectedBlockType', 'applyTextAlignment', 'runHistoryAction', 'runIndentAction', 'copySelectedBlocks', 'duplicateSelectedBlocks', 'deleteSelectedBlocks', 'moveSelectedBlocks', 'toggleHeadingCollapse'].map(name => [name, (...args) => calls.push([name, ...args])]));
    const runtime = createToolbarDom({
        writingToolbar: toolbar, getCanEdit: () => editable,
        getEditor: () => ({ getActiveStyles: () => ({ bold: true, textColor: 'red', backgroundColor: 'yellow', fontSize: '18px' }) }),
        getSelectedBlocks: () => blocks, getSelectedTextAlignment: () => alignment,
        isBlockStyleSelected: (block, item) => block?.type === item.type && (!item.props || block.props.level === item.props.level),
        canRunHistoryAction: () => history, canRunIndentAction: () => indent,
        getZoomIndex: () => zoom, getZoomLevels: () => [1, 2],
        pageSetup: { setZoomIndex: value => { zoom = value; } }, actions,
    });
    runtime.bindWritingToolbar();
    const click = node => toolbar.dispatch('click', { target: node, preventDefault() {} });
    const key = event => env.document.dispatch('keydown', { preventDefault() {}, ...event });
    return { ...env, toolbar, menu, calls, runtime, button, click, key, setAlignment: value => { alignment = value; }, setEditable: value => { editable = value; }, setBlocks: value => { blocks = value; }, allowHistory: () => { history = true; }, allowIndent: () => { indent = true; } };
}

test('toolbar buttons use concrete command state and close policy across formatting, history and selection', t => {
    const h = toolbarFixture(t);
    const bold = h.button({ editorAction: 'basic-style', style: 'bold' });
    const color = h.button({ editorAction: 'text-color', color: 'red' });
    const heading = h.button({ editorAction: 'set-block', blockType: 'heading', level: '2' });
    const align = h.button({ editorAction: 'align', align: 'center' });
    const undo = h.button({ editorAction: 'undo' });
    const redo = h.button({ editorAction: 'redo' });
    const outdent = h.button({ editorAction: 'outdent' });
    const indent = h.button({ editorAction: 'indent' });
    const cut = h.button({ editorAction: 'cut-blocks' });
    const zoom = h.button({ editorAction: 'zoom-out' });
    h.runtime.updateToolbarState();
    assert.equal(bold.attributes.get('aria-pressed'), 'true');
    for (const node of [color, heading, align]) assert.equal(node.classes.has('is-active'), true);
    for (const node of [undo, redo, indent, outdent, zoom]) assert.equal(node.disabled, true);
    assert.equal(cut.disabled, false);
    h.click(undo);
    h.click(redo);
    h.click(indent);
    h.click(outdent);
    assert.deepEqual(h.calls, [], 'disabled commands do not execute');
    h.click(bold);
    assert.equal(h.menu.hidden, false);
    h.click(color);
    assert.equal(h.menu.hidden, true);
    h.click(heading);
    h.click(align);
    h.click(cut);
    h.allowHistory();
    h.allowIndent();
    h.runtime.updateToolbarState();
    assert.equal(undo.disabled, false);
    assert.equal(indent.disabled, false);
    h.click(undo);
    h.click(redo);
    h.click(indent);
    h.click(outdent);
    assert.deepEqual(h.calls, [
        ['toggleBasicStyle', 'bold'], ['applyTextColor', 'red'], ['setSelectedBlockType', 'heading', { level: 2 }],
        ['applyTextAlignment', 'center'], ['copySelectedBlocks', { cut: true }], ['runHistoryAction', 'undo'], ['runHistoryAction', 'redo'], ['runIndentAction', 'indent'], ['runIndentAction', 'outdent'],
    ]);
    h.setBlocks([]);
    h.runtime.updateToolbarState();
    assert.equal(cut.disabled, true);
    h.calls.length = 0;
    h.click(cut);
    assert.deepEqual(h.calls, []);
    h.setEditable(false);
    h.click(bold);
    h.key({ altKey: true, key: 'ArrowDown' });
    assert.deepEqual(h.calls, [], 'permission changes gate both click and shortcut execution');
});

test('toolbar copy, duplicate, delete and block movement clicks share selection state and close behavior', t => {
    const h = toolbarFixture(t);
    const pairs = [
        ['copy-blocks', ['copySelectedBlocks']], ['duplicate-blocks', ['duplicateSelectedBlocks']],
        ['delete-blocks', ['deleteSelectedBlocks']], ['move-blocks-up', ['moveSelectedBlocks', 'up']],
        ['move-blocks-down', ['moveSelectedBlocks', 'down']], ['toggle-heading-collapse', ['toggleHeadingCollapse']],
    ];
    for (const [action, call] of pairs) {
        const button = h.button({ editorAction: action });
        h.runtime.updateToolbarState();
        assert.equal(button.disabled, false);
        h.menu.hidden = false;
        h.click(button);
        assert.deepEqual(h.calls.at(-1), call);
        assert.equal(h.menu.hidden, true);
    }
    h.setBlocks([{ type: 'paragraph' }]);
    h.runtime.updateToolbarState();
    assert.equal(h.toolbar.querySelectorAll('button[data-editor-action]').at(-1).disabled, true);
    h.calls.length = 0;
    h.key({ metaKey: true, altKey: true, key: 'h' });
    assert.deepEqual(h.calls, [], 'heading shortcut observes the same disabled state');
});

test('toolbar alignment icon and menu checks derive each supported alignment and fall back to left', t => {
    const h = toolbarFixture(t);
    const icon = new FakeElement();
    h.toolbar.selectors.set('[data-current-align-icon]', [icon]);
    const checks = ['left', 'center', 'right', 'justify'].map(value => new FakeElement({ menuCheck: `align-${value}` }));
    h.toolbar.selectors.set('[data-menu-check]', checks);
    for (const value of ['left', 'center', 'right', 'justify', undefined, 'invalid']) {
        h.setAlignment(value);
        h.runtime.updateToolbarState();
        const displayed = ['left', 'center', 'right', 'justify'].includes(value) ? value : 'left';
        assert.equal(icon.textContent, `format_align_${displayed}`);
        for (const check of checks) assert.equal(check.attributes.get('aria-checked'), String(check.dataset.menuCheck === `align-${displayed}`));
    }
});

test('toolbar selection shortcuts and clicks execute the same operations and close menus', t => {
    const h = toolbarFixture(t);
    for (const [action, event] of [
        ['toggle-heading-collapse', { metaKey: true, altKey: true, key: 'h' }],
        ['move-blocks-up', { altKey: true, key: 'ArrowUp' }],
        ['move-blocks-down', { altKey: true, key: 'ArrowDown' }],
        ['delete-blocks', { key: 'Delete' }],
    ]) {
        h.calls.length = 0;
        h.menu.hidden = false;
        h.click(h.button({ editorAction: action }));
        const clicked = h.calls.slice();
        h.calls.length = 0;
        h.menu.hidden = false;
        h.key(event);
        assert.deepEqual(h.calls, clicked, action);
        assert.equal(h.menu.hidden, true, action);
    }
});

function imageEditor() {
    const schema = new Schema({ nodes: {
        doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
        inlineImage: { group: 'inline', inline: true, atom: true, attrs: Object.fromEntries(['clientId', 'status', 'error', 'url', 'mediaId', 'alt', 'width'].map(key => [key, { default: '' }])) },
    } });
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', { id: 'one' }, [schema.node('inlineImage', { clientId: 'image-1', status: 'uploading' })])]) });
    const editor = { _tiptapEditor: { state }, dispatch(transaction) { this._tiptapEditor.state = this._tiptapEditor.state.apply(transaction); } };
    return { editor, attrs: () => editor._tiptapEditor.state.doc.firstChild.firstChild.attrs };
}

async function imageFixture(t) {
    const env = environment(t);
    const { window } = env;
    const requests = [];
    class Xhr {
        constructor() { this.upload = {}; requests.push(this); }
        open(method, url) { this.url = url; }
        setRequestHeader() {}
        send(body) { this.body = body; }
        abort() { this.onabort?.(); }
        respond(status, response) { this.status = status; this.response = response; this.onload(); }
    }
    env.set('XMLHttpRequest', Xhr);
    await import('../../static/js/core/http.js');
    httpFactory ||= window.APStudyCoreServices.http.createHttpService;
    let pending = 0;
    window.APStudyHttp = httpFactory({ window, csrf: { token: () => '' }, pendingMutations: { track: promise => { pending++; return promise.finally(() => { pending--; }); } } });
    const image = imageEditor();
    let saves = 0;
    const options = { editor: image.editor, noteId: 'note/1', onChange: () => { saves++; } };
    const cleanup = bindImageRuntime(options);
    env.onCleanup(cleanup);
    return { ...env, ...image, requests, options, file: new File(['image'], 'photo.png', { type: 'image/png' }), saves: () => saves, pending: () => pending };
}

for (const payload of [null, '<html>login</html>', {}, { id: 'media' }, { url: '/media' }, { id: ' ', url: '/media' }, { id: 'media', url: null }]) {
    test(`note upload rejects invalid 2xx payload ${JSON.stringify(payload)} and public retry retains the original file`, async t => {
        const h = await imageFixture(t);
        const { window } = h;
        const request = uploadInlineImage(h.file, 'image-1', h.options);
        h.requests[0].respond(201, payload);
        await request;
        assert.equal(h.attrs().status, 'error');
        assert.match(h.attrs().error, /Invalid upload response/);
        assert.equal(h.saves(), 0);
        assert.equal(h.pending(), 0);
        window.dispatchEvent(new globalThis.CustomEvent('notes-image-retry', { detail: { clientId: 'image-1' } }));
        assert.equal(h.requests.length, 2);
        const retained = h.requests[1].body.get('file');
        assert.equal(retained.name, h.file.name);
        assert.equal(retained.type, h.file.type);
        assert.equal(await retained.text(), await h.file.text());
        h.requests[1].respond(201, { id: 'media', url: '/media', name: 'Photo', width: 120 });
        await settle();
        assert.equal(h.attrs().status, 'ready');
        assert.equal(h.attrs().mediaId, 'media');
        assert.equal(h.attrs().url, '/media');
        assert.equal(h.saves(), 1);
        window.dispatchEvent(new globalThis.CustomEvent('notes-image-retry', { detail: { clientId: 'image-1' } }));
        assert.equal(h.requests.length, 2, 'valid acknowledgment releases the retry file');
    });
}

test('note upload setup errors retain retry state and cancellation cannot overwrite its node', async t => {
    const h = await imageFixture(t);
    const { window } = h;
    const upload = window.APStudyHttp.uploadXhr;
    window.APStudyHttp.uploadXhr = () => { throw new Error('Unable to start upload'); };
    await uploadInlineImage(h.file, 'image-1', h.options);
    assert.equal(h.attrs().error, 'Unable to start upload');
    window.APStudyHttp.uploadXhr = upload;
    window.dispatchEvent(new globalThis.CustomEvent('notes-image-retry', { detail: { clientId: 'image-1' } }));
    assert.equal(h.requests.length, 1);
    const replacement = uploadInlineImage(h.file, 'image-1', h.options);
    h.requests[1].respond(403, { error: 'Cannot edit this note.' });
    await replacement;
    assert.equal(h.attrs().error, 'Cannot edit this note.');
    await settle();
    assert.equal(h.pending(), 0);
});

function anchorState() {
    const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', attrs: { id: { default: null } } }, text: {} } });
    return EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', { id: 'one' }, schema.text('hello'))]) });
}

test('comment anchor resolves nullable wire offsets through its minimal optional state port', () => {
    const state = anchorState();
    const anchor = { kind: 'document', state: 'attached', version: 1, start_block_id: 'one', end_block_id: 'one', start_offset: null, end_offset: null };
    assert.deepEqual(resolveCommentAnchor({ _tiptapEditor: { state } }, anchor), { from: 1, to: 1 });
    assert.deepEqual(resolveCommentAnchor({ _tiptapEditor: { state } }, { ...anchor, start_offset: 1, end_offset: 4 }), { from: 2, to: 5 });
    for (const editor of [null, undefined, {}, { _tiptapEditor: {} }]) assert.equal(resolveCommentAnchor(editor, anchor), null);
    assert.equal(resolveCommentAnchor({ _tiptapEditor: { state } }, { ...anchor, state: 'detached' }), null);
});

test('review public history and suggestion controls accept nullable backend records and conflict status', async t => {
    const h = environment(t);
    const panel = new FakeElement();
    const body = new FakeElement();
    const title = new FakeElement();
    panel.selectors.set('[data-review-panel-body]', [body]);
    panel.selectors.set('[data-review-panel-title]', [title]);
    h.set('fetch', async url => ({ ok: true, json: async () => url.endsWith('/versions')
        ? { versions: [{ id: 'version', name: null, actor: null, reason: 'automatic', created_at: '2026-10-05' }] }
        : url.endsWith('/suggestions') ? { suggestions: [{ id: 'conflict', status: 'conflicted', author: null, summary: 'Needs revision' }] }
            : { threads: [{ id: 'thread', body: 'Existing comment', author: null, status: 'open', anchor: { kind: 'document', state: 'attached', version: 1, start_offset: null, end_offset: null } }] }, }));
    const runtime = bindReviewPanel({ noteId: 'note', panel, canReview: true, canViewVersions: true });
    h.onCleanup(() => runtime.destroy());
    await runtime.open('history');
    assert.match(body.innerHTML, /Automatic version/);
    assert.match(body.innerHTML, /automatic/);
    await runtime.open('review');
    assert.match(body.innerHTML, /Existing comment/);
    const tab = new FakeElement({ reviewTab: 'suggestions' });
    tab.selectors.set('closest:[data-review-tab]', [tab]);
    panel.dispatch('click', { target: tab });
    await settle();
    assert.match(body.innerHTML, /Needs revision/);
    assert.match(body.innerHTML, /conflicted/);
});
