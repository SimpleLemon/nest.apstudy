import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement } from './helpers/notes-runtime.mjs';

// A hook host lets the public components run without importing BlockNote or a DOM.
// Interactions use their rendered buttons and effects, never private closures.
function createMenuHarness() {
    const h = createHarness();
    const slots = [];
    let cursor = 0;
    let effects = [];
    const sameDeps = (previous, next) => previous?.length === next?.length
        && previous.every((value, index) => value === next[index]);
    const React = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null) }),
        useState(initial) {
            const index = cursor++;
            slots[index] ||= { value: initial };
            return [slots[index].value, (value) => { slots[index].value = value; }];
        },
        useRef(initial) {
            const index = cursor++;
            return slots[index] ||= { current: initial };
        },
        useCallback(callback, deps) {
            const index = cursor++;
            if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, callback };
            return slots[index].callback;
        },
        useEffect(effect, deps) {
            const index = cursor++;
            if (sameDeps(slots[index]?.deps, deps)) return;
            const previous = slots[index];
            slots[index] = { deps };
            effects.push(() => {
                previous?.cleanup?.();
                slots[index].cleanup = effect();
            });
        },
    };
    h.context.React = React;
    Object.assign(h.context, h.load('block-catalog.js', ['filterBlockCatalog', 'blockIconClass']));
    const { createNotesMenuComponents } = h.load('menu-components.js', ['createNotesMenuComponents']);
    const calls = [];
    const blockActions = Object.fromEntries(['select', 'addBelow', 'copy', 'duplicate', 'remove', 'move', 'toggleHeading', 'turnInto', 'insertCatalogItem']
        .map((name) => [name, (...args) => { calls.push([name, ...args]); return Promise.resolve(); }]));
    const menus = createNotesMenuComponents({ blockActions });
    const inside = {};
    return {
        ...h, calls, menus, inside,
        render(Component, props) {
            cursor = 0;
            effects = [];
            const tree = Component(props);
            if (tree.props.ref) tree.props.ref.current = { contains: (target) => target === inside };
            effects.forEach((effect) => effect());
            return tree;
        },
        unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
    };
}

function descendants(node) {
    return typeof node === 'object' && node ? [node, ...node.children.flatMap(descendants)] : [];
}
const visibleText = (node) => typeof node === 'object' ? node.children.map(visibleText).join('') : String(node);
function button(tree, label) {
    const match = descendants(tree).find((node) => node.type === 'button'
        && (node.props['aria-label'] || visibleText(node.children.at(-1))) === label);
    assert.ok(match, `button ${label} is available`);
    return match;
}
function event() {
    return { prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('slash menu filters catalog, exposes selected options, and inserts into its editor', async () => {
    const h = createMenuHarness();
    const editor = {};
    const items = await h.menus.getSlashItems('h2', editor);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Heading 2');
    assert.equal((await h.menus.getSlashItems('no-such-block', editor)).length, 0);
    let chosen;
    const tree = h.render(h.menus.NotesSlashMenu, { items, selectedIndex: 0, onItemClick: (item) => { chosen = item; } });
    assert.equal(tree.props.role, 'listbox');
    const option = descendants(tree).find((node) => node.props.role === 'option');
    assert.equal(option.props['aria-selected'], 'true');
    const click = event();
    option.props.onMouseDown(click);
    assert.equal(click.prevented, true, 'menu interaction preserves the editor selection');
    option.props.onClick(click);
    assert.equal(click.stopped, true);
    assert.equal(chosen, items[0]);
    await chosen.onItemClick();
    assert.equal(h.calls[0][0], 'insertCatalogItem');
    assert.equal(h.calls[0][1].type, 'heading');
    assert.equal(h.calls[0][1].props, chosen.props);
    assert.equal(h.calls[0][2], null);
    assert.equal(h.calls[0][3], editor);
    const unselected = h.render(h.menus.NotesSlashMenu, { items, selectedIndex: -1 });
    assert.equal(descendants(unselected).find((node) => node.props.role === 'option').props['aria-selected'], 'false');
});

test('side controls select ranges, anchor insertion, and preserve block drag callbacks', async () => {
    const h = createMenuHarness();
    const block = { id: 'target', type: 'paragraph' };
    const drag = [];
    const tree = h.render(h.menus.NotesSideMenu, { block,
        blockDragStart: (...args) => drag.push(['start', ...args]), blockDragEnd: (...args) => drag.push(['end', ...args]) });
    const select = button(tree, 'Select block');
    const click = { ...event(), shiftKey: true };
    select.props.onClick(click);
    assert.equal(click.prevented, true);
    assert.deepEqual(h.calls[0], ['select', block, true]);
    assert.equal(select.props.draggable, true);
    select.props.onDragStart(click);
    select.props.onDragEnd(click);
    assert.deepEqual(drag, [['start', click, block], ['end', click]]);
    const anchorRect = { left: 10, top: 20, width: 24, height: 24 };
    const add = { ...event(), currentTarget: { getBoundingClientRect: () => anchorRect } };
    await button(tree, 'Add block below').props.onClick(add);
    assert.equal(add.prevented, true);
    assert.deepEqual(h.calls[1], ['addBelow', block, anchorRect]);
});

test('side actions target the menu block, close afterwards, and restrict conversion choices', () => {
    const scenarios = [['Copy', 'copy'], ['Duplicate', 'duplicate'], ['Delete', 'remove'], ['Move up', 'move', 'up'], ['Move down', 'move', 'down'], ['Collapse', 'toggleHeading']];
    for (const [label, action, direction] of scenarios) {
        const h = createMenuHarness();
        const block = { id: 'heading', type: 'heading', props: { isCollapsed: false } };
        const render = () => h.render(h.menus.NotesSideMenu, { block });
        button(render(), 'Block actions').props.onClick();
        button(render(), label).props.onClick();
        assert.deepEqual(h.calls[0], direction ? [action, block, direction] : [action, block]);
        assert.equal(button(render(), 'Block actions').props['aria-expanded'], 'false');
        h.unmount();
    }
    const h = createMenuHarness();
    const block = { id: 'paragraph', type: 'paragraph' };
    const render = () => h.render(h.menus.NotesSideMenu, { block });
    button(render(), 'Block actions').props.onClick();
    button(render(), 'Turn into').props.onClick();
    const tree = render();
    const submenu = descendants(tree).find((node) => node.props.className === 'notes-side-submenu');
    const choices = descendants(submenu).filter((node) => node.type === 'button').map(visibleText);
    assert.ok(choices.some((text) => text.includes('Heading 2')));
    assert.ok(!choices.some((text) => /Image|Video|Bookmark/.test(text)), 'conversion excludes atom blocks');
    button(tree, 'Heading 2').props.onClick();
    assert.equal(h.calls[0][0], 'turnInto');
    assert.equal(h.calls[0][1], block);
    assert.equal(h.calls[0][2].type, 'heading');
    assert.equal(h.calls[0][2].props.level, 2);
    assert.equal(button(render(), 'Block actions').props['aria-expanded'], 'false');
    h.unmount();
});

test('open side menus freeze placement, dismiss outside or on Escape, and release subscriptions', () => {
    const h = createMenuHarness();
    let freezes = 0;
    let unfreezes = 0;
    const props = { block: { type: 'paragraph' }, freezeMenu: () => { freezes++; }, unfreezeMenu: () => { unfreezes++; } };
    const render = () => h.render(h.menus.NotesSideMenu, props);
    const open = () => { button(render(), 'Block actions').props.onClick(); return render(); };
    open();
    assert.equal(freezes, 1);
    h.context.document.dispatch('pointerdown', { target: h.inside });
    assert.equal(button(render(), 'Block actions').props['aria-expanded'], 'true');
    const escape = { ...event(), key: 'Escape' };
    h.context.document.dispatch('keydown', escape);
    assert.equal(escape.prevented, true);
    assert.equal(button(render(), 'Block actions').props['aria-expanded'], 'false');
    assert.equal(unfreezes, 1);
    open();
    h.context.document.dispatch('pointerdown', { target: {} });
    assert.equal(button(render(), 'Block actions').props['aria-expanded'], 'false');
    assert.equal(unfreezes, 2);
    open();
    h.unmount();
    assert.equal(unfreezes, 3);
    assert.equal(h.context.document.listeners.get('pointerdown').size, 0);
    assert.equal(h.context.document.listeners.get('keydown').size, 0);
});

function createShellHarness({ canEdit = true } = {}) {
    const h = createMenuHarness();
    const titleInput = new FakeElement();
    const blocknoteRoot = new FakeElement();
    const editor = { document: [{ id: 'loaded', type: 'paragraph' }] };
    let instance = null;
    let mountedTree = null;
    let unmounts = 0;
    const calls = [];
    h.context.document.documentElement = new FakeElement();
    h.window.APStudyLoader = { html: (label) => `<span>${label}</span>` };
    Object.assign(h.context, h.load('utils.js', ['buildLoadingIndicatorHtml', 'documentHasText', 'isBlankTitle']));
    Object.assign(h.context, {
        createRoot: () => ({
            render: (element) => { mountedTree = h.render(element.type, element.props); },
            unmount: () => { unmounts++; h.unmount(); },
        }),
        History: { configure: () => ({}) }, notesEditorSchema: {},
        preserveRangeSelectionShortcuts: {}, listItemHardBreakShortcuts: {}, createSelectAllShortcuts: () => ({}),
        useCreateBlockNote: () => editor, useEditorContentOrSelectionChange() {},
        BlockNoteView: 'editor-view', SuggestionMenuController: 'slash-controller', SideMenuController: 'side-controller',
        normalizeImportedMarkdownBlocks: (blocks) => ({ blocks, changed: false }),
    });
    const { createReactShell } = h.load('react-shell.js', ['createReactShell']);
    const getItemsCalls = [];
    const menus = { NotesSlashMenu() {}, NotesSideMenu() {}, getSlashItems: (...args) => { getItemsCalls.push(args); return []; } };
    const shell = createReactShell({
        noteContext: { access: { can_edit: canEdit } }, noteId: 'note', titleInput, blocknoteRoot,
        getCanEdit: () => canEdit, setEditorReadOnlyMode: (value) => { canEdit = !value; },
        getEditor: () => instance, setEditorInstance: (value) => { instance = value; },
        setNotePrintReady: (value) => calls.push(['print', value]), setNoteCollaborationEnabled() {},
        setSaveStatus() {}, setLastSavedPayloadFingerprint() {}, notePayloadFingerprint: () => 'fingerprint',
        getEditorPageDisposed: () => false, currentDocumentSnapshot: () => editor.document,
        invalidateDocumentSnapshot() {}, captureHistoryBaseline() {}, updateEditorChrome() {}, triggerDebouncedSave() {},
        bindWritingToolbar() {}, bindImageRuntime: () => () => calls.push(['images', 'cleanup']),
        bindLazyReviewPanel: (permissions) => calls.push(['review', permissions]), resetReviewPanel: () => calls.push(['review', 'reset']),
        pageSetup: { setLoadedPageSetup() {} }, menus, toggleHeadingCollapse() {}, focusEditorBody() {},
    });
    const respond = () => h.requests.at(-1).resolve({ ok: true, headers: { get: () => 'generation' }, json: async () => ({
        title: 'Loaded title', content: JSON.stringify(editor.document), collaboration_enabled: false,
        access: { can_edit: canEdit, can_review: true, can_manage_reviews: false },
    }) });
    return { ...h, shell, titleInput, blocknoteRoot, editor, menus, calls, getItemsCalls, respond,
        mountedTree: () => mountedTree, instance: () => instance, unmounts: () => unmounts };
}

test('document shell mounts injected menus for editors, gates viewers, and releases its document subscriptions', async () => {
    for (const canEdit of [true, false]) {
        const h = createShellHarness({ canEdit });
        const loading = h.shell.initEditorPage();
        assert.equal(h.requests[0].url, '/api/notes/note');
        h.respond();
        await loading;
        h.flushTimers();
        assert.equal(h.titleInput.value, 'Loaded title');
        assert.equal(h.instance(), h.editor);
        assert.equal(h.editor.isEditable, canEdit);
        const controllers = h.mountedTree().children;
        assert.equal(controllers.length, canEdit ? 2 : 0);
        if (canEdit) {
            assert.equal(controllers[0].props.suggestionMenuComponent, h.menus.NotesSlashMenu);
            assert.equal(controllers[1].props.sideMenu, h.menus.NotesSideMenu);
            await controllers[0].props.getItems('heading');
            assert.deepEqual(h.getItemsCalls, [['heading', h.editor]]);
        }
        const reviewPermissions = h.calls.find(([name, value]) => name === 'review' && typeof value === 'object')[1];
        assert.equal(reviewPermissions.canReview, true);
        assert.equal(reviewPermissions.canManageReviews, false);
        assert.equal(reviewPermissions.canViewVersions, canEdit);
        h.shell.pause();
        h.shell.resume();
        assert.equal(h.instance(), h.editor, 'pause/resume retains the mounted document');
        h.shell.release();
        assert.equal(h.instance(), null);
        assert.equal(h.unmounts(), 1);
        assert.equal(h.titleInput.listeners.get('input').size, 0);
        assert.equal(h.blocknoteRoot.listeners.get('copy').size, 0);
        assert.equal(h.blocknoteRoot.listeners.get('cut').size, 0);
        assert.equal(h.timers.size, 0);
        assert.ok(h.calls.some(([name, value]) => name === 'print' && value === false));
        assert.ok(h.calls.some(([name, value]) => name === 'images' && value === 'cleanup'));
    }
});

test('released document loads abort and cannot mount late responses or menus', async () => {
    const h = createShellHarness();
    const loading = h.shell.initEditorPage();
    h.shell.release();
    assert.equal(h.requests[0].options.signal.aborted, true);
    h.respond();
    await loading;
    assert.equal(h.mountedTree(), null);
    assert.equal(h.instance(), null);
    assert.equal(h.titleInput.value, '');
    assert.equal(h.getItemsCalls.length, 0);
});
