import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadFilesModule } from './helpers/files-modules.mjs';

// Run feature handlers with the actual shared transport and controlled XHR events.
const source = path => fs.readFileSync(`static/js/${path}`, 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function surface() {
    const listeners = new Map();
    return {
        innerHTML: '', hidden: false, value: '', dataset: {},
        classList: { add() {}, remove() {} }, setAttribute() {},
        addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
        removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
        dispatch(type, event = {}) { for (const handler of listeners.get(type) || []) handler(event); },
        dispatchEvent(event) { this.dispatch(event.type, event); },
    };
}
function harness() {
    const requests = [];
    const elements = new Map(['chat-pending-files', 'chat-upload-list', 'chat-file-input', 'chat-attach-button', 'chat-composer', 'chat-message-input'].map(id => [id, surface()]));
    const document = { getElementById: id => elements.get(id) || null };
    const window = { ...surface(), location: { href: 'https://nest.example/chat', origin: 'https://nest.example' } };
    let token = 'stale';
    let refreshes = 0;
    let pending = 0;
    const labels = [];
    const undo = [];
    window.APStudyUndo = { stage: action => undo.push(action) };
    class Xhr {
        constructor() { this.status = 0; this.upload = {}; this.headers = {}; requests.push(this); }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(key, value) { this.headers[key] = value; }
        getResponseHeader(key) { return this.responseHeaders?.[key] || null; }
        send(body) { this.body = body; }
        abort() { this.aborted = true; this.onabort?.(); }
        respond(status, payload, headers = {}) { this.status = status; this.response = payload; this.responseHeaders = headers; this.onload(); }
        progress(loaded, total) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
        fail() { this.onerror(); }
    }
    class FormData { constructor() { this.entries = []; } append(...args) { this.entries.push(args); } }
    const context = vm.createContext({ window, document, URL, Error, AbortController, XMLHttpRequest: Xhr, FormData,
        crypto: { randomUUID: () => `local-${requests.length}` }, navigator: { onLine: true },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        escapeHtml: value => String(value ?? ''),
    });
    vm.runInContext(source('core/http.js'), context);
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window,
        csrf: { token: () => token, isFailure: (status, getHeader) => status === 400 && getHeader('X-APStudy-CSRF-Error') === '1', refresh: async () => { token = 'fresh'; refreshes += 1; } },
        pendingMutations: { track(promise, label) { labels.push(label); pending += 1; return promise.finally(() => { pending -= 1; }); } },
    });
    const load = (path, exports) => vm.runInContext(`(() => { ${source(path).replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '').replace(/export\s+(?=(?:async\s+)?function\b)/g, '')}\nreturn { ${exports} }; })()`, context);
    const chooseChat = file => {
        elements.get('chat-file-input').files = [file];
        elements.get('chat-file-input').dispatch('change');
    };
    const clickChat = (action, id = 'local-0') => elements.get('chat-upload-list').dispatch('click', { target: { closest: selector => selector === `[data-upload-${action}]` ? { dataset: { [action === 'remove' ? 'uploadRemove' : 'uploadRetry']: id } } : null } });
    return { window, elements, context, requests, labels, undo, load, chooseChat, clickChat, pending: () => pending, refreshes: () => refreshes };
}
function chat(h) {
    const { createAttachmentManager } = h.load('chat/attachments.js', 'createAttachmentManager');
    const manager = createAttachmentManager();
    manager.init({ state: { activeRoom: { type: 'course', id: 'course-1' } } });
    manager.configure({ attachments: true });
    return manager;
}
function notes(h) {
    const images = new Map([['image-1', { status: 'uploading' }]]);
    const changes = [];
    Object.assign(h.context, {
        NOTE_IMAGE_ACCEPT: 'image/*', noteImageError: () => '', droppedImageFiles: () => [],
        updateInlineImage(_editor, id, patch) { changes.push(patch); if (images.has(id)) Object.assign(images.get(id), patch); },
        removeInlineImage(_editor, id) { const image = images.get(id); images.delete(id); return image; },
        restoreInlineImage(_editor, image) { images.set('image-1', image); return true; },
    });
    const runtime = h.load('notes/editor/image-runtime.js', 'uploadInlineImage, bindImageRuntime');
    const editor = {};
    let saves = 0;
    const options = { editor, noteId: 'note/1', onChange: () => { saves += 1; } };
    const teardown = runtime.bindImageRuntime({ ...options, editorPage: surface() });
    return { ...runtime, images, changes, options, teardown, saves: () => saves };
}

test('chat attachment uses shared auth retry, multipart scope, progress and ready IDs', async () => {
    const h = harness();
    const manager = chat(h);
    const file = { name: 'photo.png', size: 2048 };
    h.chooseChat(file);
    await settle();
    assert.equal(h.pending(), 1);
    assert.equal(h.labels[0], 'chat-attachment-upload');
    assert.equal(h.requests[0].headers['X-CSRFToken'], 'stale');
    assert.equal(h.requests[0].body.entries.find(([name]) => name === 'scope_id')[1], 'course-1');
    h.requests[0].progress(1, 2);
    assert.match(h.elements.get('chat-upload-list').innerHTML, /Uploading 50%/);
    h.requests[0].respond(400, {}, { 'X-APStudy-CSRF-Error': '1' });
    await settle();
    assert.equal(h.pending(), 1);
    assert.equal(h.refreshes(), 1);
    assert.equal(h.requests[1].headers['X-CSRFToken'], 'fresh');
    h.requests[1].respond(201, { attachment: { id: 'attachment-1' } });
    await settle();
    assert.deepEqual([...manager.readyIds()], ['attachment-1']);
    assert.equal(manager.isBusy(), false);
    assert.equal(h.pending(), 0);
});

test('chat removal aborts upload and undo restarts without stale cancellation errors', async () => {
    const h = harness();
    const manager = chat(h);
    h.chooseChat({ name: 'photo.png', size: 1 });
    await settle();
    h.clickChat('remove');
    assert.equal(h.requests[0].aborted, true);
    assert.equal(manager.hasContent(), false);
    h.undo[0].restore();
    await settle();
    assert.equal(h.requests.length, 2);
    assert.doesNotMatch(h.elements.get('chat-upload-list').innerHTML, /Upload cancelled/);
    h.requests[1].respond(201, { attachment: { id: 'restored' } });
    await settle();
    assert.deepEqual([...manager.readyIds()], ['restored']);
    assert.equal(h.pending(), 0);
});

test('chat retains domain and offline upload errors and allows retry', async () => {
    const h = harness();
    const manager = chat(h);
    h.chooseChat({ name: 'photo.png', size: 1 });
    await settle();
    h.requests[0].respond(413, { error: 'Storage quota reached.' });
    await settle();
    assert.match(h.elements.get('chat-upload-list').innerHTML, /Storage quota reached/);
    h.clickChat('retry');
    await settle();
    h.context.navigator.onLine = false;
    h.requests[1].fail();
    await settle();
    assert.match(h.elements.get('chat-upload-list').innerHTML, /You are offline/);
    assert.equal(manager.isBusy(), true);
    assert.equal(h.pending(), 0);
});

test('note image shares auth retry and progress while keeping image response handling', async () => {
    const h = harness();
    const runtime = notes(h);
    const progress = [];
    h.window.addEventListener('notes-image-upload-progress', event => progress.push(event.detail.progress));
    const request = runtime.uploadInlineImage({ name: 'image.png' }, 'image-1', runtime.options);
    assert.match(h.requests[0].url, /notes\/note%2F1\/media$/);
    assert.equal(h.labels[0], 'note-image-upload');
    assert.equal(h.requests[0].headers['X-CSRFToken'], 'stale');
    h.requests[0].progress(2, 4);
    h.requests[0].respond(400, {}, { 'X-APStudy-CSRF-Error': '1' });
    await settle();
    assert.equal(h.requests[1].headers['X-CSRFToken'], 'fresh');
    h.requests[1].respond(201, { id: 'media-1', url: '/image', width: 120, name: 'Photo' });
    await request;
    assert.deepEqual(progress, [50]);
    assert.equal(runtime.images.get('image-1').mediaId, 'media-1');
    assert.equal(runtime.images.get('image-1').status, 'ready');
    assert.equal(runtime.saves(), 1);
    assert.equal(h.pending(), 0);
    runtime.teardown();
});

test('note image failure retries; removal, undo, replacement and teardown cancel pending uploads', async () => {
    const h = harness();
    const runtime = notes(h);
    let request = runtime.uploadInlineImage({ name: 'image.png' }, 'image-1', runtime.options);
    h.requests[0].respond(403, { error: 'Cannot edit this note.' });
    await request;
    assert.equal(runtime.images.get('image-1').error, 'Cannot edit this note.');
    h.window.dispatch('notes-image-retry', { detail: { clientId: 'image-1' } });
    assert.equal(h.requests.length, 2);
    h.requests[1].fail();
    await settle();
    assert.equal(runtime.images.get('image-1').error, 'Network error during upload.');
    h.window.dispatch('notes-image-retry', { detail: { clientId: 'image-1' } });
    h.window.dispatch('notes-image-remove', { detail: { clientId: 'image-1' } });
    assert.equal(h.requests[2].aborted, true);
    assert.equal(runtime.images.size, 0);
    h.undo[0].restore();
    await settle();
    assert.equal(h.requests.length, 4);
    request = runtime.uploadInlineImage({ name: 'replacement.png' }, 'image-1', runtime.options);
    assert.equal(h.requests[3].aborted, true);
    runtime.teardown();
    assert.equal(h.requests[4].aborted, true);
    await request;
    assert.equal(h.pending(), 0);
    assert.equal(runtime.changes.some(change => change.error === 'Upload cancelled.'), false);
});

function files(h, { loadFolder } = {}) {
    const { createUploadWorkflow } = loadFilesModule('files/upload-workflow.js', h.context);
    const button = {};
    const progressWrap = { hidden: true };
    const progressBar = { style: {} };
    const uploadModal = { hidden: false };
    const uploadError = { textContent: '' };
    const alerts = [];
    const notifications = [];
    const busyChanges = [];
    let refreshes = 0;
    let closed = 0;
    const file = { name: 'notes.pdf', size: 12 };
    const state = {
        currentFolderId: 'current-folder', uploadTargetFolderId: 'target-folder',
        uploadItems: [{ id: 'one', file, name: ' Renamed notes.pdf ', visibility: 'public', expiryDays: '7' }],
    };
    const upload = createUploadWorkflow({
        state,
        els: { uploadButton: button, progressWrap, progressBar, uploadModal, uploadError },
        limits: { maxFileSizeBytes: 100, maxUploadFiles: 5, defaultExpiry: 1 },
        folders: {
            normalizeFolderId: id => id,
            getFolderName: id => id,
            async loadFolder(id) { assert.equal(id, 'current-folder'); refreshes += 1; return loadFolder?.(); },
        },
        view: {
            clearFormError(target) { if (target) target.textContent = ''; },
            setButtonBusy(target, busy) { busyChanges.push(busy); target.disabled = busy; },
            modalController: {
                open(modal) { modal.hidden = false; },
                close(modal) { closed += 1; modal.hidden = true; },
            },
            showAlert(message) { alerts.push(message); },
            notify(message, _type, options = {}) {
                notifications.push(message);
                if (options.modalError) options.modalError.textContent = message;
            },
        },
    });
    return { upload, state, button, progressWrap, progressBar, uploadModal, uploadError, alerts, notifications, busyChanges, file, refreshes: () => refreshes, closed: () => closed };
}

test('Files upload submissions share one request until that queue settles', async () => {
    const h = harness();
    const runtime = files(h);
    const first = runtime.upload.uploadSelectedFiles();
    await runtime.upload.uploadSelectedFiles();
    assert.equal(h.requests.length, 1);
    assert.equal(h.pending(), 1);
    h.requests[0].respond(201, { files: [{ id: 'file-1', filename: 'notes.pdf' }] });
    await first;
    assert.equal(runtime.closed(), 1);
});

test('Files earlier upload completion preserves a reopened queue and its pending controls', async () => {
    const h = harness();
    const runtime = files(h);
    const earlier = runtime.upload.uploadSelectedFiles();
    runtime.uploadModal.hidden = true;
    const nextFile = { name: 'new.pdf', size: 20 };
    runtime.upload.openUploadModal('next-folder', [nextFile]);
    const queue = runtime.state.uploadItems;
    assert.equal(runtime.button.disabled, false);
    h.requests[0].progress(3, 4);
    assert.equal(runtime.progressWrap.hidden, true);
    const next = runtime.upload.uploadSelectedFiles();
    assert.equal(h.requests[1].body.entries.find(([name]) => name === 'folderId')[1], 'next-folder');
    assert.equal(h.requests[1].body.entries.find(([name]) => name === 'file')[1], nextFile);
    h.requests[1].progress(1, 4);
    h.requests[0].progress(3, 4);
    assert.equal(runtime.progressBar.style.transform, 'scaleX(0.25)');
    h.requests[0].respond(201, { files: [{ id: 'earlier-file', filename: 'notes.pdf' }] });
    await earlier;
    assert.equal(runtime.closed(), 0);
    assert.equal(runtime.uploadModal.hidden, false);
    assert.equal(runtime.state.uploadItems, queue);
    assert.equal(runtime.state.uploadTargetFolderId, 'next-folder');
    assert.equal(runtime.button.disabled, true);
    assert.equal(runtime.progressWrap.hidden, false);
    assert.equal(runtime.progressBar.style.transform, 'scaleX(0.25)');
    assert.equal(runtime.refreshes(), 1);
    assert.equal(h.pending(), 1);
    h.requests[1].respond(201, { files: [{ id: 'new-file', filename: 'new.pdf' }] });
    await next;
    assert.equal(runtime.closed(), 1);
    assert.equal(runtime.button.disabled, false);
    assert.equal(runtime.progressWrap.hidden, true);
    assert.equal(runtime.refreshes(), 2);
    assert.equal(h.pending(), 0);
});

test('Files stale upload errors and abort cannot overwrite reopened form feedback', async () => {
    for (const finish of [
        request => request.fail(),
        request => request.abort(),
        request => request.respond(403, { error: 'Old upload denied.' }),
        request => request.respond(201, {}),
    ]) {
        const h = harness();
        const runtime = files(h);
        const earlier = runtime.upload.uploadSelectedFiles();
        runtime.upload.openUploadModal('next-folder', [{ name: 'new.pdf', size: 20 }]);
        runtime.uploadError.textContent = 'New queue feedback';
        finish(h.requests[0]);
        await earlier;
        assert.equal(runtime.uploadError.textContent, 'New queue feedback');
        assert.equal(runtime.uploadModal.hidden, false);
        assert.equal(runtime.closed(), 0);
        assert.equal(runtime.button.disabled, false);
        assert.equal(runtime.progressWrap.hidden, true);
        assert.equal(runtime.state.uploadItems[0].name, 'new.pdf');
        assert.equal(runtime.state.uploadTargetFolderId, 'next-folder');
        assert.equal(h.pending(), 0);
    }
});

test('Files earlier folder refresh cleanup cannot reset a later upload', async () => {
    const h = harness();
    let finishRefresh;
    const refresh = new Promise(resolve => { finishRefresh = resolve; });
    let refreshCalls = 0;
    const runtime = files(h, { loadFolder: () => ++refreshCalls === 1 ? refresh : undefined });
    const earlier = runtime.upload.uploadSelectedFiles();
    h.requests[0].respond(201, { files: [{ id: 'earlier-file', filename: 'notes.pdf' }] });
    await settle();
    assert.equal(runtime.closed(), 1);
    runtime.upload.openUploadModal('next-folder', [{ name: 'new.pdf', size: 20 }]);
    const next = runtime.upload.uploadSelectedFiles();
    h.requests[1].progress(1, 2);
    finishRefresh();
    await earlier;
    assert.equal(runtime.closed(), 1);
    assert.equal(runtime.uploadModal.hidden, false);
    assert.equal(runtime.button.disabled, true);
    assert.equal(runtime.progressWrap.hidden, false);
    assert.equal(runtime.progressBar.style.transform, 'scaleX(0.5)');
    h.requests[1].respond(201, { files: [{ id: 'new-file', filename: 'new.pdf' }] });
    await next;
    assert.equal(runtime.closed(), 2);
    assert.equal(runtime.button.disabled, false);
    assert.equal(runtime.progressWrap.hidden, true);
    assert.equal(h.pending(), 0);
});

test('Files upload retains multipart metadata and shared CSRF retry without duplicate pending work', async () => {
    const h = harness();
    const runtime = files(h);
    const { upload, button, progressWrap, progressBar, alerts, file } = runtime;
    let completed = false;
    const completion = upload.uploadSelectedFiles().then(() => { completed = true; });
    await settle();
    assert.equal(completed, false);
    assert.deepEqual([...h.requests[0].body.entries].map(([name, value]) => [name, value]), [
        ['folderId', 'target-folder'], ['file', file], ['filename', 'Renamed notes.pdf'], ['visibility', 'public'], ['expiryDays', '7'],
    ]);
    assert.equal(h.pending(), 1);
    assert.deepEqual(h.labels, ['file-upload']);
    h.requests[0].progress(3, 4);
    assert.equal(progressBar.style.transform, 'scaleX(0.75)');
    h.requests[0].respond(400, {}, { 'X-APStudy-CSRF-Error': '1' });
    await settle();
    assert.equal(h.requests[1].headers['X-CSRFToken'], 'fresh');
    assert.equal(h.pending(), 1);
    assert.equal(button.disabled, true);
    h.requests[1].respond(201, { files: [{ id: 'file-1', filename: 'Renamed notes.pdf' }] });
    await completion;
    assert.equal(h.pending(), 0);
    assert.equal(runtime.refreshes(), 1);
    assert.equal(runtime.closed(), 1);
    assert.equal(button.disabled, false);
    assert.equal(progressWrap.hidden, true);
    assert.deepEqual(alerts, ['Upload complete.']);
});


test('Files completion waits for shared request and deferred folder refresh before UI cleanup', async () => {
    const h = harness();
    let finishRefresh;
    const refresh = new Promise(resolve => { finishRefresh = resolve; });
    const runtime = files(h, { loadFolder: () => refresh });
    let completed = false;
    const completion = runtime.upload.uploadSelectedFiles().then(() => { completed = true; });
    await settle();
    assert.equal(completed, false);
    h.requests[0].respond(201, { files: [{ id: 'file-1', filename: 'Renamed notes.pdf' }] });
    await settle();
    assert.equal(runtime.refreshes(), 1);
    assert.equal(completed, false);
    assert.equal(runtime.button.disabled, true);
    assert.equal(runtime.progressWrap.hidden, false);
    assert.deepEqual(runtime.alerts, []);
    assert.equal(h.pending(), 0);
    finishRefresh();
    await completion;
    assert.deepEqual(runtime.busyChanges, [true, false]);
    assert.deepEqual(runtime.alerts, ['Upload complete.']);
    assert.deepEqual(runtime.notifications, []);
    assert.equal(runtime.progressWrap.hidden, true);
});

test('Files shared HTTP failure, network failure and abort settle completion with one UI cleanup', async () => {
    for (const [settleRequest, message] of [
        [request => request.respond(403, { error: 'Cannot upload here.' }), 'Cannot upload here.'],
        [request => request.fail(), 'Network error during upload. Check your connection.'],
        [request => request.abort(), null],
    ]) {
        const h = harness();
        const runtime = files(h);
        let completed = false;
        const completion = runtime.upload.uploadSelectedFiles().then(() => { completed = true; });
        await settle();
        assert.equal(completed, false);
        settleRequest(h.requests[0]);
        await completion;
        assert.equal(h.pending(), 0);
        assert.deepEqual(runtime.busyChanges, [true, false]);
        assert.equal(runtime.progressWrap.hidden, true);
        assert.equal(runtime.refreshes(), 0);
        assert.equal(runtime.closed(), 0);
        assert.deepEqual(runtime.alerts, []);
        assert.deepEqual(runtime.notifications, message ? [message] : []);
        assert.equal(runtime.uploadError.textContent, message || '');
    }
});

test('Files shared completion handles folder refresh rejection and setup failure', async () => {
    const h = harness();
    let failRefresh;
    const refresh = new Promise((_, reject) => { failRefresh = reject; });
    const runtime = files(h, { loadFolder: () => refresh });
    const completion = runtime.upload.uploadSelectedFiles();
    h.requests[0].respond(201, { files: [{ id: 'file-1', filename: 'Renamed notes.pdf' }] });
    await settle();
    assert.equal(runtime.button.disabled, true);
    failRefresh(new Error('Folder refresh failed'));
    assert.equal(await completion, undefined);
    assert.deepEqual(runtime.notifications, ['Folder refresh failed']);
    assert.deepEqual(runtime.alerts, []);
    assert.deepEqual(runtime.busyChanges, [true, false]);
    assert.equal(h.pending(), 0);

    h.window.APStudyHttp.uploadXhr = () => { throw new Error('Unable to start upload'); };
    const failed = files(h);
    assert.equal(await failed.upload.uploadSelectedFiles(), undefined);
    assert.deepEqual(failed.notifications, ['Unable to start upload']);
    assert.deepEqual(failed.busyChanges, [true, false]);
    assert.equal(failed.progressWrap.hidden, true);
});

test('Files rejects invalid 2xx acknowledgments and retries the same metadata and file', async () => {
    for (const payload of [null, '{broken json', {}, { uploaded: 1 }, { files: [] },
        { files: [{ id: 'file-1' }] }, { files: [{ filename: 'notes.pdf' }] },
        { files: [{ id: '', filename: 'notes.pdf' }] },
        { files: [{ id: 'file-1', filename: '  ' }] },
        { files: [{ id: 'file-1', filename: 'notes.pdf' }], errors: 'broken' }]) {
        const h = harness();
        const runtime = files(h);
        const queued = runtime.state.uploadItems[0];
        const completion = runtime.upload.uploadSelectedFiles();
        h.requests[0].respond(201, payload);
        await completion;
        assert.equal(runtime.state.uploadItems[0], queued);
        assert.equal(runtime.state.uploadTargetFolderId, 'target-folder');
        assert.equal(runtime.closed(), 0);
        assert.equal(runtime.refreshes(), 0);
        assert.deepEqual(runtime.alerts, []);
        assert.match(runtime.notifications[0], /did not confirm/);
        assert.equal(h.pending(), 0);
        assert.deepEqual(runtime.busyChanges, [true, false]);
        assert.equal(runtime.progressWrap.hidden, true);
        const retry = runtime.upload.uploadSelectedFiles();
        assert.equal(h.requests[1].body.entries.find(([key]) => key === 'file')[1], queued.file);
        assert.equal(h.requests[1].body.entries.find(([key]) => key === 'filename')[1], 'Renamed notes.pdf');
        h.requests[1].respond(201, { files: [{ id: 'created-file', filename: 'Renamed notes.pdf' }] });
        await retry;
        assert.equal(runtime.closed(), 1);
        assert.equal(runtime.refreshes(), 1);
        assert.deepEqual(runtime.alerts, ['Upload complete.']);
        assert.equal(h.pending(), 0);
    }
});

test('Files partial creation follows the real files and errors response contract', async () => {
    const h = harness();
    const runtime = files(h);
    const completion = runtime.upload.uploadSelectedFiles();
    h.requests[0].respond(201, {
        files: [{ id: 'created-file', filename: 'Renamed notes.pdf' }],
        errors: [{ index: 1, error: 'Storage quota reached.' }],
    });
    await completion;
    assert.equal(runtime.closed(), 1);
    assert.equal(runtime.refreshes(), 1);
    assert.deepEqual(runtime.alerts, ['Storage quota reached.']);
    assert.equal(h.pending(), 0);
});

test('Files all-failed response retains the queue and reports the server error', async () => {
    const h = harness();
    const runtime = files(h);
    const queued = runtime.state.uploadItems[0];
    const completion = runtime.upload.uploadSelectedFiles();
    h.requests[0].respond(400, { files: [], errors: [{ index: 0, error: 'Storage quota reached.' }], error: 'Storage quota reached.' });
    await completion;
    assert.equal(runtime.state.uploadItems[0], queued);
    assert.equal(runtime.closed(), 0);
    assert.equal(runtime.refreshes(), 0);
    assert.deepEqual(runtime.notifications, ['Storage quota reached.']);
    assert.equal(h.pending(), 0);
});
