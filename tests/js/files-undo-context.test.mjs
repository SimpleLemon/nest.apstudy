import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFilesModule } from './helpers/files-modules.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function surface() {
    const listeners = new Map();
    const controls = new Map();
    return {
        hidden: true, innerHTML: '', textContent: '', value: '', dataset: {}, style: { setProperty() {} }, children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, focus() {}, remove() {}, contains: () => false,
        getBoundingClientRect: () => ({ top: 10, bottom: 20, right: 50, width: 40, height: 40 }),
        appendChild(node) { this.children.push(node); },
        addEventListener(type, handler) { listeners.set(type, [...listeners.get(type) || [], handler]); },
        emit(type, event = {}) { for (const handler of listeners.get(type) || []) handler({ preventDefault() {}, stopPropagation() {}, ...event }); },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        querySelectorAll(selector) {
            const attributes = { '[data-file-menu]': 'fileMenu', '[data-folder-menu]': 'folderMenu', '[data-select-file]': 'selectFile', '[data-select-folder]': 'selectFolder', '[data-menu-index]': 'menuIndex' };
            const key = attributes[selector];
            if (!key) return [];
            const attr = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
            return [...this.innerHTML.matchAll(new RegExp(`data-${attr}="([^"]+)"`, 'g'))].map(match => {
                const controlKey = `${this.innerHTML}:${selector}:${match[1]}`;
                if (!controls.has(controlKey)) { const node = surface(); node.dataset[key] = match[1]; controls.set(controlKey, node); }
                return controls.get(controlKey);
            });
        },
    };
}
async function manager({ undo = true } = {}) {
    const ids = ['folder-title', 'folder-meta', 'loading', 'empty', 'files', 'files-section', 'folders', 'folders-section', 'breadcrumbs',
        'confirm-modal', 'confirm-input', 'confirm-submit', 'confirm-form', 'bulk-delete', 'move-modal', 'move-destination'];
    const els = Object.fromEntries(ids.map(id => [id, surface()]));
    const document = Object.assign(surface(), { body: surface(), activeElement: surface(),
        getElementById: id => els[id.replace('file-share-', '')] || null, querySelector: () => null,
        createElement: () => surface(), querySelectorAll: () => [],
    });
    const file = { id: 'origin-file', filename: 'Origin.pdf' };
    const folder = { id: 'origin-folder', name: 'Origin folder', parentFolderId: null };
    const otherFile = { id: 'destination-file', filename: 'Destination.pdf' };
    const otherFolder = { id: 'destination-folder', name: 'Destination folder', parentFolderId: null };
    const staged = [];
    const requests = [];
    let navigate;
    let deletion;
    const window = Object.assign(surface(), {
        location: { search: '?folder=origin', href: 'https://nest.example/files?folder=origin' },
        APStudyToast: { show() {} },
        APStudyBreadcrumb: { renderBreadcrumb(_root, _items, options) { navigate = options.onNavigate; } },
        APStudyHttp: { fetchJson(url, options) {
            requests.push({ url, options });
            if (options.method === 'DELETE') { deletion = deferred(); return deletion.promise; }
            const destination = url.includes('folderId=destination');
            return Promise.resolve({ currentFolder: { id: destination ? 'destination' : 'origin', name: destination ? 'Destination' : 'Origin' },
                files: [destination ? otherFile : file], folders: [destination ? otherFolder : folder], allFolders: destination ? [otherFolder] : [folder, otherFolder] });
        } },
    });
    if (undo) window.APStudyUndo = { stage(options) { staged.push(options); } };
    loadFilesModule('files/index.js', { document, window, URL, URLSearchParams, console, requestAnimationFrame: callback => callback() });
    document.emit('DOMContentLoaded'); await settle();
    function menu(type, id, actionIndex) {
        const button = els[type === 'file' ? 'files' : 'folders'].querySelectorAll(`[data-${type}-menu]`).find(node => node.dataset[`${type}Menu`] === id);
        assert.ok(button); button.emit('click');
        document.body.children.at(-1).querySelectorAll('[data-menu-index]')[actionIndex].emit('click');
    }
    async function remove(type) {
        if (type === 'bulk') {
            for (const [root, selector] of [['files', '[data-select-file]'], ['folders', '[data-select-folder]']]) {
                const checkbox = els[root].querySelector(selector); checkbox.checked = true; checkbox.emit('change');
            }
            els['bulk-delete'].emit('click'); els['confirm-input'].value = 'DELETE';
        } else { menu(type, type === 'file' ? file.id : folder.id, 4); els['confirm-input'].value = folder.name; }
        els['confirm-form'].emit('submit'); await settle();
    }
    return { els, staged, requests, remove, menu, navigate: async id => { navigate(id); await settle(); }, get deletion() { return deletion; } };
}
for (const type of ['file', 'folder', 'bulk']) {
    for (const reason of ['action', 'commit-error']) {
        test(`Files ${type} ${reason} restore after navigation preserves the destination`, async () => {
            const h = await manager(); await h.remove(type); await h.navigate('destination');
            await h.staged[0].restore({ reason });
            assert.match(h.els.files.innerHTML, /Destination\.pdf/); assert.doesNotMatch(h.els.files.innerHTML, /Origin\.pdf/);
            assert.match(h.els.folders.innerHTML, /Destination folder/); assert.doesNotMatch(h.els.folders.innerHTML, /Origin folder/);
            if (type !== 'file' && reason === 'action') {
                h.menu('file', 'destination-file', 3);
                assert.match(h.els['move-destination'].innerHTML, /Origin folder/, 'global folder projection is restored');
            }
            await h.navigate('origin'); assert.match(h.els.files.innerHTML, /Origin\.pdf/); assert.match(h.els.folders.innerHTML, /Origin folder/);
        });
    }
    test(`Files ${type} undo in its origin restores once`, async () => {
        const h = await manager(); await h.remove(type); await h.staged[0].restore({ reason: 'action' }); await h.staged[0].restore({ reason: 'action' });
        assert.equal((h.els.files.innerHTML.match(/data-file-id="origin-file"/g) || []).length, 1);
        assert.equal((h.els.folders.innerHTML.match(/data-folder-id="origin-folder"/g) || []).length, 1);
    });
}
for (const type of ['file', 'folder']) {
    test(`Files immediate ${type} delete failure after navigation preserves the destination`, async () => {
        const h = await manager({ undo: false }); await h.remove(type); await h.navigate('destination');
        h.deletion.reject(new Error('Delete rejected')); await settle();
        assert.doesNotMatch(h.els.files.innerHTML, /Origin\.pdf/); assert.doesNotMatch(h.els.folders.innerHTML, /Origin folder/);
        if (type === 'folder') { h.menu('file', 'destination-file', 3); assert.match(h.els['move-destination'].innerHTML, /Origin folder/); }
    });
}

test('upload removal undo restores its captured queue and dismisses obsolete actions on replacement', () => {
    const staged = [];
    let dismissals = 0;
    const window = { APStudyUndo: { stage(options) { staged.push(options); return { dismiss() { dismissals += 1; options.onCommit(); } }; } } };
    const { createUploadWorkflow } = loadFilesModule('files/upload-workflow.js', { window });
    const state = { currentFolderId: 'origin', uploadItems: [] };
    const removers = new Map();
    const selectedList = { innerHTML: '', querySelectorAll() { return state.uploadItems.map(item => ({ dataset: { uploadId: item.id }, querySelector(selector) {
        if (selector !== '[data-upload-remove]') return null;
        return { addEventListener(_type, handler) { removers.set(item.id, handler); } };
    } })); } };
    const workflow = createUploadWorkflow({ state, els: { selectedList },
        limits: { maxUploadFiles: 5 }, folders: { normalizeFolderId: value => value, getFolderName() {} },
        view: { clearFormError() {}, setButtonBusy() {}, modalController: { open() {} }, uploadItemHtml: item => item.name },
    });
    workflow.openUploadModal('origin', [{ name: 'first.pdf' }, { name: 'second.pdf' }]);
    const first = state.uploadItems[0]; removers.get(first.id)(); staged[0].restore();
    assert.equal(state.uploadItems[0], first);
    staged[0].onUndo();
    const second = state.uploadItems[1]; removers.get(second.id)();
    workflow.openUploadModal('origin', [{ name: 'new.pdf' }]); staged[1].restore();
    assert.deepEqual(Array.from(state.uploadItems, item => item.name), ['new.pdf']); assert.equal(dismissals, 1);
    removers.get(state.uploadItems[0].id)(); workflow.openUploadModal('destination', [{ name: 'destination.pdf' }]); staged[2].restore();
    assert.deepEqual(Array.from(state.uploadItems, item => item.name), ['destination.pdf']); assert.equal(dismissals, 2);
});
