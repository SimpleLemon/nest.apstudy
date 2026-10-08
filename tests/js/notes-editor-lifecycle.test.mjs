import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement, settle } from './helpers/notes-runtime.mjs';

test('document snapshots cache expensive serialization until content invalidates them', () => {
    const h = createHarness();
    const { createDocumentState } = h.load('document-state.js', ['createDocumentState']);
    let reads = 0;
    let content = [{ id: 'first' }];
    let editor = { get document() { reads++; return content; }, _tiptapEditor: { state: { doc: { firstChild: { childCount: 125 } } } } };
    const runtime = createDocumentState({ getEditor: () => editor });
    assert.equal(runtime.editorTopLevelBlockCount(), 125);
    assert.equal(reads, 0, 'size checks use ProseMirror without serializing');
    assert.equal(runtime.currentDocumentSnapshot(), content);
    content = [{ id: 'edited' }];
    assert.equal(runtime.currentDocumentSnapshot()[0].id, 'first');
    assert.equal(reads, 1);
    runtime.invalidateDocumentSnapshot();
    assert.equal(runtime.currentDocumentSnapshot()[0].id, 'edited');
    delete editor._tiptapEditor;
    assert.equal(runtime.editorTopLevelBlockCount(), 1);
    runtime.dispose();
    assert.equal(runtime.getLatestDocumentSnapshot(), null);
    editor = null;
    assert.equal(runtime.currentDocumentSnapshot().length, 0);
});

function setupPrint() {
    const h = createHarness();
    Object.assign(h.context, h.load('heading-collapse.js', ['hiddenBlocksForCollapsedHeadings']));
    h.context.document.contains = () => true;
    const button = new FakeElement();
    button.toggleAttribute = (name, enabled) => enabled ? button.setAttribute(name, '') : button.removeAttribute(name);
    button.selectors.set('closest:[data-note-print]', [button]);
    const title = new FakeElement();
    title.value = 'Print title';
    const calls = [];
    let loadCount = 0;
    let resolveModule;
    const { createPrintRuntime } = h.load('print-runtime.js', ['createPrintRuntime']);
    const runtime = createPrintRuntime({
        getEditor: () => ({}), titleInput: title, notePrintButtons: [button],
        currentDocumentSnapshot: () => [
            { id: 'heading', type: 'heading', props: { level: 1, isCollapsed: true } },
            { id: 'hidden', type: 'paragraph' },
        ],
        getPageSetup: () => ({ sideMargins: '12%' }), getFontFamily: () => 'Serif',
        closeToolbarMenus() {}, closePageSetupPopover() {},
        loadModule: () => { loadCount++; return new Promise((resolve) => { resolveModule = resolve; }); },
    });
    const click = () => h.context.document.dispatch('click', { target: button, preventDefault() {} });
    const loaded = () => resolveModule({ printNote: async (options) => calls.push({ ...options, hiddenBlockIds: [...options.hiddenBlockIds] }) });
    runtime.bind();
    return { ...h, runtime, button, calls, click, loaded, loadCount: () => loadCount };
}

test('print controls stay disabled until ready and coalesce clicks during lazy loading', async () => {
    const h = setupPrint();
    assert.equal(h.button.disabled, true);
    h.click();
    assert.equal(h.loadCount(), 0);
    h.runtime.setReady(true);
    assert.equal(h.button.disabled, false);
    h.click();
    h.click();
    assert.equal(h.loadCount(), 1);
    assert.equal(h.button.attributes.has('aria-busy'), true);
    h.loaded();
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].title, 'Print title');
    assert.equal(h.calls[0].sideMargins, '12%');
    assert.deepEqual(h.calls[0].hiddenBlockIds, ['hidden']);
    assert.equal(h.button.disabled, false);
    h.runtime.dispose();
});

test('disposing during lazy print loading prevents printing and removes listeners', async () => {
    const h = setupPrint();
    h.runtime.setReady(true);
    h.click();
    h.runtime.dispose();
    h.loaded();
    await settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.button.disabled, true);
    assert.equal(h.context.document.listeners.get('click').size, 0);
    assert.equal(h.context.document.listeners.get('keydown').size, 0);
    h.runtime.setReady(true);
    assert.equal(h.button.disabled, true);
});

function setupReview(loadModule) {
    const h = createHarness();
    const { createReviewRuntime } = h.load('review/review-runtime.js', ['createReviewRuntime']);
    const review = new FakeElement();
    const history = new FakeElement();
    const runtime = createReviewRuntime({ noteId: 'note', reviewPanel: new FakeElement(), reviewButton: review, historyButton: history, loadModule });
    runtime.bind({ canReview: true, canManageReviews: false, canViewVersions: true });
    return { ...h, runtime, review, history };
}

test('review loads once across both controls and destroys its controller on disposal', async () => {
    let resolveModule;
    let loads = 0;
    let binds = 0;
    let destroys = 0;
    const modes = [];
    const h = setupReview(() => { loads++; return new Promise((resolve) => { resolveModule = resolve; }); });
    h.review.dispatch('click');
    h.history.dispatch('click');
    resolveModule({ bindReviewPanel: (options) => {
        binds++;
        assert.equal(options.canManageReviews, false);
        return { open: async (mode) => modes.push(mode), destroy: () => { destroys++; } };
    } });
    await settle();
    assert.equal(loads, 1);
    assert.equal(binds, 1);
    assert.deepEqual(modes, ['review', 'history']);
    assert.equal(h.review.attributes.has('aria-busy'), false);
    h.runtime.dispose();
    h.review.dispatch('click');
    assert.equal(destroys, 1);
    assert.equal(h.review.listeners.get('click').size, 0);
});

test('review import completing after disposal cannot mount or open a controller', async () => {
    let resolveModule;
    let binds = 0;
    const h = setupReview(() => new Promise((resolve) => { resolveModule = resolve; }));
    h.review.dispatch('click');
    h.runtime.dispose();
    resolveModule({ bindReviewPanel: () => { binds++; } });
    await settle();
    assert.equal(binds, 0);
    assert.equal(h.review.attributes.has('aria-busy'), false);
});

test('review can retry a failed lazy module load', async () => {
    let loads = 0;
    let opens = 0;
    const h = setupReview(() => {
        loads++;
        return loads === 1
            ? Promise.reject(new Error('temporary asset failure'))
            : Promise.resolve({ bindReviewPanel: () => ({ open: async () => { opens++; } }) });
    });
    h.review.dispatch('click');
    await settle();
    assert.equal(h.errors.length, 1);
    assert.equal(h.review.attributes.has('aria-busy'), false);
    h.review.dispatch('click');
    await settle();
    assert.equal(loads, 2);
    assert.equal(opens, 1);
    h.runtime.dispose();
});

test('review capability changes cancel late lazy opens and current permissions gate both controls', async () => {
    let resolveModule;
    const bindings = [];
    const modes = [];
    let destroys = 0;
    const h = setupReview(() => new Promise((resolve) => { resolveModule = resolve; }));
    h.review.dispatch('click');
    h.runtime.bind({ canReview: false, canManageReviews: false, canViewVersions: false });
    resolveModule({ bindReviewPanel: (options) => {
        bindings.push(options);
        return { open: async (mode) => modes.push(mode), destroy: () => { destroys++; } };
    } });
    await settle();
    assert.equal(bindings.length, 0);
    assert.equal(h.review.disabled, true);
    assert.equal(h.history.disabled, true);
    h.review.dispatch('click');
    h.history.dispatch('click');
    await settle();
    assert.equal(bindings.length, 0);
    h.runtime.bind({ canReview: true, canManageReviews: false, canViewVersions: false });
    h.history.dispatch('click');
    h.review.dispatch('click');
    await settle();
    assert.deepEqual(modes, ['review']);
    assert.equal(bindings[0].canViewVersions, false);
    h.runtime.bind({ canReview: true, canManageReviews: false, canViewVersions: false });
    assert.equal(destroys, 0, 'unchanged capabilities retain the open controller and its input');
    h.runtime.bind({ canReview: false, canManageReviews: false, canViewVersions: false });
    assert.equal(destroys, 1);
    h.runtime.dispose();
});

test('review invalidation uses its current controller and a document reset invalidates lazy work', async () => {
    let resolveModule;
    let refreshed = 0;
    let destroyed = 0;
    let opened = 0;
    const h = setupReview(() => new Promise((resolve) => { resolveModule = resolve; }));
    h.runtime.invalidate({ type: 'review.comment.created' });
    assert.equal(refreshed, 0, 'remote events do not eagerly mount review tools');
    h.review.dispatch('click');
    h.runtime.reset();
    resolveModule({ bindReviewPanel: () => ({
        open: async () => { opened++; }, refresh: async () => { refreshed++; }, destroy: () => { destroyed++; },
    }) });
    await settle();
    assert.equal(opened, 0, 'old document cannot mount after its module resolves');
    h.runtime.bind({ canReview: true, canManageReviews: false, canViewVersions: true });
    h.review.dispatch('click');
    await settle();
    h.runtime.invalidate({ type: 'durable' });
    h.runtime.invalidate({ type: 'review.comment.replied' });
    assert.equal(refreshed, 1);
    h.runtime.reset();
    h.runtime.invalidate({ type: 'review.comment.replied' });
    assert.equal(refreshed, 1);
    assert.equal(destroyed, 1);
    h.runtime.dispose();
});

test('catalog insertion rechecks permissions after awaiting a payload and stops after disposal', async () => {
    const h = createHarness();
    Object.assign(h.context, h.load('block-catalog.js', ['blockPayloadForCatalogItem', 'catalogItemByKey', 'catalogItemByType']));
    Object.assign(h.context, h.load('block-properties.js', ['ATOM_BLOCK_TYPES']));
    h.context.blockOwnContentIsEmpty = () => true;
    const { createCatalogActions } = h.load('catalog-actions.js', ['createCatalogActions']);
    let canEdit = true;
    let updates = 0;
    const editor = { getTextCursorPosition: () => ({ block: { id: 'first' } }), updateBlock: () => { updates++; return { id: 'first', type: 'paragraph' }; } };
    const runtime = createCatalogActions({ getEditor: () => editor, getCanEdit: () => canEdit, closeToolbarMenus() {}, focusEditorBody() {}, updateEditorChrome() {}, triggerDebouncedSave() {} });
    const insertion = runtime.insertCatalogItem(h.context.catalogItemByKey('paragraph'));
    canEdit = false;
    await insertion;
    assert.equal(updates, 0);
    canEdit = true;
    const next = runtime.insertCatalogItem(h.context.catalogItemByKey('paragraph'));
    runtime.dispose();
    await next;
    assert.equal(updates, 0);
});
