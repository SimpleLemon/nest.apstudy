/* global queueMicrotask, URL */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const httpSource = fs.readFileSync("static/js/core/http.js", "utf8");

function createXhrFactory(responses, created) {
    return () => {
        const response = responses.shift() || {};
        const xhr = {
            status: 0,
            response: null,
            responseType: "",
            timeout: 0,
            upload: {},
            requestHeaders: {},
            responseHeaders: response.headers || {},
            open(method, url) {
                this.method = method;
                this.url = url;
            },
            setRequestHeader(name, value) {
                this.requestHeaders[name] = value;
            },
            getResponseHeader(name) {
                const match = Object.entries(this.responseHeaders)
                    .find(([key]) => key.toLowerCase() === String(name).toLowerCase());
                return match?.[1] || null;
            },
            send(body) {
                this.body = body;
                this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
                queueMicrotask(() => {
                    this.status = response.status ?? 0;
                    this.response = response.body ?? null;
                    (response.event === "error" ? this.onerror : this.onload)?.();
                });
            },
        };
        created.push(xhr);
        return xhr;
    };
}

function installHttpRuntime({ csrf, pendingMutations } = {}) {
    const window = {
        location: {
            href: "https://nest.apstudy.org/files",
            origin: "https://nest.apstudy.org",
        },
        APStudyCsrf: csrf,
        APStudyPendingMutations: pendingMutations,
    };
    vm.runInNewContext(httpSource, {
        window,
        URL,
        Error,
        XMLHttpRequest: class {},
    });
    return window.APStudyCoreServices.http.createHttpService({ window, csrf, pendingMutations });
}

test("upload XHR injects CSRF, refreshes once, preserves progress, and tracks the mutation", async () => {
    let token = "stale";
    let refreshes = 0;
    let tracked = 0;
    const progress = [];
    const created = [];
    const http = installHttpRuntime({
        csrf: {
            token: () => token,
            isFailure: (status, getHeader) => status === 400 && getHeader("X-APStudy-CSRF-Error") === "1",
            refresh: async () => {
                refreshes += 1;
                token = "fresh";
            },
        },
        pendingMutations: {
            track: async (promise, label) => {
                tracked += 1;
                assert.equal(label, "file-upload");
                return promise;
            },
        },
    });
    const xhrFactory = createXhrFactory([
        { status: 400, headers: { "X-APStudy-CSRF-Error": "1" } },
        { status: 201, body: { files: [{ id: "file-1" }] } },
    ], created);
    const body = { multipart: true };

    const result = await http.uploadXhr("/api/files/upload", {
        body,
        xhrFactory,
        pendingLabel: "file-upload",
        onProgress: (event) => progress.push(event.loaded),
    });

    assert.equal(result.status, 201);
    assert.equal(refreshes, 1);
    assert.equal(tracked, 1);
    assert.deepEqual(progress, [1, 1]);
    assert.equal(created.length, 2);
    assert.equal(created[0].requestHeaders["X-CSRFToken"], "stale");
    assert.equal(created[1].requestHeaders["X-CSRFToken"], "fresh");
    assert.equal(created[0].body, body);
    assert.equal(created[1].body, body);
});

test("upload XHR resolves network errors for feature-specific messaging without leaking CSRF cross-origin", async () => {
    const created = [];
    const http = installHttpRuntime({
        csrf: {
            token: () => "secret-token",
            isFailure: () => false,
            refresh: async () => {},
        },
    });
    const xhrFactory = createXhrFactory([{ status: 0, event: "error" }], created);

    const result = await http.uploadXhr("https://uploads.example.test/file", {
        body: "payload",
        xhrFactory,
    });

    assert.equal(result.status, 0);
    assert.equal(created[0].requestHeaders["X-CSRFToken"], undefined);
});

test("malformed HTTP error JSON retains response context and reaches errorFactory", async () => {
    const http = installHttpRuntime();
    const cause = new SyntaxError("Unexpected token");
    const response = { ok: false, status: 503, statusText: "Service Unavailable", url: "https://nest.apstudy.org/api/save", headers: { get: () => "application/json" }, json: async () => { throw cause; } };
    let calls = 0;
    const window = { fetch: async () => response };
    const factory = vm.runInNewContext(`${httpSource}\nwindow.APStudyCoreServices.http.createHttpService`, { window, URL });
    const service = factory({ window });
    for (const jsonMode of ["content-type", "required", "optional"]) {
        await assert.rejects(service.fetchJson("/api/save", {
            jsonMode,
            errorFactory(payload, received) {
                calls += 1;
                assert.equal(Object.keys(payload).length, 0);
                assert.equal(received, response);
                return new Error("Please try saving later.");
            },
        }), error => error.message === "Please try saving later." && error.status === 503 && error.url === response.url && error.response === response && error.cause === cause);
    }
    assert.equal(calls, 3);
    assert.equal(typeof http.fetchJson, "function");
});

test("successful malformed JSON rejects distinctly while optional decoding keeps its fallback", async () => {
    const cause = new SyntaxError("Bad JSON");
    const window = { fetch: async () => ({ ok: true, status: 200, url: "/api/data", headers: { get: () => "application/json" }, json: async () => { throw cause; } }) };
    vm.runInNewContext(httpSource, { window, URL, Error });
    const http = window.APStudyCoreServices.http.createHttpService({ window });
    await assert.rejects(http.fetchJson("/api/data"), error => error.message === "Invalid JSON response." && error.cause === cause && error.status === 200);
    assert.equal(Object.keys(await http.fetchJson("/api/data", { jsonMode: "optional" })).length, 0);
});

test("upload cancellation aborts active XHR and releases pending tracking", async () => {
    const controller = new AbortController();
    let xhr;
    let pending = 0;
    const http = installHttpRuntime({ pendingMutations: { track(promise) { pending += 1; return promise.finally(() => { pending -= 1; }); } } });
    const request = http.uploadXhr("/upload", {
        signal: controller.signal, pendingLabel: "upload",
        xhrFactory: () => (xhr = { open() {}, setRequestHeader() {}, send() {}, abort() { this.aborted = true; this.onabort(); } }),
    });
    assert.equal(pending, 1);
    controller.abort();
    await assert.rejects(request, error => error.name === "AbortError" && error.xhr === xhr);
    assert.equal(xhr.aborted, true);
    assert.equal(pending, 0);
});

test("cancelling during CSRF refresh settles promptly and prevents another attempt", async () => {
    const controller = new AbortController();
    const created = [];
    let completeRefresh;
    const http = installHttpRuntime({ csrf: {
        isFailure: () => true,
        refresh: () => new Promise(resolve => { completeRefresh = resolve; }),
    } });
    const request = http.uploadXhr("/upload", { signal: controller.signal, xhrFactory: createXhrFactory([{ status: 400 }], created) });
    await new Promise(resolve => setImmediate(resolve));
    created[0].abort = () => {};
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    completeRefresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(created.length, 1);
});

test("upload retry is bounded and refresh failures propagate", async () => {
    const created = [];
    let refreshes = 0;
    const http = installHttpRuntime({ csrf: { isFailure: () => true, refresh: async () => { refreshes += 1; } } });
    const result = await http.uploadXhr("/upload", { xhrFactory: createXhrFactory([{ status: 400 }, { status: 400 }], created) });
    assert.equal(result.status, 400);
    assert.equal(refreshes, 1);
    assert.equal(created.length, 2);
    const failure = new Error("Refresh unavailable");
    const broken = installHttpRuntime({ csrf: { isFailure: () => true, refresh: async () => { throw failure; } } });
    await assert.rejects(broken.uploadXhr("/upload", { xhrFactory: createXhrFactory([{ status: 400 }], []) }), error => error === failure);
});
