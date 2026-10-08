import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadFilesModule } from './helpers/files-modules.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function surface() {
    const listeners = new Map();
    return {
        hidden: true, textContent: '', innerHTML: '', value: '', style: { setProperty() {} }, dataset: {}, attributes: {}, children: [],
        append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
        prepend(node) { this.children.unshift(node); }, remove() { this.removed = true; }, contains() { return false; },
        getBoundingClientRect() { return { top: 10, right: 100, bottom: 30, width: 80, height: 100 }; },
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
        dispatch(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
        setAttribute(key, value) { this.attributes[key] = value; },
        removeAttribute(key) { delete this.attributes[key]; }, toggleAttribute(key, value) { this.attributes[key] = value; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        closest() { return null; }, focus() { this.focused = true; },
    };
}
function page() {
    const elements = new Map();
    const ids = ['folder-title', 'folder-meta', 'loading', 'empty', 'files', 'files-section', 'folders', 'folders-section',
        'new-button', 'new-menu', 'folder-modal', 'folder-name', 'folder-save', 'folder-form', 'folder-error',
        'upload-modal', 'upload-target', 'selected-list', 'dropzone', 'confirm-modal', 'confirm-input', 'confirm-submit', 'confirm-form'];
    for (const id of ids) elements.set(`file-share-${id}`, surface());
    const newFolder = surface();
    const fileUpload = surface();
    const document = Object.assign(surface(), {
        body: surface(), activeElement: surface(),
        getElementById: id => elements.get(id) || null,
        querySelector(selector) {
            if (selector === '[data-new-folder]') return newFolder;
            if (selector === '[data-file-upload]') return fileUpload;
            return null;
        },
    });
    const requests = [];
    const alerts = [];
    const window = Object.assign(surface(), {
        location: { search: '?folder=folder-1', href: 'https://nest.example/files?folder=folder-1' },
        APStudyToast: { show: alert => alerts.push(alert) },
        APStudyHttp: { async fetchJson(url, options) {
            requests.push([url, options]);
            if (options.method === 'POST') return { id: 'created-folder', name: 'Biology' };
            return {
                currentFolder: { id: 'folder-1', name: 'School' },
                folders: [{ id: 'nested', name: '<Projects>', fileCount: 1 }],
                files: [{ id: 'one', filename: '<Notes>.pdf', fileSizeBytes: 12 }],
            };
        } },
    });
    return { context: { document, window, URLSearchParams, URL, console, requestAnimationFrame: callback => callback() }, elements,
        newFolder, fileUpload, requests, alerts, document, window };
}

test('single Files entry loads its sibling graph and binds folder and upload actions without feature registries', async () => {
    const h = page();
    loadFilesModule('files/index.js', h.context);
    h.document.dispatch('DOMContentLoaded');
    await settle();
    assert.equal(h.requests[0][0], '/api/files/my?folderId=folder-1');
    assert.equal(h.elements.get('file-share-folder-title').textContent, 'School');
    assert.equal(h.elements.get('file-share-folder-meta').textContent, '1 folder / 1 file');
    assert.match(h.elements.get('file-share-files').innerHTML, /&lt;Notes&gt;\.pdf/);
    assert.match(h.elements.get('file-share-folders').innerHTML, /&lt;Projects&gt;/);
    assert.equal(h.elements.get('file-share-loading').hidden, true);
    assert.equal(h.elements.get('file-share-empty').hidden, true);
    h.newFolder.dispatch('click');
    assert.equal(h.elements.get('file-share-folder-modal').hidden, false);
    h.elements.get('file-share-folder-name').value = ' Biology ';
    h.elements.get('file-share-folder-form').dispatch('submit', { preventDefault() {} });
    await settle();
    assert.equal(h.requests[1][0], '/api/files/folders');
    assert.deepEqual(JSON.parse(h.requests[1][1].body), { name: 'Biology', parentFolderId: 'folder-1' });
    assert.equal(h.elements.get('file-share-folder-modal').hidden, true);
    assert.equal(h.elements.get('file-share-folder-save').disabled, false);
    assert.equal(h.alerts[0].message, 'Folder created.');
    h.fileUpload.dispatch('click');
    assert.equal(h.elements.get('file-share-upload-modal').hidden, false);
    assert.equal(h.elements.get('file-share-upload-target').textContent, 'School');
    for (const name of ['APStudyFilesUtils', 'APStudyFilesRenderers', 'APStudyFilesModals', 'APStudyFilesEvents', 'APStudyFilesWorkflows']) {
        assert.equal(h.window[name], undefined);
        assert.equal(h.context[name], undefined);
    }
    assert.equal(h.context.APStudyCoreServices.uiPrimitives, undefined);
});

test('public Files modal confirmation validates text and retains an errored action for retry', async () => {
    const h = page();
    const { createFilesModals } = loadFilesModule('files/modals.js', h.context);
    const state = {};
    const notices = [];
    const modals = createFilesModals({ state,
        els: { confirmModal: h.elements.get('file-share-confirm-modal'), confirmInput: h.elements.get('file-share-confirm-input'), confirmSubmit: h.elements.get('file-share-confirm-submit') },
        callbacks: { clearFormError() {}, setButtonBusy(button, busy) { button.disabled = busy; }, notify: message => notices.push(message) },
    });
    let attempts = 0;
    modals.openConfirm({ requiredText: 'DELETE', async onConfirm() { attempts += 1; if (attempts === 1) throw new Error('Delete refused'); } });
    await modals.runConfirmAction();
    assert.equal(attempts, 0);
    assert.deepEqual(notices, ['Confirmation text does not match.']);
    h.elements.get('file-share-confirm-input').value = 'DELETE';
    await modals.runConfirmAction();
    assert.equal(h.elements.get('file-share-confirm-modal').hidden, false);
    assert.equal(h.elements.get('file-share-confirm-submit').disabled, false);
    assert.equal(notices[1], 'Delete refused');
    await modals.runConfirmAction();
    assert.equal(attempts, 2);
    assert.equal(h.elements.get('file-share-confirm-modal').hidden, true);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function sharingPage() {
    const h = page();
    const utils = loadFilesModule('files/utils.js', h.context);
    const { shareExpiryOptionsHtml } = loadFilesModule('files/renderers.js', h.context);
    const { createSharingWorkflow } = loadFilesModule('files/sharing-workflow.js', h.context);
    const { createFilesModals } = loadFilesModule('files/modals.js', h.context);
    const { bindFilesEvents } = loadFilesModule('files/events.js', h.context);
    const els = Object.fromEntries(['shareModal', 'shareTitle', 'shareSubtitle', 'shareName', 'shareStatus',
        'shareVisibility', 'shareExpiryField', 'folderShareNote', 'shareExpiry', 'shareLinkWrap', 'shareLink',
        'copyShareButton', 'shareError'].map(name => [name, surface()]));
    const state = {
        files: [{ id: 'a/1', filename: 'A.pdf', isPublic: false }, { id: 'b', filename: 'B.pdf', isPublic: true, shareUrl: '/share/b' }],
        folders: [{ id: 'a/1', name: 'A', isPublic: false }, { id: 'b', name: 'B', isPublic: true, shareUrl: '/share/b' }],
        allFolders: [{ id: 'a/1', name: 'A', isPublic: false }, { id: 'b', name: 'B', isPublic: true, shareUrl: '/share/b' }],
    };
    const requests = [];
    const notices = [];
    const alerts = [];
    let renders = 0;
    const modals = createFilesModals({ state, els, callbacks: utils });
    const sharing = createSharingWorkflow({ state, els,
        apiJson(url, options) {
            const pending = deferred();
            requests.push({ url, options, ...pending });
            return pending.promise;
        },
        expiry: { ...utils, allowedExpiry: [1, 7, 30], defaultExpiry: 1, shareExpiryOptionsHtml },
        manager: { renderManager() { renders += 1; } },
        view: { ...utils, modalController: { open: modals.openModal },
            notify(message, _type, options) { notices.push(message); utils.showFormError(options.modalError, message); },
            showAlert(message) { alerts.push(message); },
        },
        links: { async copyText() {} },
    });
    h.document.querySelectorAll = selector => selector === '.files-modal' ? [els.shareModal] : [];
    bindFilesEvents({ state, els, actions: { ...sharing, closeModal: modals.closeModal }, callbacks: {} });
    return { ...h, state, els, sharing, requests, notices, alerts, renders: () => renders };
}

for (const [type, action] of [['file', 'visibility'], ['file', 'expiry'], ['folder', 'visibility']]) {
    for (const replacement of ['other-item', 'same-item', 'dismiss', 'hide']) {
        for (const outcome of ['success', 'failure']) {
            test(`Files ${type} ${action}: late ${outcome} after ${replacement} belongs to the original session`, async () => {
                const h = sharingPage();
                const items = type === 'file' ? h.state.files : h.state.folders;
                const original = items[0];
                h.sharing.openShareModal(type, original);
                const originalSession = h.state.shareContext;
                const control = action === 'expiry' ? h.els.shareExpiry : h.els.shareVisibility;
                const change = () => {
                    if (action === 'expiry') control.value = '30';
                    else control.checked = true;
                    control.dispatch('change');
                };
                change();
                assert.equal(h.requests.length, 1);
                assert.equal(control.disabled, true);
                assert.equal(h.requests[0].url, type === 'folder' ? '/api/files/folders/a%2F1/visibility'
                    : action === 'expiry' ? '/api/files/my/a%2F1' : '/api/files/my/a%2F1/visibility');
                assert.deepEqual(JSON.parse(h.requests[0].options.body), action === 'expiry' ? { expiryDays: '30' } : { visibility: 'public' });

                if (replacement === 'dismiss') {
                    h.document.dispatch('keydown', { key: 'Escape' });
                    assert.equal(h.state.shareContext, null);
                    assert.equal(h.els.shareModal.hidden, true);
                } else if (replacement === 'hide') {
                    h.els.shareModal.hidden = true;
                } else {
                    const nextItem = replacement === 'same-item' ? original : items[1];
                    h.sharing.openShareModal(type, nextItem);
                    assert.notEqual(h.state.shareContext, originalSession);
                    assert.equal(h.els.shareVisibility.disabled, false);
                    assert.equal(h.els.shareExpiry.disabled, false);
                    assert.equal(h.els.copyShareButton.disabled, !nextItem.shareUrl);
                    change();
                    assert.equal(h.requests.length, 2);
                }
                const nextSession = h.state.shareContext;
                const modalName = h.els.shareName.textContent;
                const modalStatus = h.els.shareStatus.textContent;
                const modalLink = h.els.shareLink.value;
                const updated = { id: original.id, isPublic: true, shareUrl: '/share/a',
                    expiresAt: '2099-01-01T00:00:00Z', ...(type === 'file' ? { filename: 'Saved A.pdf' } : { name: 'Saved A' }) };
                if (outcome === 'success') h.requests[0].resolve(updated);
                else h.requests[0].reject(new Error('A request failed'));
                await settle();

                const projected = (type === 'file' ? h.state.files : h.state.folders)[0];
                assert.equal(projected.isPublic, outcome === 'success');
                if (type === 'folder') assert.equal(h.state.allFolders[0].isPublic, outcome === 'success');
                assert.equal(h.renders(), outcome === 'success' ? 1 : 0);
                assert.equal(h.state.shareContext, nextSession);
                if (nextSession) assert.equal(nextSession.item, replacement === 'other-item' ? items[1] : original);
                assert.equal(h.els.shareName.textContent, modalName);
                assert.equal(h.els.shareStatus.textContent, modalStatus);
                assert.equal(h.els.shareLink.value, modalLink);
                assert.equal(control.disabled, true);
                assert.equal(h.els.shareError.hidden, true);
                assert.deepEqual(h.notices, []);
                assert.deepEqual(h.alerts, []);

                if (nextSession && nextSession !== originalSession) {
                    const savedNext = { ...nextSession.item, isPublic: true, shareUrl: '/share/next' };
                    h.requests[1].resolve(savedNext);
                    await settle();
                    assert.equal(control.disabled, false);
                    assert.equal(h.els.shareLink.value, '/share/next');
                    assert.deepEqual(h.alerts, [action === 'expiry' ? 'Expiration updated.' : 'Public link enabled.']);
                } else {
                    h.sharing.openShareModal(type, projected);
                    assert.equal(control.disabled, false);
                    assert.equal(h.els.shareVisibility.checked, outcome === 'success');
                    assert.equal(h.els.shareLink.value, outcome === 'success' ? '/share/a' : '');
                }
            });
        }
    }
}

for (const [type, olderAction, newerAction] of [
    ['file', 'visibility', 'visibility'], ['file', 'expiry', 'expiry'],
    ['file', 'visibility', 'expiry'], ['file', 'expiry', 'visibility'], ['folder', 'visibility', 'visibility'],
]) {
    for (const newerOutcome of ['success', 'failure']) {
        for (const reopenAfterNewer of [false, true]) {
            test(`Files ${type} reverse ${olderAction}/${newerAction} completion preserves newer ${newerOutcome}, reopen=${reopenAfterNewer}`, async () => {
                const h = sharingPage();
                const collection = () => type === 'file' ? h.state.files : h.state.folders;
                const start = (action, newer) => {
                    const control = action === 'expiry' ? h.els.shareExpiry : h.els.shareVisibility;
                    if (action === 'expiry') control.value = newer ? '1' : '30';
                    else control.checked = !newer;
                    control.dispatch('change');
                };
                const payload = newer => ({ id: 'a/1', isPublic: !newer, shareUrl: newer ? '' : '/share/older',
                    expiresAt: newer ? '2099-01-01T00:00:00Z' : '2099-12-31T00:00:00Z',
                    ...(type === 'file' ? { filename: newer ? 'Newer.pdf' : 'Older.pdf' } : { name: newer ? 'Newer' : 'Older' }),
                });
                h.sharing.openShareModal(type, collection()[0]);
                start(olderAction, false);
                h.document.dispatch('keydown', { key: 'Escape' });
                h.sharing.openShareModal(type, collection()[0]);
                start(newerAction, true);
                assert.equal(h.requests.length, 2);
                if (newerOutcome === 'success') h.requests[1].resolve(payload(true));
                else h.requests[1].reject(new Error('Newer save refused'));
                await settle();
                assert.equal(h.els.shareVisibility.disabled, false);
                if (reopenAfterNewer) {
                    h.document.dispatch('keydown', { key: 'Escape' });
                    h.sharing.openShareModal(type, collection()[0]);
                }
                const currentSession = h.state.shareContext;
                const currentItem = currentSession.item;
                const currentStatus = h.els.shareStatus.textContent;
                const currentName = h.els.shareName.textContent;
                const currentExpiry = h.els.shareExpiry.innerHTML;
                const currentError = h.els.shareError.textContent;
                const notices = [...h.notices];
                const alerts = [...h.alerts];
                h.requests[0].resolve(payload(false));
                await settle();
                const expected = payload(newerOutcome === 'success');
                assert.deepEqual({ ...collection()[0] }, expected);
                if (type === 'folder') assert.deepEqual({ ...h.state.allFolders[0] }, expected);
                assert.equal(h.renders(), 1);
                assert.equal(h.state.shareContext, currentSession);
                assert.equal(h.state.shareContext.item, currentItem);
                assert.equal(h.els.shareStatus.textContent, currentStatus);
                assert.equal(h.els.shareName.textContent, currentName);
                assert.equal(h.els.shareExpiry.innerHTML, currentExpiry);
                assert.equal(h.els.shareError.textContent, currentError);
                assert.equal(h.els.shareVisibility.disabled, false);
                assert.deepEqual(h.notices, notices);
                assert.deepEqual(h.alerts, alerts);
                h.document.dispatch('keydown', { key: 'Escape' });
                h.sharing.openShareModal(type, collection()[0]);
                assert.equal(h.els.shareVisibility.checked, expected.isPublic);
                assert.equal(h.els.shareLink.value, expected.shareUrl);
                assert.equal(h.state.shareContext.item.expiresAt, expected.expiresAt);
            });
        }
    }
}

test('Files acknowledged folder response does not supersede an older file response with the same ID', async () => {
    const h = sharingPage();
    h.sharing.openShareModal('file', h.state.files[0]);
    h.els.shareVisibility.checked = true;
    h.els.shareVisibility.dispatch('change');
    h.sharing.openShareModal('folder', h.state.folders[0]);
    h.els.shareVisibility.checked = true;
    h.els.shareVisibility.dispatch('change');
    h.requests[1].resolve({ id: 'a/1', isPublic: true, shareUrl: '/share/folder' });
    await settle();
    h.requests[0].resolve({ id: 'a/1', isPublic: true, shareUrl: '/share/file' });
    await settle();
    assert.equal(h.state.files[0].shareUrl, '/share/file');
    assert.equal(h.state.folders[0].shareUrl, '/share/folder');
    assert.equal(h.state.allFolders[0].shareUrl, '/share/folder');
    assert.equal(h.els.shareLink.value, '/share/folder');
    assert.equal(h.renders(), 2);
});

for (const type of ['file', 'folder']) {
    test(`Files newer acknowledged ${type} B leaves an older ${type} A projection independent`, async () => {
        const h = sharingPage();
        const collection = () => type === 'file' ? h.state.files : h.state.folders;
        h.sharing.openShareModal(type, collection()[0]);
        h.els.shareVisibility.checked = true;
        h.els.shareVisibility.dispatch('change');
        h.sharing.openShareModal(type, collection()[1]);
        h.els.shareVisibility.checked = false;
        h.els.shareVisibility.dispatch('change');
        h.requests[1].resolve({ id: 'b', isPublic: false, shareUrl: '' });
        await settle();
        h.requests[0].resolve({ id: 'a/1', isPublic: true, shareUrl: '/share/a' });
        await settle();
        assert.equal(collection()[0].isPublic, true);
        assert.equal(collection()[1].isPublic, false);
        if (type === 'folder') {
            assert.equal(h.state.allFolders[0].isPublic, true);
            assert.equal(h.state.allFolders[1].isPublic, false);
        }
        assert.equal(h.els.shareVisibility.checked, false);
        assert.equal(h.els.shareLink.value, '');
        assert.equal(h.renders(), 2);
    });
}

test('Files current sharing failure restores saved controls, reports error and permits retry through installed handlers', async () => {
    const h = sharingPage();
    h.sharing.openShareModal('file', h.state.files[0]);
    h.els.shareVisibility.checked = true;
    h.els.shareVisibility.dispatch('change');
    h.requests[0].reject(new Error('Sharing refused'));
    await settle();
    assert.equal(h.els.shareVisibility.checked, false);
    assert.equal(h.els.shareVisibility.disabled, false);
    assert.equal(h.els.shareError.textContent, 'Sharing refused');
    assert.equal(h.els.shareError.hidden, false);
    assert.equal(h.renders(), 0);
    assert.deepEqual(h.notices, ['Sharing refused']);
    h.els.shareVisibility.checked = true;
    h.els.shareVisibility.dispatch('change');
    assert.equal(h.els.shareError.hidden, true);
    h.requests[1].resolve({ id: 'a/1', isPublic: true, shareUrl: '/share/a' });
    await settle();
    assert.equal(h.els.shareVisibility.checked, true);
    assert.equal(h.els.shareVisibility.disabled, false);
    assert.equal(h.els.copyShareButton.disabled, false);
    assert.equal(h.els.shareLink.value, '/share/a');
    assert.deepEqual(h.alerts, ['Public link enabled.']);
});

function sharedHttp(h) {
    h.document.documentElement = surface();
    h.window.dispatchEvent = () => {};
    h.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
    h.context.Error = Error;
    for (const name of ['http', 'pending-mutations']) {
        vm.runInContext(fs.readFileSync(`static/js/core/${name}.js`, 'utf8'), h.context);
    }
    const pending = h.window.APStudyCoreServices.pendingMutations.createPendingMutations(h);
    h.window.APStudyHttp = h.window.APStudyCoreServices.http.createHttpService({ window: h.window, pendingMutations: pending });
    return pending;
}
function response(contentType, decode) {
    return { ok: true, status: 200, headers: { get: () => contentType }, json: decode };
}

test('Files required JSON cannot be overridden; folder create and rename retain drafts through failed decode and retry', async () => {
    for (const mode of ['folder-create', 'folder-rename', 'file-rename']) {
        for (const contentType of ['text/html', 'application/json']) {
            const h = page();
            const utils = loadFilesModule('files/utils.js', h.context);
            const { createFilesModals } = loadFilesModule('files/modals.js', h.context);
            const pending = sharedHttp(h);
            const decoding = deferred();
            const requests = [];
            const cause = new SyntaxError('Unexpected login HTML or malformed JSON');
            h.window.fetch = async (url, options) => {
                requests.push([url, options]);
                return response(contentType, () => decoding.promise);
            };
            const state = { currentFolderId: 'folder-1' };
            const notifications = [];
            const alerts = [];
            let refreshes = 0;
            const els = {
                folderModal: h.elements.get('file-share-folder-modal'), folderName: h.elements.get('file-share-folder-name'),
                folderSave: h.elements.get('file-share-folder-save'), folderError: h.elements.get('file-share-folder-error'),
            };
            const modals = createFilesModals({ state, els, callbacks: { ...utils,
                // Caller preferences cannot relax the feature's wire contract.
                apiJson: (url, options) => utils.apiJson(url, { ...options, jsonMode: 'optional' }),
                loadFolder: async () => { refreshes += 1; }, showAlert: message => alerts.push(message),
                notify: message => notifications.push(message),
            } });
            modals.openFolderModal(mode, { id: 'file/1', filename: 'Original.pdf' });
            els.folderName.value = ' Draft filename ';
            const saving = modals.saveFolderModal();
            await settle();
            assert.equal(pending.count(), 1);
            assert.equal(els.folderSave.disabled, true);
            assert.equal(els.folderModal.hidden, false);
            assert.equal(refreshes, 0);
            decoding.reject(cause);
            await saving;
            assert.equal(pending.count(), 0);
            assert.equal(els.folderSave.disabled, false);
            assert.equal(els.folderModal.hidden, false);
            assert.equal(els.folderName.value, ' Draft filename ');
            assert.equal(state.folderModalMode.mode, mode);
            assert.equal(refreshes, 0);
            assert.deepEqual(alerts, []);
            assert.deepEqual(notifications, ['Invalid JSON response.']);
            h.window.fetch = async (url, options) => {
                requests.push([url, options]);
                return response('application/json', async () => ({ id: 'saved', filename: 'Draft filename' }));
            };
            await modals.saveFolderModal();
            assert.equal(els.folderModal.hidden, true);
            assert.equal(refreshes, 1);
            assert.equal(pending.count(), 0);
            assert.equal(requests[1][0], requests[0][0]);
            assert.equal(requests[1][1].body, requests[0][1].body);
            assert.deepEqual(alerts, [mode === 'folder-create' ? 'Folder created.' : mode === 'folder-rename' ? 'Folder renamed.' : 'File renamed.']);
        }
    }
});

test('Files required JSON preserves HTTP decode cause and pending ownership at the actual wrapper', async () => {
    const h = page();
    const { apiJson } = loadFilesModule('files/utils.js', h.context);
    const pending = sharedHttp(h);
    const decoding = deferred();
    const cause = new SyntaxError('Unexpected HTML');
    h.window.fetch = async () => response('text/html', () => decoding.promise);
    const saving = apiJson('/api/files/folders', { method: 'POST', body: '{}', jsonMode: 'content-type' });
    await settle();
    assert.equal(pending.hasPending(), true);
    decoding.reject(cause);
    await assert.rejects(saving, error => error.status === 200 && error.cause === cause && error.message === 'Invalid JSON response.');
    assert.equal(pending.hasPending(), false);
});

test('actual Files delete controls restore a failed Undo commit after HTML decoding and allow retry', async () => {
    for (const contentType of ['text/html', 'application/json']) {
        const h = page();
        const nodes = [];
        let menuButtons = [];
        const fileMenu = surface();
        fileMenu.dataset.fileMenu = 'one';
        h.elements.get('file-share-files').querySelectorAll = selector => selector === '[data-file-menu]' ? [fileMenu] : [];
        h.document.createElement = () => {
            const node = surface();
            node.querySelectorAll = selector => {
                if (selector !== '[data-menu-index]') return [];
                menuButtons = Array.from({ length: 5 }, (_, index) => Object.assign(surface(), { dataset: { menuIndex: String(index) } }));
                return menuButtons;
            };
            nodes.push(node);
            return node;
        };
        h.document.createElementNS = () => h.document.createElement();
        const getElementById = h.document.getElementById;
        h.document.getElementById = id => getElementById(id) || nodes.find(node => node.id === id);
        h.window.innerHeight = 800;
        h.window.innerWidth = 1200;
        h.window.setTimeout = () => 1;
        h.window.clearTimeout = () => {};
        h.context.performance = { now: () => 0 };
        loadFilesModule('files/index.js', h.context);
        const pending = sharedHttp(h);
        vm.runInContext(fs.readFileSync('static/js/core/ui-primitives.js', 'utf8'), h.context);
        const stage = h.window.APStudyUndo.stage;
        let controller;
        h.window.APStudyUndo.stage = options => { controller = stage(options); return controller; };
        const errors = [];
        h.window.APStudyToast.error = message => errors.push(message);
        const decoding = deferred();
        let deletes = 0;
        let retry = false;
        h.window.fetch = async (_url, options) => {
            if (options.method === 'DELETE') {
                deletes += 1;
                return response(contentType, () => retry ? Promise.resolve({ deleted: true }) : decoding.promise);
            }
            return response('application/json', async () => ({ files: [{ id: 'one', filename: '<Notes>.pdf', fileSizeBytes: 12 }] }));
        };
        h.document.dispatch('DOMContentLoaded');
        await settle();
        const deleteViaControls = async () => {
            fileMenu.dispatch('click', { stopPropagation() {} });
            menuButtons[4].dispatch('click');
            h.elements.get('file-share-confirm-form').dispatch('submit', { preventDefault() {} });
            await settle();
        };
        await deleteViaControls();
        assert.equal(h.elements.get('file-share-files').innerHTML, '');
        assert.equal(h.window.APStudyUndo.pendingCount(), 1);
        const committing = controller.commit();
        await settle();
        assert.equal(pending.count(), 1);
        assert.equal(h.elements.get('file-share-files').innerHTML, '');
        decoding.reject(new SyntaxError('Login HTML or malformed deletion response'));
        const failed = await committing;
        assert.equal(failed.ok, false);
        assert.equal(failed.error.status, 200);
        assert.equal(pending.count(), 0);
        assert.match(h.elements.get('file-share-files').innerHTML, /&lt;Notes&gt;\.pdf/);
        assert.deepEqual(errors, ['Invalid JSON response.']);
        retry = true;
        await deleteViaControls();
        const succeeded = await controller.commit();
        assert.equal(succeeded.ok, true);
        assert.equal(deletes, 2);
        assert.equal(pending.count(), 0);
        assert.equal(h.elements.get('file-share-files').innerHTML, '');
    }
});

test('Files required JSON retains shared HEAD and 204/205 bodyless semantics', async () => {
    const h = page();
    const { apiJson } = loadFilesModule('files/utils.js', h.context);
    const pending = sharedHttp(h);
    let decodes = 0;
    for (const [method, status] of [['HEAD', 200], ['DELETE', 204], ['POST', 205]]) {
        h.window.fetch = async () => ({ ...response('text/html', async () => { decodes += 1; throw new Error('Must not decode an empty body'); }), status });
        assert.equal(Object.keys(await apiJson('/api/files/my/one', { method })).length, 0);
        assert.equal(pending.count(), 0);
    }
    assert.equal(decodes, 0);
});
