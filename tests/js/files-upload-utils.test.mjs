import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadFilesModule } from "./helpers/files-modules.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadFilesUtils(overrides = {}) {
    const document = {
        getElementById() {
            return null;
        },
    };
    const context = {
        document,
        window: { APStudyUIPrimitives: { escapeHtml: String } },
        Date,
        fetch() {
            throw new Error("fetch should not run while loading utils");
        },
        ...overrides,
    };
    return loadFilesModule("files/utils.js", context);
}

function clipboardDocument({ copied = true, copyError, selectError } = {}) {
    const inputs = [];
    const commands = [];
    const body = [];
    return {
        inputs,
        commands,
        body: {
            appendChild(input) { body.push(input); },
        },
        createElement(tag) {
            assert.equal(tag, "input");
            const input = {
                value: "",
                select() {
                    assert.equal(body.includes(input), true);
                    if (selectError) throw selectError;
                },
                remove() { body.splice(body.indexOf(input), 1); },
            };
            inputs.push(input);
            return input;
        },
        execCommand(command) {
            commands.push(command);
            if (copyError) throw copyError;
            return copied;
        },
        get attachedInputs() { return body.length; },
    };
}

test("copy helper uses modern clipboard without creating a fallback input", async () => {
    const document = clipboardDocument();
    const copied = [];
    const utils = await loadFilesUtils({
        document,
        navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    });
    await utils.copyText("share-link");
    assert.deepEqual(copied, ["share-link"]);
    assert.equal(document.inputs.length, 0);
});

test("copy helper falls back after modern clipboard rejection and removes its input", async () => {
    const document = clipboardDocument();
    const utils = await loadFilesUtils({
        document,
        navigator: { clipboard: { async writeText() { throw new Error("Permission denied"); } } },
    });
    await utils.copyText("share-link");
    assert.deepEqual(document.commands, ["copy"]);
    assert.equal(document.inputs[0].value, "share-link");
    assert.equal(document.attachedInputs, 0);
});

test("copy helper rejects denied or throwing fallback and always removes its input", async () => {
    const copyError = new Error("Copy was denied");
    const selectError = new Error("Selection failed");
    for (const [options, expected] of [
        [{ copied: false }, /Clipboard access failed/],
        [{ copyError }, copyError],
        [{ selectError }, selectError],
    ]) {
        const document = clipboardDocument(options);
        const utils = await loadFilesUtils({ document, navigator: {} });
        await assert.rejects(utils.copyText("share-link"), expected);
        assert.equal(document.inputs.length, 1);
        assert.equal(document.attachedInputs, 0);
    }
});

function downloadHarness() {
    const saves = [];
    const createdBlobs = [];
    const revokedUrls = [];
    const links = [];
    const document = {
        body: { appendChild(link) { link.attached = true; } },
        createElement(tag) {
            assert.equal(tag, "a");
            const link = {
                click() { assert.equal(link.attached, true); saves.push([link.href, link.download]); },
                remove() { link.attached = false; },
            };
            links.push(link);
            return link;
        },
    };
    const context = {
        document,
        URL: {
            createObjectURL(blob) { createdBlobs.push(blob); return "blob:selected"; },
            revokeObjectURL(url) { revokedUrls.push(url); },
        },
        window: { location: {} },
    };
    const { createDownloadWorkflow } = loadFilesModule("files/download-workflow.js", context);
    const busy = [];
    const alerts = [];
    const button = {};
    const state = { selectedFileIds: new Set(["one", "two"]) };
    const workflow = createDownloadWorkflow({ state, els: { bulkDownload: button }, view: {
        setButtonBusy(target, value) { assert.equal(target, button); busy.push(value); },
        showAlert(...args) { alerts.push(args); },
    } });
    return { workflow, state, context, saves, createdBlobs, revokedUrls, links, busy, alerts };
}

test("bulk download saves header filenames and clears browser resources and busy state", async () => {
    for (const [header, expected] of [
        ["attachment; filename*=UTF-8''class%20notes.zip", "class notes.zip"],
        ['attachment; filename="selected.zip"; filename*=UTF-8\'\'bad%ZZ.zip', "selected.zip"],
        ["attachment; filename*=UTF-8''notes%E0%A4.zip", "notes%E0%A4.zip"],
        ["attachment; filename*=UTF-8''bad%ZZ.zip", "bad%ZZ.zip"],
        ['attachment; filename="selected.zip"', "selected.zip"],
        [null, "file-share-selected.zip"],
    ]) {
        const h = downloadHarness();
        const blob = {};
        const requests = [];
        h.context.fetch = async (...args) => {
            requests.push(args);
            return { ok: true, headers: { get: () => header }, blob: async () => blob };
        };
        await h.workflow.downloadSelectedFiles();
        assert.equal(requests[0][0], "/api/files/bulk-download.zip");
        assert.deepEqual(JSON.parse(requests[0][1].body), { fileIds: ["one", "two"] });
        assert.deepEqual(h.saves, [["blob:selected", expected]]);
        assert.deepEqual(h.createdBlobs, [blob]);
        assert.deepEqual(h.revokedUrls, ["blob:selected"]);
        assert.equal(h.links[0].attached, false);
        assert.deepEqual(h.busy, [true, false]);
        assert.deepEqual(h.alerts, []);
    }
});

test("bulk download handles empty and single selections and HTTP failure", async () => {
    const h = downloadHarness();
    h.state.selectedFileIds.clear();
    await h.workflow.downloadSelectedFiles();
    assert.equal(h.alerts[0][1], "error");
    h.state.selectedFileIds.add("one/two");
    await h.workflow.downloadSelectedFiles();
    assert.equal(h.context.window.location.href, "/api/files/my/one%2Ftwo/download");
    assert.deepEqual(h.busy, []);
    h.state.selectedFileIds.add("three");
    h.context.fetch = async () => ({ ok: false, json: async () => ({ error: "Download refused" }) });
    await h.workflow.downloadSelectedFiles();
    assert.equal(h.alerts[1][0], "Download refused");
    assert.deepEqual(h.busy, [true, false]);
    assert.deepEqual(h.saves, []);
});

test("share copy reports clipboard failure instead of a success alert", async () => {
    const document = clipboardDocument({ copied: false });
    const utils = await loadFilesUtils({ document, navigator: {} });
    const { workflows } = await loadFilesWorkflows();
    const alerts = [];
    const workflow = workflows.createFilesWorkflows({
        state: { shareContext: { item: { shareUrl: "https://example.test/shared" } } },
        els: {},
        sharing: {
            expiry: {}, manager: {}, links: { copyText: utils.copyText },
            view: { showAlert(...args) { alerts.push(args); } },
        },
        upload: { limits: {}, folders: {}, view: {} },
        downloads: { view: {} },
    });
    await workflow.copyCurrentShareLink();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][1], "error");
    assert.equal(alerts[0][2].title, "Couldn’t copy link");
    assert.equal(document.attachedInputs, 0);
});

const workflowContexts = new WeakMap();

async function loadFilesWorkflows() {
    const context = {
        window: {
            APStudyHttp: {},
        },
        FormData: class {
            append() {}
        },
    };
    const workflows = loadFilesModule("files/workflows.js", context);
    Object.assign(context, loadFilesModule("files/sharing-workflow.js", context));
    Object.assign(context, loadFilesModule("files/selection-workflow.js", context));
    workflowContexts.set(workflows, context);
    return { workflows, context };
}

function createUploadHarness(workflows, {
    context = null,
    uploadXhr,
    loadFolder,
    status = 201,
    payload = { files: [{ id: "file-1", filename: "notes.pdf" }] },
} = {}) {
    const button = {
        disabled: false,
        classList: { toggle(_name, value) { button.busy = value; } },
        busy: false,
    };
    const progressWrap = { hidden: true };
    const progressBar = { style: {} };
    const state = {
        uploadItems: [{
            id: "upload-1",
            file: { name: "notes.pdf", size: 1 },
            name: "notes.pdf",
            visibility: "private",
            expiryDays: "7",
        }],
        uploadTargetFolderId: null,
        currentFolderId: null,
    };
    const els = {
        uploadButton: button,
        progressWrap,
        progressBar,
        uploadError: {},
    };
    const events = {};
    const notifications = [];
    const alerts = [];
    const busyChanges = [];
    let senderCalls = 0;
    const operation = deferred();
    let folderLoads = 0;
    let closed = 0;
    const xhr = {
        status,
        responseType: "json",
        response: payload,
        getResponseHeader() { return "application/json"; },
    };
    const workflow = workflows.createFilesWorkflows({
        state,
        els,
        upload: {
            limits: {
                allowedExpiry: [1, 3, 7], defaultExpiry: 7,
                maxFileSizeBytes: 10, maxFileSizeLabel: "10 B", maxUploadFiles: 5,
            },
            folders: {
                loadFolder: async () => { folderLoads += 1; return loadFolder?.(); },
                normalizeFolderId(value) { return value; },
                getFolderName() {},
            },
            view: {
                clearFormError() {},
                modalController: { close() { closed += 1; }, open() {} },
                notify(message) { notifications.push(message); },
                setButtonBusy(target, busy) {
                    busyChanges.push(busy);
                    target.disabled = busy;
                    target.classList.toggle("is-busy", busy);
                },
                showAlert(message, type) { alerts.push({ message, type }); },
                uploadItemHtml() { return ""; },
            },
        },
        sharing: { expiry: {}, manager: {}, links: {}, view: {} },
        downloads: { view: {} },
    });
    context ||= workflowContexts.get(workflows);
    context.window.APStudyHttp.uploadXhr = (url, options) => {
        senderCalls += 1;
        assert.equal(url, "/api/files/upload");
        assert.equal(options.pendingLabel, "file-upload");
        Object.assign(events, options);
        return uploadXhr ? uploadXhr(url, options) : operation.promise;
    };
    return {
        workflow,
        events,
        xhr,
        state,
        button,
        progressWrap,
        progressBar,
        notifications,
        alerts,
        busyChanges,
        get senderCalls() { return senderCalls; },
        resolve: value => operation.resolve(value || xhr),
        reject: error => operation.reject(error),
        get folderLoads() { return folderLoads; },
        get closed() { return closed; },
    };
}

test("upload workflow parses JSON and text acknowledgments without reading invalid responseText", async () => {
    const { workflows } = await loadFilesWorkflows();
    let responseTextReads = 0;
    const files = [{ id: "file-1", filename: "notes.pdf" }];
    for (const response of [
        { status: 201, responseType: "json", response: { files }, get responseText() {
            responseTextReads += 1;
            throw new Error("responseText is invalid for json responseType");
        } },
        { status: 201, responseType: "text", response: JSON.stringify({ files }), getResponseHeader: () => "text/plain" },
        { status: 201, responseType: "", responseText: JSON.stringify({ files }) },
        { status: 201, responseType: "", response: { files }, getResponseHeader: () => "application/json" },
    ]) {
        const h = createUploadHarness(workflows);
        const completion = h.workflow.uploadSelectedFiles();
        h.resolve(response);
        await completion;
        assert.equal(h.folderLoads, 1);
        assert.equal(h.closed, 1);
        assert.deepEqual(h.notifications, []);
        assert.equal(h.button.disabled, false);
    }
    assert.equal(responseTextReads, 0);
});

test("upload workflow retains the queue for HTML, undecodable or absent acknowledgments", async () => {
    const { workflows } = await loadFilesWorkflows();
    for (const response of [
        { status: 200, responseType: "json", response: null, get responseText() { throw Error("Must not read JSON text"); } },
        { status: 200, responseType: "text", responseText: "not-json" },
        { status: 200, responseType: "text", get responseText() { throw Error("Unavailable text"); } },
        { status: 200, responseType: "blob", response: {} },
        { status: 200, responseType: "json", response: { files: [] } },
        { status: 200, responseType: "json", response: { files: [{ id: "a" }] } },
        { status: 200, responseType: "json", response: { files: [{ id: "a", filename: "a.pdf" }], errors: [{}] } },
    ]) {
        const h = createUploadHarness(workflows);
        const completion = h.workflow.uploadSelectedFiles();
        h.resolve(response);
        await completion;
        assert.equal(h.folderLoads, 0);
        assert.equal(h.closed, 0);
        assert.equal(h.state.uploadItems.length, 1);
        assert.deepEqual(h.notifications, ["The server did not confirm the uploaded files. Try again."]);
        assert.equal(h.button.disabled, false);
        assert.equal(h.progressWrap.hidden, true);
    }
});

test("upload workflow maps decoded server errors and HTTP status fallbacks", async () => {
    const { workflows } = await loadFilesWorkflows();
    for (const [response, message] of [
        [{ status: 400, responseType: "text", responseText: JSON.stringify({ error: "Bucket limit exceeded" }) }, "Bucket limit exceeded"],
        [{ status: 400, responseType: "json", response: { errors: [{ error: "File rejected" }] } }, "File rejected"],
        [{ status: 413, responseType: "json", response: null }, "File is too large for the server upload limit."],
        [{ status: 401 }, "Session expired. Please sign in again."],
        [{ status: 403 }, "Session expired. Please sign in again."],
        [{ status: 400 }, "Upload failed (HTTP 400)."],
        [{ status: 502 }, "Upload timed out. Try again or use a smaller file."],
        [{ status: 504 }, "Upload timed out. Try again or use a smaller file."],
        [{ status: 0 }, "Network error during upload. Check your connection."],
    ]) {
        const h = createUploadHarness(workflows);
        const completion = h.workflow.uploadSelectedFiles();
        h.resolve(response);
        await completion;
        assert.deepEqual(h.notifications, [message]);
        assert.equal(h.folderLoads, 0);
        assert.equal(h.closed, 0);
        assert.equal(h.button.disabled, false);
    }
});

test("upload workflow preserves progress and cleans up after JSON 201 partial success", async () => {
    const { workflows } = await loadFilesWorkflows();
    const harness = createUploadHarness(workflows, {
        payload: { files: [{ id: "file-1", filename: "notes.pdf" }], errors: [{ error: "One file was skipped." }] },
    });
    const completion = harness.workflow.uploadSelectedFiles();
    assert.equal(harness.senderCalls, 1);
    assert.equal(harness.events.responseType, "json");
    harness.events.onProgress({ lengthComputable: true, loaded: 50, total: 100 });
    assert.equal(harness.progressBar.style.transform, "scaleX(0.5)");
    harness.resolve();
    await completion;
    assert.equal(harness.folderLoads, 1);
    assert.equal(harness.closed, 1);
    assert.deepEqual(harness.alerts, [{ message: "One file was skipped.", type: "error" }]);
    assert.equal(harness.button.disabled, false);
    assert.equal(harness.progressWrap.hidden, true);
});

test("real shared upload transport tracks once and settles before the folder refresh", async () => {
    const { workflows, context } = await loadFilesWorkflows();
    const refresh = deferred();
    const harness = createUploadHarness(workflows, { loadFolder: () => refresh.promise });
    const window = new EventTarget();
    window.location = { href: "https://nest.example/files", origin: "https://nest.example" };
    const document = { documentElement: { toggleAttribute() {} } };
    const runtime = vm.createContext({ window, document, URL, Error, CustomEvent: globalThis.CustomEvent });
    vm.runInContext(await readFile(path.join(repoRoot, "static/js/core/http.js"), "utf8"), runtime);
    vm.runInContext(await readFile(path.join(repoRoot, "static/js/core/pending-mutations.js"), "utf8"), runtime);
    const pending = window.APStudyCoreServices.pendingMutations.createPendingMutations({ window, document });
    const xhr = { ...harness.xhr, upload: {}, open() {}, setRequestHeader() {}, send() {} };
    const http = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: pending });
    context.window.APStudyHttp = { uploadXhr: (url, options) => http.uploadXhr(url, { ...options, xhrFactory: () => xhr }) };
    const completion = harness.workflow.uploadSelectedFiles();
    assert.equal(pending.count(), 1);
    xhr.upload.onprogress({ lengthComputable: true, loaded: 25, total: 100 });
    assert.equal(harness.progressBar.style.transform, "scaleX(0.25)");
    xhr.onload();
    await flushUpload();
    assert.equal(pending.count(), 0, "transport owns the pending label");
    assert.equal(harness.folderLoads, 1);
    assert.equal(harness.button.disabled, true, "UI stays busy through folder refresh");
    refresh.resolve(); await completion;
    assert.equal(harness.button.disabled, false);
    assert.deepEqual(harness.busyChanges, [true, false]);
    xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
    assert.equal(harness.progressWrap.hidden, true);
});

test("upload workflow maps HTML HTTP failures and always clears busy state", async () => {
    const { workflows } = await loadFilesWorkflows();
    for (const status of [400, 413, 502]) {
        const harness = createUploadHarness(workflows, { status, payload: null });
        const completion = harness.workflow.uploadSelectedFiles();
        harness.resolve();
        await completion;
        assert.equal(harness.button.disabled, false, `HTTP ${status} button cleanup`);
        assert.equal(harness.progressWrap.hidden, true, `HTTP ${status} progress cleanup`);
        assert.match(harness.notifications[0], status === 413
            ? /too large/
            : status === 502 ? /timed out/ : /HTTP 400/);
    }
});

test("upload workflow maps network errors, aborts, and transport setup failures", async () => {
    const { workflows } = await loadFilesWorkflows();

    const network = createUploadHarness(workflows, { status: 0, payload: null });
    const networkCompletion = network.workflow.uploadSelectedFiles();
    network.resolve();
    await networkCompletion;
    assert.match(network.notifications[0], /Network error/);
    assert.equal(network.button.disabled, false);
    assert.equal(network.progressWrap.hidden, true);

    const aborted = createUploadHarness(workflows);
    const abortedCompletion = aborted.workflow.uploadSelectedFiles();
    aborted.reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
    await abortedCompletion;
    assert.equal(aborted.button.disabled, false);
    assert.equal(aborted.progressWrap.hidden, true);

    const senderError = createUploadHarness(workflows, {
        uploadXhr() { return Promise.reject(new Error("Unable to start upload")); },
    });
    await senderError.workflow.uploadSelectedFiles();
    assert.equal(senderError.button.disabled, false);
    assert.equal(senderError.progressWrap.hidden, true);
    assert.deepEqual(senderError.notifications, ["Unable to start upload"]);
    assert.deepEqual(aborted.notifications, []);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const flushUpload = () => new Promise(resolve => setImmediate(resolve));

test("shared upload Promise completion waits for the request, folder refresh, and cleanup", async () => {
    const { workflows } = await loadFilesWorkflows();
    const refresh = deferred();
    const harness = createUploadHarness(workflows, { loadFolder: () => refresh.promise });
    let completed = false;
    const completion = harness.workflow.uploadSelectedFiles().then(() => { completed = true; });
    await flushUpload();
    assert.equal(completed, false);
    assert.equal(harness.folderLoads, 0);
    harness.resolve();
    // Once the request has settled, stale terminal events must not clean up a
    // folder refresh or turn its successful response into an error.
    harness.reject(new Error("Ignored terminal failure"));
    harness.reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
    await flushUpload();
    assert.equal(completed, false);
    assert.equal(harness.folderLoads, 1);
    assert.equal(harness.button.disabled, true);
    refresh.resolve();
    await completion;
    assert.deepEqual(harness.busyChanges, [true, false]);
    assert.deepEqual(harness.notifications, []);
    assert.deepEqual(harness.alerts, [{ message: "Upload complete.", type: undefined }]);
    harness.events.onProgress({ lengthComputable: true, loaded: 1, total: 2 });
    harness.reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
    assert.equal(harness.progressWrap.hidden, true);
});

test("shared upload Promise completion handles failed folder refresh before cleaning up once", async () => {
    const { workflows } = await loadFilesWorkflows();
    const refresh = deferred();
    const harness = createUploadHarness(workflows, { loadFolder: () => refresh.promise });
    const completion = harness.workflow.uploadSelectedFiles();
    harness.resolve();
    await flushUpload();
    assert.equal(harness.button.disabled, true);
    refresh.reject(new Error("Folder refresh failed"));
    assert.equal(await completion, undefined);
    assert.deepEqual(harness.notifications, ["Folder refresh failed"]);
    assert.deepEqual(harness.alerts, []);
    assert.deepEqual(harness.busyChanges, [true, false]);
    assert.equal(harness.progressWrap.hidden, true);
});

test("shared upload Promise completion waits for failure or abort and ignores duplicate terminal events", async () => {
    const { workflows } = await loadFilesWorkflows();
    for (const terminal of ["onError", "onAbort"]) {
        const harness = createUploadHarness(workflows, { status: 0, payload: null });
        let completed = false;
        const completion = harness.workflow.uploadSelectedFiles().then(() => { completed = true; });
        await flushUpload();
        assert.equal(completed, false);
        if (terminal === "onError") harness.resolve();
        else harness.reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
        harness.resolve();
        harness.reject(Object.assign(new Error("Upload cancelled."), { name: "AbortError" }));
        await completion;
        assert.equal(harness.folderLoads, 0);
        assert.equal(harness.closed, 0);
        assert.deepEqual(harness.busyChanges, [true, false]);
        assert.equal(harness.progressWrap.hidden, true);
        assert.equal(harness.notifications.length, terminal === "onError" ? 1 : 0);
    }
});

test("upload badge labels, tones, and icons share classification precedence", async () => {
    const { uploadItemHtml } = loadFilesModule("files/renderers.js", { window: { APStudyUIPrimitives: { escapeHtml: String } } });
    for (const [file, label, tone, icon] of [
        [{ name: "notes.PDF", type: "IMAGE/PNG" }, "PDF", "pdf", "picture_as_pdf"],
        [{ name: "photo.png", type: "application/pdf" }, "PDF", "pdf", "picture_as_pdf"],
        [{ name: "photo.jpeg", type: "video/mp4" }, "JPEG", "image", "image"],
        [{ name: "clip.mp4", mimeType: "application/zip" }, "MP4", "video", "movie"],
        [{ name: "backup.zip", type: "application/octet-stream" }, "ZIP", "archive", "folder_zip"],
        [{ name: "download", mimeType: "image/png" }, "IMG", "image", "image"],
        [{ name: "download", type: "video/mp4" }, "VID", "video", "movie"],
        [{ name: "download", mimeType: "application/x-compressed" }, "ZIP", "archive", "folder_zip"],
        [{ name: "essay.longextension", type: "text/plain" }, "LONG", "default", "description"],
        [{ name: "download" }, "FILE", "default", "description"],
        [null, "FILE", "default", "description"],
    ]) {
        const html = uploadItemHtml({ id: "upload", file: file || {}, name: "Draft", visibility: "private", expiryDays: "7" }, [7]);
        assert.ok(html.includes(`files-upload-file-badge--${tone}`));
        assert.ok(html.includes(`>${label}</span>`));
        assert.ok(html.includes(`>${icon}</span>`));
    }
});

test("folder and file cards preserve status, counts, escaping, and MIME icons", () => {
    const { folderCardHtml, fileCardHtml } = loadFilesModule("files/renderers.js", {});
    const shared = folderCardHtml({ id: "folder", name: "<Class>", isPublic: true, folderCount: 1, fileCount: 2 }, true);
    assert.ok(shared.includes("&lt;Class&gt;"));
    assert.ok(shared.includes("Shared / No folder expiry"));
    assert.ok(shared.includes("1 folder / 2 files"));
    assert.ok(shared.includes("is-selected"));
    const empty = folderCardHtml({ id: "folder", name: "Class", isPublic: false }, false);
    assert.ok(empty.includes("Private / No folder expiry"));
    assert.ok(empty.includes("Empty folder"));
    for (const [mimeType, icon] of [["image/png", "image"], ["application/pdf", "picture_as_pdf"], ["application/zip", "folder_zip"], ["text/plain", "description"]]) {
        const html = fileCardHtml({ id: "file", filename: "<Notes>", mimeType, fileSizeBytes: 12, isPublic: false }, false);
        assert.ok(html.includes(`>${icon}</span>`));
        assert.ok(html.includes("&lt;Notes&gt;"));
        assert.ok(html.includes("Private / No expiry"));
        assert.ok(html.includes("12 B"));
    }
    assert.ok(fileCardHtml({ id: "file", filename: "Shared", isPublic: true, expiresAt: "invalid" }, false).includes("Shared / Expiry unknown"));
});

test("new menu toggles visibility and aria state and focuses its first item only on opening", () => {
    const frames = [];
    const { toggleNewMenu } = loadFilesModule("files/renderers.js", { requestAnimationFrame: callback => frames.push(callback) });
    const focuses = [];
    const menu = { hidden: true, querySelector(selector) {
        assert.equal(selector, '[role="menuitem"]');
        return { focus: options => focuses.push(options) };
    } };
    const attributes = {};
    const button = { setAttribute: (name, value) => { attributes[name] = value; } };
    toggleNewMenu(menu, button);
    assert.equal(menu.hidden, false);
    assert.equal(attributes["aria-expanded"], "true");
    assert.equal(frames.length, 1);
    frames[0]();
    assert.equal(focuses[0].preventScroll, true);
    toggleNewMenu(menu, button);
    assert.equal(menu.hidden, true);
    assert.equal(attributes["aria-expanded"], "false");
    assert.equal(frames.length, 1);
    toggleNewMenu(null, button);
});

test("files workflows use upload response helpers and notify on failure", async () => {
    const workflowsSource = await readFile(path.join(repoRoot, "static/js/files/upload-workflow.js"), "utf8");
    const indexSource = await readFile(path.join(repoRoot, "static/js/files/index.js"), "utf8");
    const modalsSource = await readFile(path.join(repoRoot, "static/js/files/modals.js"), "utf8");
    const templateSource = await readFile(path.join(repoRoot, "templates/files.html"), "utf8");
    const fileInputMatch = templateSource.match(/<input[^>]+id="file-share-input"[^>]*>/);

    assert.match(workflowsSource, /parseUploadResponse\(request\)/);
    assert.match(workflowsSource, /uploadErrorMessage\(request, payload\)/);
    assert.doesNotMatch(workflowsSource, /sendUpload|APStudyPendingMutations/);
    assert.match(workflowsSource, /APStudyHttp\.uploadXhr/);
    assert.match(workflowsSource, /pendingLabel: "file-upload"/);
    assert.match(workflowsSource, /responseType: "json"/);
    assert.match(workflowsSource, /onProgress/);
    assert.doesNotMatch(indexSource, /firstUploadError|parseUploadResponse|uploadErrorMessage|downloadBlob|filenameFromDisposition/);
    assert.match(indexSource, /function notify\(message, type = "info", options = \{\}\)/);
    assert.match(modalsSource, /notify\(error\.message \|\| "Try again in a moment\.", "error", \{ modalError: els\.folderError, title: "Couldn’t save changes" \}\)/);
    assert.ok(fileInputMatch);
    assert.match(fileInputMatch[0], /type="file"/);
    assert.match(fileInputMatch[0], /multiple/);
    assert.match(fileInputMatch[0], /class="files-visually-hidden"/);
    assert.doesNotMatch(fileInputMatch[0], /\shidden(?:\s|=|>)/);
});

test("sharing saves retain metadata and update both folder projections without clearing selection", async () => {
    const { context } = await loadFilesWorkflows();
    const folder = { id: "folder/1", name: "Classes", isPublic: false, parentId: "root" };
    const state = {
        files: [], folders: [folder], allFolders: [{ ...folder }],
        selectedFolderIds: new Set([folder.id]),
    };
    const visibility = { checked: false, setAttribute() {} };
    const els = { shareVisibility: visibility, copyShareButton: {}, shareLink: {}, shareLinkWrap: {} };
    const requests = [];
    const alerts = [];
    let renders = 0;
    let opens = 0;
    const sharing = context.createSharingWorkflow({
        state, els,
        expiry: {}, links: {},
        manager: { renderManager() { renders += 1; } },
        view: {
            clearFormError() {},
            modalController: { open() { opens += 1; } },
            showAlert(message) { alerts.push(message); },
        },
        async apiJson(url, options) {
            requests.push([url, options]);
            assert.equal(visibility.disabled, true);
            assert.equal(els.copyShareButton.disabled, true);
            return { id: folder.id, isPublic: true, shareUrl: "https://example.test/folder" };
        },
    });
    sharing.openShareModal("folder", folder);
    visibility.checked = true;
    await sharing.saveShareVisibility();
    assert.equal(opens, 1);
    assert.equal(requests[0][0], "/api/files/folders/folder%2F1/visibility");
    assert.equal(requests[0][1].body, JSON.stringify({ visibility: "public" }));
    assert.equal(state.folders[0].name, "Classes");
    assert.equal(state.allFolders[0].parentId, "root");
    assert.equal(state.folders[0].isPublic, true);
    assert.equal(state.allFolders[0].isPublic, true);
    assert.equal(state.shareContext.item, state.folders[0]);
    assert.equal(state.selectedFolderIds.has(folder.id), true);
    assert.equal(els.shareLink.value, "https://example.test/folder");
    assert.equal(els.shareLinkWrap.hidden, false);
    assert.equal(visibility.disabled, false);
    assert.equal(els.copyShareButton.disabled, false);
    assert.equal(renders, 1);
    assert.deepEqual(alerts, ["Public link enabled."]);
});

test("failed sharing changes restore saved controls and clear busy state", async () => {
    const { context } = await loadFilesWorkflows();
    const item = { id: "one", filename: "Notes", isPublic: false, expiresAt: "saved-expiry" };
    const state = { files: [item], shareContext: { type: "file", item } };
    const els = { shareVisibility: { checked: true, setAttribute() {} }, shareExpiry: { value: "30" }, copyShareButton: {} };
    const notifications = [];
    const sharing = context.createSharingWorkflow({
        state, els,
        expiry: {
            allowedExpiry: [7, 30], defaultExpiry: 7,
            expiryOptionForDate(value) { assert.equal(value, "saved-expiry"); return 7; },
            shareExpiryOptionsHtml(_allowed, value) { return `selected:${value}`; },
        },
        manager: {}, links: {},
        view: {
            clearFormError() {},
            notify(message, type, options) { notifications.push({ message, type, title: options.title }); },
        },
        async apiJson() { throw new Error("Permission denied"); },
    });
    await sharing.saveShareExpiry();
    assert.equal(els.shareVisibility.checked, false);
    assert.equal(els.shareExpiry.innerHTML, "selected:7");
    assert.equal(els.shareExpiry.disabled, false);
    assert.equal(els.copyShareButton.disabled, true);
    assert.equal(state.shareContext.item, item);
    assert.deepEqual(notifications, [{ message: "Permission denied", type: "error", title: "Couldn’t update expiration" }]);
});

test("selection projects mixed choices into rows and download availability, then clears them", async () => {
    const { context } = await loadFilesWorkflows();
    const rows = new Map();
    const checkboxes = [{ checked: true }, { checked: true }];
    context.document = {
        querySelector(selector) {
            if (!rows.has(selector)) rows.set(selector, {
                classList: {
                    toggle(_name, value) { this.selected = value; },
                    remove() { this.selected = false; },
                },
            });
            return rows.get(selector);
        },
        querySelectorAll(selector) {
            return selector === ".files-row.is-selected" ? [...rows.values()] : checkboxes;
        },
    };
    const state = { selectedFileIds: new Set(), selectedFolderIds: new Set() };
    const els = { selectionBar: {}, selectionCount: {}, bulkMove: {}, bulkDelete: {}, bulkDownload: {} };
    const selection = context.createSelectionWorkflow({ state, els, cssEscape: value => value, formatCount: count => `${count} items` });
    selection.setSelection("folder", "folder-1", true);
    assert.equal(els.bulkDownload.disabled, true);
    selection.setSelection("file", "file-1", true);
    assert.equal(selection.selectedTotal(), 2);
    assert.equal(els.selectionCount.textContent, "2 items selected");
    assert.equal(els.selectionBar.hidden, false);
    assert.equal(els.bulkDownload.disabled, false);
    assert.equal(rows.get('[data-file-id="file-1"]').classList.selected, true);
    selection.clearSelection();
    assert.equal(selection.selectedTotal(), 0);
    assert.equal(els.selectionBar.hidden, true);
    assert.equal(els.bulkMove.disabled, true);
    assert.equal(els.bulkDelete.disabled, true);
    assert.equal(els.bulkDownload.disabled, true);
    assert.equal(checkboxes.every(checkbox => !checkbox.checked), true);
    assert.equal([...rows.values()].every(row => !row.classList.selected), true);
});
