import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    buildCalendarExtension,
    validateCalendarExtensionOutput,
    validateCalendarExtensionSourceGraph,
} from "../../static/js/calendar/build-extension.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function importCalendarExtensionModules() {
    const moduleRoot = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-modules-"));
    await writeFile(path.join(moduleRoot, "package.json"), '{"type":"module"}\n');
    await cp(path.join(repoRoot, "static/js/calendar/capabilities.js"), path.join(moduleRoot, "capabilities.js"));
    await cp(path.join(repoRoot, "static/js/calendar/extension-ui.js"), path.join(moduleRoot, "extension-ui.js"));
    await cp(path.join(repoRoot, "static/js/calendar/adapter.js"), path.join(moduleRoot, "adapter.js"));
    const [capabilities, extensionUi, adapter] = await Promise.all([
        import(pathToFileURL(path.join(moduleRoot, "capabilities.js")).href),
        import(pathToFileURL(path.join(moduleRoot, "extension-ui.js")).href),
        import(pathToFileURL(path.join(moduleRoot, "adapter.js")).href),
    ]);
    return { adapter, capabilities, extensionUi, moduleRoot };
}

function canvasData(writebacks = []) {
    return {
        source: {
            label: "BIO Canvas",
            accountLabel: "BIO Canvas",
            sourceId: "source-1",
            url: "https://canvas.example.edu",
        },
        completion: { status: "completed", source: "canvas" },
        routing: {
            state: "completed",
            destination: "local:completed",
            degraded: true,
            displayOverride: true,
        },
        writebacks,
        firstEvent: { event_ref: "canvas:source-1:event-1", source_id: "source-1", calendar_id: "local:completed" },
    };
}

test("calendar capabilities default safely, gate mutations, and preserve safe open-source access in read-only mode", async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const { normalizeCalendarCapabilities, getSafeCanvasSourceUrl, getCalendarCapabilityData } = modules.capabilities;
        assert.deepEqual(normalizeCalendarCapabilities({}).actions, {
            routeDisplayOverride: false,
            retryWriteback: false,
            openSourceUrl: false,
        });
        assert.equal(normalizeCalendarCapabilities({ contractVersion: 99, actions: {
            routeDisplayOverride: true, retryWriteback: true, openSourceUrl: true,
        }}).supported, false);
        assert.deepEqual(normalizeCalendarCapabilities({ readOnly: true, actions: {
            routeDisplayOverride: true, retryWriteback: true, openSourceUrl: true,
        }}).actions, {
            routeDisplayOverride: false,
            retryWriteback: false,
            openSourceUrl: true,
        });
        assert.equal(getSafeCanvasSourceUrl("https://canvas.example.edu"), "https://canvas.example.edu");
        for (const unsafe of [
            "http://canvas.example.edu",
            "https://canvas.example.edu/courses/1",
            "https://user:secret@canvas.example.edu",
            "https://canvas.example.edu?token=secret",
            "javascript:alert(1)",
        ]) assert.equal(getSafeCanvasSourceUrl(unsafe), null, unsafe);

        const stateValues = [
            "waiting_for_canvas_session", "queued", "applied", "unsupported",
            "forbidden", "conflict", "retryable_failed", "cancelled",
        ];
        const normalizedData = getCalendarCapabilityData({ data: { writebacks: stateValues.map((state) => ({ state })) } });
        assert.deepEqual(normalizedData.writebacks.map((item) => item.state), stateValues);
    } finally {
        await rm(modules.moduleRoot, { recursive: true, force: true });
    }
});

test("calendar extension UI is root-scoped, accessible, state-complete, and lifecycle-cleaned", async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const { createCalendarExtensionUi, getCalendarExtensionActionAvailability } = modules.extensionUi;
        const panel = {
            innerHTML: "",
            listeners: new Map(),
            setAttribute() {},
            addEventListener(type, listener) { this.listeners.set(type, listener); },
            remove() { this.removed = true; },
        };
        const root = {
            ownerDocument: { createElement() { return panel; } },
            querySelector() { return null; },
            appendChild(node) { this.child = node; },
        };
        const cleanup = [];
        const lifecycle = {
            addEventListener(target, type, listener) { target.addEventListener(type, listener); },
            addCleanup(callback) { cleanup.push(callback); },
            trackNode(node) { cleanup.push(() => node.remove()); },
        };
        const data = canvasData([
            { state: "waiting_for_canvas_session" },
            { state: "queued" },
            { state: "applied" },
            { state: "unsupported" },
            { state: "forbidden" },
            { state: "conflict" },
            { state: "retryable_failed", error_message: "try again" },
            { state: "cancelled" },
        ]);
        const adapter = {
            setCanvasRouting() {},
            retryWriteback() {},
            openSafeSourceUrl() {},
            actionSupport: { retryWriteback: true },
        };
        const capabilities = {
            contractVersion: 1,
            readOnly: false,
            actions: { routeDisplayOverride: true, retryWriteback: true, openSourceUrl: true },
            data,
        };
        const ui = createCalendarExtensionUi({
            root,
            state: { events: [] },
            adapter,
            capabilities,
            lifecycle,
        });
        assert.equal(root.child, panel);
        for (const label of [
            "BIO Canvas", "Account:", "Completed", "Canvas reported", "Routing", "Degraded",
            "Waiting for Canvas session", "Queued", "Applied", "Unsupported", "Forbidden",
            "Conflict", "Retryable failure", "Cancelled", "aria-live",
        ]) assert.match(panel.innerHTML, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(panel.innerHTML, /data-calendar-extension-action="route-display"/);
        assert.match(panel.innerHTML, /data-calendar-extension-action="retry-writeback:6"/);

        const availability = getCalendarExtensionActionAvailability({ capabilities, adapter, data });
        assert.equal(availability.routeEnabled, true);
        assert.equal(availability.retryEnabled, true);
        assert.equal(availability.openSourceEnabled, true);

        const readOnlyPanel = { ...panel, listeners: new Map(), removed: false };
        const readOnlyUi = createCalendarExtensionUi({
            root: {
                ownerDocument: { createElement() { return readOnlyPanel; } },
                querySelector() { return null; },
                appendChild(node) { this.child = node; },
            },
            state: { events: [] },
            adapter,
            capabilities: {
                contractVersion: 1,
                readOnly: true,
                actions: { routeDisplayOverride: true, retryWriteback: true, openSourceUrl: true },
                data,
            },
            lifecycle,
        });
        assert.equal(readOnlyUi.render instanceof Function, true);
        assert.doesNotMatch(readOnlyPanel.innerHTML, /route-display|display-override|retry-writeback/);
        assert.match(readOnlyPanel.innerHTML, /data-calendar-extension-action="open-source"/);
        ui.dispose();
        assert.equal(panel.removed, true);
        for (const callback of cleanup) callback();
    } finally {
        await rm(modules.moduleRoot, { recursive: true, force: true });
    }
});

test("calendar extension dispatch revalidates read-only state and the exact action capability", async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const cases = [
            { readOnly: "true", actions: { routeDisplayOverride: true } },
            { readOnly: "false", actions: { routeDisplayOverride: true } },
            { readOnly: undefined, actions: { routeDisplayOverride: true } },
            { readOnly: { malformed: true }, actions: { routeDisplayOverride: true } },
            { readOnly: false, actions: { routeDisplayOverride: false, retryWriteback: true } },
            { readOnly: false, actions: { routeDisplayOverride: "true" } },
            { readOnly: false, actions: { routeDisplayOverride: true }, expectedCalls: 1 },
        ];
        for (const testCase of cases) {
            const listeners = new Map();
            const panel = {
                innerHTML: "",
                listeners,
                setAttribute() {},
                addEventListener(type, listener) { listeners.set(type, listener); },
                removeEventListener(type, listener) {
                    if (listeners.get(type) === listener) listeners.delete(type);
                },
                remove() {},
            };
            const root = {
                ownerDocument: { createElement() { return panel; } },
                querySelector() { return null; },
                appendChild() {},
            };
            let routeCalls = 0;
            const ui = modules.extensionUi.createCalendarExtensionUi({
                root,
                state: { events: [] },
                adapter: { setCanvasRouting: async () => { routeCalls += 1; return { ok: true }; } },
                capabilities: {
                    contractVersion: 1,
                    readOnly: testCase.readOnly,
                    actions: testCase.actions,
                    data: canvasData(),
                },
            });
            const clickHandler = listeners.get("click");
            clickHandler({
                target: { closest: () => ({
                    disabled: false,
                    getAttribute: () => "route-display",
                }) },
                preventDefault() {},
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(routeCalls, testCase.expectedCalls || 0, JSON.stringify(testCase));
            ui.dispose();
        }
    } finally {
        await rm(modules.moduleRoot, { recursive: true, force: true });
    }
});

test("calendar extension removes the exact reused-panel listener across repeated mount and dispose", async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const listeners = new Set();
        const panel = {
            innerHTML: "",
            setAttribute() {},
            addEventListener(type, listener) {
                if (type === "click") listeners.add(listener);
            },
            removeEventListener(type, listener) {
                if (type === "click") listeners.delete(listener);
            },
            remove() {},
        };
        const root = {
            ownerDocument: { createElement() { return panel; } },
            querySelector() { return panel; },
            appendChild() {},
        };
        let routeCalls = 0;
        const adapter = {
            setCanvasRouting: async () => { routeCalls += 1; return { ok: true }; },
        };
        const capabilities = {
            contractVersion: 1,
            readOnly: false,
            actions: { routeDisplayOverride: true },
            data: canvasData(),
        };
        const firstUi = modules.extensionUi.createCalendarExtensionUi({ root, state: { events: [] }, adapter, capabilities });
        assert.equal(listeners.size, 1);
        firstUi.dispose();
        firstUi.dispose();
        assert.equal(listeners.size, 0);

        const secondUi = modules.extensionUi.createCalendarExtensionUi({ root, state: { events: [] }, adapter, capabilities });
        assert.equal(listeners.size, 1);
        for (const listener of listeners) listener({
            target: { closest: () => ({ disabled: false, getAttribute: () => "route-display" }) },
            preventDefault() {},
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(routeCalls, 1);
        secondUi.dispose();
        assert.equal(listeners.size, 0);
        for (const listener of listeners) listener({
            target: { closest: () => ({ disabled: false, getAttribute: () => "route-display" }) },
            preventDefault() {},
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(routeCalls, 1);
    } finally {
        await rm(modules.moduleRoot, { recursive: true, force: true });
    }
});

test("calendar adapter calls only versioned routing/override/open contracts and leaves retry unsupported", async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const calls = [];
        const runtimeWindow = {
            open(url, target, features) { calls.push({ type: "open", url, target, features }); return {}; },
        };
        const adapter = modules.adapter.createCalendarDataAdapter({
            window: runtimeWindow,
            fetch: async (url, options) => {
                calls.push({ type: "fetch", url, options });
                return { ok: true, json: async () => ({ ok: true }) };
            },
        });
        await adapter.setCanvasRouting({ sourceId: "source-1", state: "completed", destinationCalendarId: "local:done" });
        assert.equal(calls[0].url, "/api/extension/calendar/sources/source-1/routing");
        assert.equal(calls[0].options.method, "PUT");
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            state: "completed", destination_calendar_id: "local:done", fallback_calendar_id: null,
        });
        await adapter.setDisplayOverride({ eventRef: "canvas:event-1", calendarId: "local:done" });
        assert.equal(calls[1].url, "/api/calendar/event-overrides");
        await adapter.openSafeSourceUrl({ url: "https://canvas.example.edu" });
        assert.deepEqual(calls[2], {
            type: "open", url: "https://canvas.example.edu", target: "_blank", features: "noopener,noreferrer",
        });
        const unsafe = await adapter.openSafeSourceUrl({ url: "https://canvas.example.edu/path?token=secret" });
        assert.equal(unsafe.state, "unsupported");
        assert.equal(adapter.actionSupport.retryWriteback, false);
        assert.equal((await adapter.retryWriteback()).state, "unsupported");
    } finally {
        await rm(modules.moduleRoot, { recursive: true, force: true });
    }
});

test("calendar extension artifact is manifest-hashed, local-only, scoped, secure, and reproducible", async () => {
    const firstDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-build-"));
    const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-build-"));
    const filenames = ["calendar-extension.v1.js", "calendar-extension.v1.css", "manifest.json"];
    try {
        await buildCalendarExtension(firstDirectory);
        await buildCalendarExtension(secondDirectory);
        for (const filename of filenames) {
            const first = await readFile(path.join(firstDirectory, filename));
            const second = await readFile(path.join(secondDirectory, filename));
            assert.deepEqual(first, second, `${filename} differs between identical builds`);
        }

        const manifest = JSON.parse(await readFile(path.join(firstDirectory, "manifest.json"), "utf8"));
        assert.equal(manifest.contract_version, 1);
        assert.deepEqual(manifest.files.map(({ filename }) => filename), filenames.slice(0, 2));
        for (const { filename, sha256 } of manifest.files) {
            const bytes = await readFile(path.join(firstDirectory, filename));
            assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, filename);
        }
        const javascript = await readFile(path.join(firstDirectory, manifest.entry), "utf8");
        const stylesheet = await readFile(path.join(firstDirectory, manifest.stylesheet), "utf8");
        assert.doesNotMatch(javascript, /(?:from|import)\s*["']https?:\/\//);
        assert.doesNotMatch(javascript, /\beval\s*\(|new Function\s*\(/);
        assert.doesNotMatch(stylesheet, /@import\b|url\(\s*["']?(?:https?:|\/\/|data:|javascript:)/i);
        assert.doesNotMatch(stylesheet, /(?:^|[,{])\s*(?:html|body|:root|\.thenav|\.thefooter)\b/m);
        assert.match(javascript, /APStudyCalendarExtension/);
        assert.match(javascript, /contractVersion/);
    } finally {
        await rm(firstDirectory, { recursive: true, force: true });
        await rm(secondDirectory, { recursive: true, force: true });
    }
});

test("calendar extension build policy rejects remote executable imports before publication", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-policy-"));
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-build-"));
    const fixtureEntry = path.join(fixtureDirectory, "entry.js");
    const sentinelPath = path.join(outputDirectory, "sentinel.txt");
    try {
        await writeFile(fixtureEntry, 'import "https://evil.example/remote.js";\n');
        await writeFile(sentinelPath, "previous trusted output\n");
        await assert.rejects(
            buildCalendarExtension(outputDirectory, { entry: fixtureEntry }),
            /remote executable import/,
        );
        assert.equal(await readFile(sentinelPath, "utf8"), "previous trusted output\n");
        await assert.rejects(validateCalendarExtensionSourceGraph(fixtureEntry), /remote executable import/);
    } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
        await rm(outputDirectory, { recursive: true, force: true });
    }
});

test("calendar extension build policy rejects dynamic-code call variants without replacing published artifacts", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-policy-"));
    const publishedDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-build-"));
    const stagedOutputDirectory = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-extension-build-"));
    const fixtureEntry = path.join(fixtureDirectory, "entry.js");
    const sentinelPath = path.join(publishedDirectory, "sentinel.txt");
    const unsafeFixtures = [
        { label: "direct eval", source: 'eval("payload");\n', error: /forbidden eval call/ },
        { label: "optional eval", source: 'eval?.("payload");\n', error: /forbidden eval call/ },
        { label: "commented eval", source: 'eval /* comment */ ("payload");\n', error: /forbidden eval call/ },
        { label: "spaced optional eval", source: 'eval /* before */ ?. /* after */ ("payload");\n', error: /forbidden eval call/ },
        { label: "direct Function", source: 'Function("return 1");\n', error: /forbidden Function constructor call/ },
        { label: "optional Function", source: 'Function?.("return 1");\n', error: /forbidden Function constructor call/ },
        { label: "commented Function", source: 'Function /* comment */ ("return 1");\n', error: /forbidden Function constructor call/ },
        { label: "new Function", source: 'new Function("return 1");\n', error: /forbidden Function constructor call/ },
        {
            label: "spaced commented new Function",
            source: 'new /* before */ Function /* after */ (\n    "return 1"\n);\n',
            error: /forbidden Function constructor call/,
        },
    ];
    const safeNearMisses = `
        const evaluate = (value) => value;
        function FunctionLabel() { return "safe"; }
        const labels = {
            eval() { return "safe"; },
            Function() { return "safe"; },
        };
        evaluate("safe");
        FunctionLabel();
        labels.eval();
        labels.Function();
    `;
    try {
        await writeFile(sentinelPath, "previous trusted output\n");
        await writeFile(path.join(stagedOutputDirectory, "calendar-extension.v1.css"), "", "utf8");
        for (const fixture of unsafeFixtures) {
            await writeFile(fixtureEntry, fixture.source, "utf8");
            await assert.rejects(
                validateCalendarExtensionSourceGraph(fixtureEntry),
                fixture.error,
                `${fixture.label} passed source-graph validation`,
            );
            await assert.rejects(
                buildCalendarExtension(publishedDirectory, { entry: fixtureEntry }),
                fixture.error,
                `${fixture.label} build was not rejected`,
            );
            assert.equal(
                await readFile(sentinelPath, "utf8"),
                "previous trusted output\n",
                `${fixture.label} replaced published artifacts`,
            );

            await writeFile(
                path.join(stagedOutputDirectory, "calendar-extension.v1.js"),
                fixture.source,
                "utf8",
            );
            await assert.rejects(
                validateCalendarExtensionOutput(stagedOutputDirectory),
                fixture.error,
                `${fixture.label} passed staged-output validation`,
            );
        }

        await writeFile(fixtureEntry, safeNearMisses, "utf8");
        await validateCalendarExtensionSourceGraph(fixtureEntry);
        await writeFile(
            path.join(stagedOutputDirectory, "calendar-extension.v1.js"),
            safeNearMisses,
            "utf8",
        );
        await validateCalendarExtensionOutput(stagedOutputDirectory);
    } finally {
        await rm(fixtureDirectory, { recursive: true, force: true });
        await rm(publishedDirectory, { recursive: true, force: true });
        await rm(stagedOutputDirectory, { recursive: true, force: true });
    }
});

test('HTTP calendar adapter operations expose one envelope, including bodyless writes and course status', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const calls = [];
        const adapter = modules.adapter.createCalendarDataAdapter({ fetch: async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 200, json: async () => ({ terms: ['Fall'], sections: [], marker: 'payload' }) };
        } });
        const options = { shareId: 'one', action: 'save', sourceId: 'one', eventId: 'one', eventRef: 'user:one', payload: { marker: 'request-data' }, sectionIds: ['one'] };
        for (const method of ['loadRange', 'loadMirrors', 'changeMirror', 'loadPreferences', 'savePreferences', 'refresh', 'loadShares', 'saveShare', 'createEvent', 'updateEvent', 'overrideEvent', 'deleteEvent', 'hideEvent', 'saveSource', 'loadCourses', 'loadCourseSectionsById', 'loadSavedCourses', 'setCanvasRouting', 'setDisplayOverride']) {
            const result = await adapter[method](options);
            assert.equal(result.ok, true, method);
            assert.equal(result.response.status, 200, method);
            assert.equal(result.payload.marker, 'payload', method);
        }
        assert.ok(calls.length > 19);
        const preferenceWrite = calls.find(call => call.url === '/api/calendar/preferences/batch');
        assert.equal(preferenceWrite.options.method, 'POST');
        assert.deepEqual(JSON.parse(preferenceWrite.options.body), options.payload);
        const result = await adapter.loadCourses();
        assert.deepEqual(result.payload.terms, ['Fall']);
        assert.deepEqual(result.payload.sections, []);
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('HTTP error envelopes retain server detail, invalid successful JSON rejects, and bodyless operations succeed', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        let response = { ok: false, status: 422, json: async () => ({ error: 'Calendar is read-only' }) };
        const adapter = modules.adapter.createCalendarDataAdapter({ fetch: async () => response });
        const failed = await adapter.loadRange();
        assert.equal(failed.ok, false); assert.equal(failed.response.status, 422);
        assert.equal(failed.payload.error, 'Calendar is read-only');
        response = { ok: true, status: 200, json: async () => { throw SyntaxError('malformed'); } };
        await assert.rejects(adapter.loadRange(), /invalid JSON/);
        await assert.rejects(adapter.loadPreferences(), /invalid JSON/);
        response.status = 204;
        for (const method of ['refresh', 'deleteEvent', 'hideEvent']) {
            const result = await adapter[method]({ eventId: 'one', eventRef: 'user:one' });
            assert.equal(result.ok, true); assert.deepEqual(result.payload, {});
        }
        response.ok = false; response.status = 502;
        const failure = await adapter.createEvent({ payload: {} });
        assert.equal(failure.ok, false); assert.deepEqual(failure.payload, {});
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('safe source opening reports a request when noopener returns no window handle', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const opened = [];
        const adapter = modules.adapter.createCalendarDataAdapter({ window: { open(...args) { opened.push(args); return null; } } });
        assert.deepEqual(await adapter.openSafeSourceUrl({ url: 'https://canvas.example.edu/' }), { ok: true, state: 'requested', url: 'https://canvas.example.edu' });
        assert.deepEqual(opened, [['https://canvas.example.edu', '_blank', 'noopener,noreferrer']]);
        assert.equal((await adapter.openSafeSourceUrl({ url: 'https://canvas.example.edu/?token=secret' })).ok, false);
        assert.equal(opened.length, 1);
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('injected calendar providers normalize legacy results once and retain default undefined methods', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        let reads = 0;
        const response = { ok: true, status: 200, json: async () => { reads += 1; return { preferences: {} }; } };
        const fetches = [];
        const runtime = { fetch: async function (url) { assert.equal(this, runtime); fetches.push(url); return response; } };
        const adapter = modules.adapter.createCalendarDataAdapter({
            loadRange: async () => ({ events: [{ id: 'legacy' }] }),
            loadPreferences: async () => response,
            saveSource: async () => ({ response, payload: { source: 'injected' }, ok: false }),
            loadShares: undefined,
            fetch: undefined,
        }, { window: runtime });
        const again = modules.adapter.createCalendarDataAdapter(adapter, { window: runtime });
        assert.equal(again, adapter);
        const range = await adapter.loadRange();
        assert.equal(range.ok, true);
        assert.deepEqual(range.payload.events, [{ id: 'legacy' }]);
        assert.equal((await again.loadPreferences()).payload.preferences instanceof Object, true);
        assert.equal(reads, 1, 'a Response body is consumed once');
        const source = await adapter.saveSource();
        assert.equal(source.ok, false, 'an operation failure survives a successful HTTP status');
        assert.equal(source.response, response);
        assert.deepEqual(source.payload, { source: 'injected' });
        assert.equal(reads, 1, 'already decoded envelopes never re-read the Response');
        await adapter.loadShares();
        assert.deepEqual(fetches, ['/api/calendar/shares']);
        for (const value of [null, false, 0, 'invalid']) {
            assert.throws(() => modules.adapter.createCalendarDataAdapter({ loadRange: value }), /override must be a function/);
            assert.throws(() => modules.adapter.createCalendarDataAdapter({ fetch: value }), /override must be a function/);
        }
        await assert.rejects(modules.adapter.createCalendarDataAdapter({ loadShares: async () => ({ shares: [] }) }).loadShares(), /Response or HTTP result/);
        await assert.rejects(modules.adapter.createCalendarDataAdapter({ loadPreferences: async () => ({ response, payload: [] }) }).loadPreferences(), /object payload/);
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('legacy course response pairs preserve component errors and reject invalid decoded objects', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const termsResponse = { ok: false, status: 503, json: async () => ({ error: 'Terms unavailable' }) };
        const sectionsResponse = { ok: true, status: 200, json: async () => ({ sections: [{ id: 'one' }] }) };
        const adapter = modules.adapter.createCalendarDataAdapter({ loadCourses: async () => ({ termsResponse, sectionsResponse }) });
        const result = await adapter.loadCourses();
        assert.equal(result.ok, false);
        assert.equal(result.response, termsResponse);
        assert.equal(result.termsResponse, termsResponse);
        assert.equal(result.sectionsResponse, sectionsResponse);
        assert.deepEqual(result.payload, { error: 'Terms unavailable', sections: [{ id: 'one' }] });
        const invalid = modules.adapter.createCalendarDataAdapter({ loadCourses: async () => ({ termsResponse, sectionsResponse, termsPayload: [], sectionsPayload: {} }) });
        await assert.rejects(invalid.loadCourses(), /object payloads/);
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('public share requests encode their identity and retain range and cancellation options', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const requests = [];
        const adapter = modules.adapter.createCalendarDataAdapter({ fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 200, json: async () => ({ events: [] }) };
        } });
        const controller = new AbortController();
        const range = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
        await adapter.loadRange({ readOnly: true, shareCode: 'public/code?', range, signal: controller.signal });
        const url = new URL(requests[0].url, 'https://example.test');
        assert.equal(url.pathname, '/api/calendar/share/public%2Fcode%3F/events');
        assert.equal(url.searchParams.get('start'), range.start.toISOString());
        assert.equal(url.searchParams.get('end'), range.end.toISOString());
        assert.equal(requests[0].options.signal, controller.signal);
        await adapter.loadRange({ shareCode: 'ignored-for-private-view' });
        assert.equal(requests[1].url, '/api/calendar/events');
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('injected synchronous calendar actions always return promises and synchronous throws reject', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const accepted = { ok: true, state: 'requested' };
        const adapter = modules.adapter.createCalendarDataAdapter({
            openSafeSourceUrl() { return accepted; },
            retryWriteback() { throw Error('provider failed'); },
        });
        const opening = adapter.openSafeSourceUrl({ url: 'https://canvas.example.edu' });
        assert.equal(typeof opening.then, 'function'); assert.equal(await opening, accepted);
        let retry; assert.doesNotThrow(() => { retry = adapter.retryWriteback(); });
        assert.equal(typeof retry.catch, 'function'); await assert.rejects(retry, /provider failed/);
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('capability writebacks canonicalize legacy aliases and scalars while preserving provider detail', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const raw = { status: ' QUEUED ', event_ref: 'canvas:one', error_message: 'Provider detail' };
        const result = modules.capabilities.getCalendarCapabilityData({ data: { writebacks: [raw, { mirror_state: 'APPLIED' }, 'retryable_failed', null, { state: 'future_state' }] } }, [{ source_type: 'canvas', mirror_state: ' CONFLICT ' }]);
        assert.deepEqual(result.writebacks.map(item => item.state), ['queued', 'applied', 'retryable_failed', 'unsupported', 'unsupported', 'conflict']);
        assert.equal(result.writebacks[0].event_ref, raw.event_ref);
        assert.equal(result.writebacks[0].error_message, raw.error_message);
        assert.equal(raw.state, undefined);
        assert.equal(result.data.writebacks[0].state, 'queued');
        for (const supplied of [{ status: 'queued' }, 'applied']) {
            const canonical = modules.capabilities.getCalendarCapabilityData({ canvas: { writeback_state: supplied } });
            assert.equal(canonical.writebacks[0].state, typeof supplied === 'string' ? supplied : 'queued');
        }
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('native and shared calendars without Canvas data keep the integration panel hidden', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        for (const capabilities of [{ readOnly: false }, { readOnly: true, shareMode: true }, { readOnly: false, data: {} }]) {
            const panel = { hidden: false, innerHTML: '', setAttribute() {}, addEventListener() {}, remove() {} };
            const root = { ownerDocument: { createElement() { return panel; } }, querySelector() { return null; }, appendChild() {} };
            const normalized = modules.capabilities.normalizeCalendarCapabilities(capabilities);
            assert.deepEqual(normalized.data, {});
            assert.deepEqual(modules.capabilities.getCalendarCapabilityData(normalized).writebacks, []);
            const ui = modules.extensionUi.createCalendarExtensionUi({ root, state: { events: [{ id: 'native', source_type: 'user' }] }, adapter: {}, capabilities });
            assert.equal(panel.hidden, true); assert.equal(panel.innerHTML, '');
            ui.render(); assert.equal(panel.hidden, true); ui.dispose();
        }
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});

test('supplied Canvas writebacks retain a visible integration panel and canonical state labels', async () => {
    const modules = await importCalendarExtensionModules();
    try {
        const panel = { hidden: true, innerHTML: '', setAttribute() {}, addEventListener() {}, remove() {} };
        const root = { ownerDocument: { createElement() { return panel; } }, querySelector() { return null; }, appendChild() {} };
        const ui = modules.extensionUi.createCalendarExtensionUi({ root, state: { events: [] }, adapter: {}, capabilities: { readOnly: false, data: { writebackStates: [{ status: 'queued', event_ref: 'canvas:one' }] } } });
        assert.equal(panel.hidden, false); assert.match(panel.innerHTML, /Queued/);
        ui.dispose();
    } finally { await rm(modules.moduleRoot, { recursive: true, force: true }); }
});
