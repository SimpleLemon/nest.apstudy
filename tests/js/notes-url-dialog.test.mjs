import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement } from './helpers/notes-runtime.mjs';

function urlDialogHarness() {
    const h = createHarness();
    Object.assign(h.context, h.load('block-catalog.js', ['blockPayloadForCatalogItem', 'catalogItemByKey', 'catalogItemByType']));
    Object.assign(h.context, h.load('block-properties.js', ['ATOM_BLOCK_TYPES']));
    Object.assign(h.context, h.load('utils.js', ['claimElementBinding']));
    h.context.URL = URL;
    h.context.blockOwnContentIsEmpty = () => true;
    h.window.innerHeight = 800;
    const forms = [];
    const focus = [];
    const updates = [];
    h.context.document.body = { appendChild() {} };
    h.context.document.createElement = () => {
        const form = new FakeElement();
        const input = new FakeElement();
        const cancel = new FakeElement();
        input.focus = () => focus.push('input');
        form.contains = (node) => node === form || node === input || node === cancel;
        form.remove = () => { form.removals = (form.removals || 0) + 1; };
        form.selectors.set('input[name="url"]', [input]);
        form.selectors.set('[data-url-block-cancel]', [cancel]);
        form.selectors.set('.notes-url-block-error', [new FakeElement()]);
        forms.push({ form, input, cancel });
        return form;
    };
    const editor = {
        getTextCursorPosition: () => ({ block: { id: 'current' } }),
        updateBlock: (block, payload) => { updates.push(payload); return { ...payload, id: block.id }; },
        insertBlocks: () => [{ id: 'after', type: 'paragraph' }],
        setTextCursorPosition() {},
        focus: () => focus.push('editor'),
    };
    const { createCatalogActions } = h.load('catalog-actions.js', ['createCatalogActions']);
    const actions = createCatalogActions({
        getEditor: () => editor, closeToolbarMenus() {},
        focusEditorBody: () => focus.push('body'), updateEditorChrome() {}, triggerDebouncedSave() {},
    });
    const { createToolbarDom } = h.load('toolbar-dom.js', ['createToolbarDom']);
    const toolbar = new FakeElement();
    toolbar.contains = (node) => node === toolbar;
    createToolbarDom({ writingToolbar: toolbar, getCanEdit: () => true, getEditor: () => editor, actions }).bindWritingToolbar();
    return { ...h, actions, forms, focus, updates, toolbar, insert: () => actions.insertCatalogItem(h.context.catalogItemByKey('video')) };
}

for (const dismissal of ['outside click', 'Escape', 'Cancel']) {
    test(`URL dialog ${dismissal} settles insertion and restores editor focus`, async () => {
        const h = urlDialogHarness();
        const pending = h.insert();
        const { form, input, cancel } = h.forms[0];
        assert.deepEqual(h.focus, ['input']);
        h.context.document.dispatch('click', { target: input });
        h.context.document.dispatch('click', { target: h.toolbar });
        assert.equal(h.actions.hasUrlBlockPopover(), true, 'dialog and toolbar clicks keep the request pending');
        if (dismissal === 'outside click') h.context.document.dispatch('click', { target: new FakeElement() });
        else if (dismissal === 'Escape') h.context.document.dispatch('keydown', { key: 'Escape' });
        else cancel.dispatch('click');
        assert.equal(await pending, null);
        assert.equal(h.actions.hasUrlBlockPopover(), false);
        assert.equal(form.removals, 1);
        assert.deepEqual(h.focus, ['input', 'body']);
        assert.deepEqual(h.updates, []);
        h.actions.removeUrlBlockPopover('https://example.com/late');
        assert.equal(form.removals, 1, 'repeated cleanup does not complete an old request again');
    });
}

test('URL dialog validates before settling and inserts a valid URL with editor focus', async () => {
    const h = urlDialogHarness();
    const pending = h.insert();
    const { form, input } = h.forms[0];
    input.value = 'javascript:alert(1)';
    form.dispatch('submit', { preventDefault() {} });
    assert.equal(h.actions.hasUrlBlockPopover(), true);
    assert.equal(form.querySelector('.notes-url-block-error').hidden, false);
    input.value = ' https://example.com/video ';
    form.dispatch('submit', { preventDefault() {} });
    const inserted = await pending;
    assert.equal(inserted.type, 'video');
    assert.equal(h.updates[0].props.url, 'https://example.com/video');
    assert.equal(form.removals, 1);
    assert.deepEqual(h.focus, ['input', 'editor']);
});

test('replacing and disposing URL dialogs settle their original requests', async () => {
    const h = urlDialogHarness();
    const first = h.insert();
    const second = h.insert();
    assert.equal(await first, null);
    assert.equal(h.forms[0].form.removals, 1);
    assert.equal(h.actions.getUrlBlockPopover(), h.forms[1].form);
    h.actions.dispose();
    assert.equal(await second, null);
    assert.equal(h.forms[1].form.removals, 1);
    assert.deepEqual(h.updates, []);
    assert.equal(h.actions.hasUrlBlockPopover(), false);
});
