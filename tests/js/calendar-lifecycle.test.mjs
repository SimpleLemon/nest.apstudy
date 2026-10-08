import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function createBrowserRuntime() {
    const listeners = new Map();
    const removals = [];
    const listen = (target, type, listener, options) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add({ target, listener, options });
    };
    const remove = (target, type, listener) => {
        for (const entry of listeners.get(type) || []) {
            if (entry.target === target && entry.listener === listener) listeners.get(type).delete(entry);
        }
        removals.push({ target, type, listener });
    };
    const view = {
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        cancelAnimationFrame: clearTimeout,
        matchMedia: () => ({ matches: false }),
        AbortController,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        innerWidth: 1280,
        innerHeight: 900,
        location: { href: "https://example.test/calendar", search: "" },
        history: { replaceState() {} },
        addEventListener(type, listener, options) {
            listen(view, type, listener, options);
        },
        removeEventListener(type, listener) {
            remove(view, type, listener);
        },
        dispatchEvent() {},
    };
    const document = {
        nodeType: 9,
        readyState: "loading",
        body: { dataset: {} },
        documentElement: { dataset: {} },
        defaultView: view,
        activeElement: null,
        addEventListener(type, listener, options) {
            listen(document, type, listener, options);
        },
        removeEventListener(type, listener) {
            remove(document, type, listener);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: () => ({
            style: {},
            dataset: {},
            classList: { add() {}, remove() {}, toggle() {} },
            appendChild() {},
            remove() {},
            setAttribute() {},
            addEventListener() {},
            removeEventListener() {},
        }),
    };
    view.document = document;
    view.window = view;
    return { document, listeners, removals, view };
}

async function importCalendarGraph(runtime) {
    const moduleRoot = await mkdtemp(path.join(os.tmpdir(), "apstudy-calendar-esm-"));
    await writeFile(path.join(moduleRoot, "package.json"), '{"type":"module"}\n');
    await cp(
        path.join(repoRoot, "static/js/calendar"),
        path.join(moduleRoot, "static/js/calendar"),
        { recursive: true },
    );
    await cp(
        path.join(repoRoot, "static/js/courses"),
        path.join(moduleRoot, "static/js/courses"),
        { recursive: true },
    );
    await cp(
        path.join(repoRoot, "static/js/core/escaping.js"),
        path.join(moduleRoot, "static/js/core/escaping.js"),
    );
    await cp(
        path.join(repoRoot, "static/js/core/ui-primitives-module.js"),
        path.join(moduleRoot, "static/js/core/ui-primitives-module.js"),
    );
    globalThis.window = runtime.view;
    globalThis.document = runtime.document;
    const manifest = JSON.parse(await readFile(path.join(moduleRoot, "static/js/calendar/manifest.json"), "utf8"));
    const importFile = (relativePath) => import(`${pathToFileURL(path.join(moduleRoot, relativePath)).href}?v=${manifest.version}`);
    const [entry, index, adapter, lifecycle] = await Promise.all([
        importFile("static/js/calendar/entry.js"),
        importFile("static/js/calendar/index.js"),
        importFile("static/js/calendar/adapter.js"),
        importFile("static/js/calendar/lifecycle.js"),
    ]);
    return { adapter, entry, index, lifecycle, moduleRoot };
}

function createElementRoot(document, pageRoot) {
    return {
        nodeType: 1,
        ownerDocument: document,
        closest: (selector) => selector === "#calendar-app-root" ? pageRoot : null,
        querySelector: () => null,
        appendChild() {},
    };
}

test("the actual calendar ESM graph exposes contracts, mounts once, and disposes idempotently", async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        assert.equal(typeof graph.entry.bootCalendar, "function");
        assert.equal(typeof graph.index.mountCalendar, "function");
        assert.equal(typeof graph.adapter.createCalendarDataAdapter, "function");
        assert.equal(typeof graph.lifecycle.createCalendarLifecycle, "function");
        assert.equal(runtime.view.APStudyCalendarAdapter, undefined);
        assert.equal(runtime.view.APStudyCalendarLifecycle, undefined);

        const adapter = graph.adapter.createCalendarDataAdapter({
            fetch: async (url) => ({ ok: true, json: async () => ({ url }) }),
        });
        const result = await adapter.loadRange({
            range: { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z") },
        });
        assert.equal(result.ok, true);
        assert.match(result.payload.url, /^\/api\/calendar\/events\?/);

        runtime.view.APStudyCalendarState = { createCalendarState() { throw new Error("Global factory must not be used"); } };
        runtime.view.APStudyCalendarDataAdapter = { createEvent() { throw new Error("Global adapter must not be used"); } };
        const pageRoot = { nodeType: 1, ownerDocument: runtime.document, querySelector: () => null };
        const root = createElementRoot(runtime.document, pageRoot);
        const domReadyBeforeMount = runtime.listeners.get("DOMContentLoaded")?.size || 0;
        const first = graph.entry.bootCalendar(root, {
            adapterOverrides: { fetch: runtime.view.fetch, window: runtime.view },
        });
        const mountedListeners = runtime.listeners.get("DOMContentLoaded")?.size || 0;
        assert.equal(mountedListeners, domReadyBeforeMount + 1);

        const second = graph.entry.bootCalendar(root, {
            adapterOverrides: { fetch: runtime.view.fetch, window: runtime.view },
        });
        assert.equal(runtime.listeners.get("DOMContentLoaded")?.size || 0, mountedListeners);
        first();
        assert.equal(runtime.listeners.get("DOMContentLoaded")?.size || 0, mountedListeners);
        second();
        assert.equal(runtime.listeners.get("DOMContentLoaded")?.size || 0, domReadyBeforeMount);
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test("lifecycle cleanup remains idempotent and missing roots fail safely", async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        const target = {
            addEventListener() {},
            removeEventListener() { target.removed = true; },
            removed: false,
        };
        const node = { removeCalls: 0, remove() { this.removeCalls += 1; } };
        const observer = { disconnectCalls: 0, disconnect() { this.disconnectCalls += 1; } };
        const controller = lifecycle.trackAbortController();
        lifecycle.addEventListener(target, "change", () => {});
        lifecycle.trackObserver(observer);
        lifecycle.trackNode(node);
        lifecycle.dispose();
        lifecycle.dispose();

        assert.equal(controller.signal.aborted, true);
        assert.equal(target.removed, true);
        assert.equal(observer.disconnectCalls, 1);
        assert.equal(node.removeCalls, 1);
        assert.doesNotThrow(() => graph.index.mountCalendar(null, {}, {}));
        assert.doesNotThrow(() => graph.entry.bootCalendar(null));
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test("normal and share templates use the module entry and explicit Element app root", async () => {
    const [calendar, share] = await Promise.all([
        readFile(path.join(repoRoot, "templates/calendar.html"), "utf8"),
        readFile(path.join(repoRoot, "templates/calendar_share.html"), "utf8"),
    ]);
    for (const template of [calendar, share]) {
        assert.match(template, /<script type="module" src="\{\{ url_for\('static', filename='js\/calendar\/entry\.js', v=calendar_asset_version\) \}\}"><\/script>/);
        assert.match(template, /id="calendar-app-root"[\s\S]*id="calendar-view-root"/);
        assert.ok(template.indexOf('id="calendar-app-root"') < template.indexOf('id="calendar-view-root"'));
    }
    assert.doesNotMatch(share, /<script[^>]+src="[^\"]*calendar\/index\.js"[^>]*defer/);
});

test("event forms and menus use their mounted calendar interface and dispose their dialogs", async () => {
    const runtime = createBrowserRuntime();
    const nodes = [];
    runtime.document.body.appendChild = node => nodes.push(node);
    runtime.document.createElement = () => {
        const form = { querySelector: () => ({ focus() {} }) };
        const error = { textContent: "", classList: { add() {}, remove() {} } };
        const node = {
            style: {}, hidden: true, setAttribute() {}, removeAttribute() {},
            addEventListener() {}, querySelector: selector => selector === "form" ? form : error,
            remove() { const index = nodes.indexOf(node); if (index >= 0) nodes.splice(index, 1); },
        };
        let html = null;
        Object.defineProperty(node, "innerHTML", { get: () => html ?? node.textContent ?? "", set: value => { html = value; } });
        return node;
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const manifest = JSON.parse(await readFile(path.join(graph.moduleRoot, "static/js/calendar/manifest.json"), "utf8"));
        const load = file => import(`${pathToFileURL(path.join(graph.moduleRoot, `static/js/calendar/events/${file}`)).href}?v=${manifest.version}`);
        const [{ createCalendarEventForm }, { createCalendarEventMenu }] = await Promise.all([load("event-form.js"), load("context-menu.js")]);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        const calls = [];
        const event = { id: "one", event_ref: "user:one", calendar_id: "local:one", title: "Office hours", start: "2026-10-02T10:00:00Z", end: "2026-10-02T11:00:00Z" };
        runtime.view.getCalendarOptionsForEventForm = () => { throw new Error("Global calendars must not be used"); };
        runtime.view.openCalendarEventForm = () => { throw new Error("Global form must not be used"); };
        const forms = ["one", "two"].map(id => createCalendarEventForm({
            document: runtime.document, view: runtime.view, lifecycle, adapter: {}, reload() {}, canCreate: () => true,
            calendars: {
                getCalendarOptions: () => [{ id: `local:${id}`, label: id }],
                getDefaultCalendarId: () => `local:${id}`,
                getCalendarColor: () => "#0ea5e9", getStandardColors: () => ["#0ea5e9"],
            },
        }));
        const menu = createCalendarEventMenu({
            root: {}, document: runtime.document,
            view: runtime.view, lifecycle, adapter: {}, state: { public: { readOnly: true } }, mirrors: {},
            getCalendarEventByRef: () => event, openEventForm: options => { calls.push(options); forms[0].open(options); },
            goToToday() {}, reload() {},
        });
        assert.equal(menu.activateEvent(event), true);
        assert.equal(calls[0].mode, "view");
        assert.match(nodes[0].innerHTML, /<select name="calendar_id" disabled>/);
        assert.match(nodes[0].innerHTML, /value="local:one" selected/);
        forms[1].open({ mode: "create" });
        assert.equal(nodes.length, 2);
        assert.match(nodes[1].innerHTML, /value="local:two" selected/);
        assert.doesNotMatch(nodes[1].innerHTML, /<select name="calendar_id" disabled>/);
        lifecycle.dispose();
        assert.equal(nodes.length, 0);
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('released listeners, observers, frames, timers and controllers are absent from later disposal', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const timerCallbacks = new Map();
        const frameCallbacks = new Map();
        const cleared = [], cancelled = [];
        let nextId = 0;
        const selectedView = {
            AbortController,
            setTimeout(callback) { const id = ++nextId; timerCallbacks.set(id, callback); return id; },
            clearTimeout(id) { cleared.push(id); timerCallbacks.delete(id); },
            requestAnimationFrame(callback) { const id = ++nextId; frameCallbacks.set(id, callback); return id; },
            cancelAnimationFrame(id) { cancelled.push(id); frameCallbacks.delete(id); },
        };
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: selectedView });
        let listenerRemovals = 0, disconnects = 0, cleanupCalls = 0, callbacks = 0;
        const unlisten = lifecycle.addEventListener({ addEventListener() {}, removeEventListener() { listenerRemovals += 1; } }, 'change', () => {});
        unlisten(); unlisten();
        const observer = { disconnect() { disconnects += 1; } };
        const releaseObserver = lifecycle.trackObserver(observer);
        assert.equal(lifecycle.trackObserver(observer), releaseObserver);
        releaseObserver(); releaseObserver();
        const releaseCleanup = lifecycle.addCleanup(() => { cleanupCalls += 1; });
        releaseCleanup(); releaseCleanup();
        const releasedController = lifecycle.trackAbortController();
        lifecycle.releaseAbortController(releasedController);
        const pendingController = lifecycle.trackAbortController();
        const cancelledFrame = lifecycle.requestAnimationFrame(() => { callbacks += 1; });
        lifecycle.cancelAnimationFrame(cancelledFrame);
        const completedFrame = lifecycle.requestAnimationFrame(() => { callbacks += 1; });
        frameCallbacks.get(completedFrame)();
        const completedTimer = lifecycle.setTimeout(() => { callbacks += 1; }, 100);
        timerCallbacks.get(completedTimer)();
        const pendingTimer = lifecycle.setTimeout(() => { callbacks += 1; }, 100);
        const pendingFrame = lifecycle.requestAnimationFrame(() => { callbacks += 1; });
        lifecycle.dispose(); lifecycle.dispose();
        assert.equal(releasedController.signal.aborted, false);
        assert.equal(pendingController.signal.aborted, true);
        assert.equal(listenerRemovals, 1);
        assert.equal(disconnects, 1);
        assert.equal(cleanupCalls, 1);
        assert.equal(callbacks, 2);
        assert.deepEqual(cleared, [pendingTimer]);
        assert.deepEqual(cancelled, [cancelledFrame, pendingFrame]);
        assert.equal(lifecycle.setTimeout(() => {}, 100), null);
        assert.equal(lifecycle.requestAnimationFrame(() => {}), null);
        assert.equal(lifecycle.trackAbortController().signal.aborted, true);
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('page boot selects the supplied runtime for its adapter, storage and abort services', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        runtime.view.fetch = () => { throw new Error('Owner-document fetch must not be used'); };
        const requests = [], storageReads = [], controllers = [];
        const selectedView = {
            ...runtime.view,
            localStorage: {
                getItem(key) { storageReads.push(key); return null; },
                setItem() {}, removeItem() {},
            },
            AbortController: class extends AbortController {
                constructor() { super(); controllers.push(this); }
            },
            fetch: async function (url, options) {
                assert.equal(this, selectedView);
                requests.push({ url, options });
                return { ok: true, status: 200, json: async () => url.includes('preferences') ? { preferences: {} } : { events: [], sources: [], feed_configured: false } };
            },
        };
        const pageRoot = { nodeType: 1, ownerDocument: runtime.document, querySelector: () => null, appendChild() {} };
        const root = createElementRoot(runtime.document, pageRoot);
        const dispose = graph.entry.bootCalendar(root, { window: selectedView });
        const readyListener = [...runtime.listeners.get('DOMContentLoaded')][0];
        await readyListener.listener();
        assert.ok(requests.some(request => request.url.startsWith('/api/calendar/events?')));
        assert.ok(requests.some(request => request.url === '/api/calendar/preferences'));
        assert.ok(storageReads.includes('calendarEventsCache'));
        assert.ok(controllers.length >= 2);
        assert.ok(requests.every(request => controllers.some(controller => controller.signal === request.options.signal)));
        dispose();
        assert.ok(controllers.every(controller => !controller.signal.aborted), 'completed requests were released before unmount');
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('disposing an open course dialog restores inherited background accessibility state', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCourseModalRenderer } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/integrations/course-modal.js')).href);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        function background(inert, ariaHidden) {
            return {
                isConnected: true, inert, ariaHidden,
                getAttribute() { return this.ariaHidden; },
                setAttribute(name, value) { this.ariaHidden = value; },
                removeAttribute() { this.ariaHidden = null; },
            };
        }
        const visible = background(false, null), inherited = background(true, 'false');
        const root = { nodeType: 1, ownerDocument: runtime.document, children: [visible, inherited], querySelector: () => null };
        const renderer = createCourseModalRenderer({ root, lifecycle, state: {}, escapeHtml: value => value });
        renderer.setCoursesModalBackgroundInert(true);
        renderer.setCoursesModalBackgroundInert(true);
        assert.equal(visible.inert, true);
        assert.equal(visible.ariaHidden, 'true');
        lifecycle.dispose();
        assert.equal(visible.inert, false);
        assert.equal(visible.ariaHidden, null);
        assert.equal(inherited.inert, true);
        assert.equal(inherited.ariaHidden, 'false');
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

function permissionDom(runtime) {
    const bodyNodes = [];
    const node = () => {
        const attributes = new Map();
        const result = {
            style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [], listeners: new Map(),
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) || null; }, removeAttribute() {},
            addEventListener(type, listener) { this.listeners.set(type, listener); },
            removeEventListener(type) { this.listeners.delete(type); },
            appendChild(child) { this.children.push(child); },
            querySelector(selector) {
                if (selector === 'form') return { querySelector: () => ({ focus() {} }) };
                if (selector === '#apstudy-event-error') return { classList: { add() {}, remove() {} } };
                if (selector === '[role=menuitem]') return this.children[0] || null;
                return null;
            },
            querySelectorAll(selector) { return selector === '[role=menuitem]' ? this.children : []; },
            getBoundingClientRect: () => ({ width: 190, height: 80 }), closest: () => null,
            focus() {}, remove() { const index = bodyNodes.indexOf(this); if (index >= 0) bodyNodes.splice(index, 1); },
        };
        let html = '';
        Object.defineProperty(result, 'innerHTML', { get: () => html, set: value => { html = value; result.children = []; } });
        return result;
    };
    runtime.document.createElement = node;
    runtime.document.body.appendChild = item => bodyNodes.push(item);
    runtime.view.crypto = globalThis.crypto;
    runtime.view.CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    const createButton = node();
    const viewRoot = node();
    const root = Object.assign(node(), {
        nodeType: 1, ownerDocument: runtime.document, contains: () => true,
        querySelector(selector) {
            if (selector === '#calendar-new-event') return createButton;
            if (selector === '#calendar-view-root') return viewRoot;
            return null;
        },
    });
    return { root, bodyNodes, createButton, node };
}

test('mounted raw permission flags deny Canvas actions and every native event mutation control', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const scenarios = [
            [{ readOnly: 'false', nestMutation: true }, false],
            [{ readOnly: 'true', nestMutation: true }, false],
            [{ readOnly: null, nestMutation: true }, false],
            [{ readOnly: undefined, nestMutation: true }, false],
            [{ readOnly: false, readOnlyValid: false, nestMutation: true }, false],
            [{ readOnly: false, shareModeValid: false, nestMutation: true }, false],
            [{ read_only: 'false', nestMutation: true }, false],
            [{ read_only: null, nestMutation: true }, false],
            [{ read_only: true, nestMutation: true }, false],
            [{ nestMutation: true }, false],
            [{ readOnly: false, shareMode: 'false', nestMutation: true }, false],
            [{ readOnly: false, shareMode: null, nestMutation: true }, false],
            [{ readOnly: false, contractVersion: 99, nestMutation: true }, false],
            [{ readOnly: false }, false],
            [{ readOnly: false, nestMutation: 'true' }, false],
            [{ readOnly: false, shareMode: true, nestMutation: true }, false],
            [{ readOnly: false, nestMutation: true, forcedShare: true }, false],
            [{ read_only: false, nestMutation: true }, true],
            [{ readOnly: false, nestMutation: true }, true],
        ];
        for (const [flags, allowed] of scenarios) {
            runtime.document.body.dataset.calendarReadonly = flags.forcedShare ? 'true' : 'false';
            const dom = permissionDom(runtime);
            let creates = 0, routes = 0;
            const dispose = graph.index.mountCalendar(dom.root, {
                loadRange: () => ({ events: [
                    { id: 'native', event_ref: 'event:native', title: 'Native', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' },
                    { id: 'imported', event_ref: 'feed:imported', title: 'Imported', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' },
                    { id: 'external:source', event_ref: 'external:source', source_type: 'external', editable: true, title: 'External', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' },
                ], sources: [] }),
                loadPreferences: () => ({ response: { ok: true }, payload: { preferences: [] } }),
                loadSavedCourses: () => ({ response: { ok: true }, payload: { courses: [] } }),
                createEvent: () => { creates++; return { response: { ok: true }, payload: {} }; },
                setCanvasRouting: () => { routes++; return { response: { ok: true }, payload: {} }; },
            }, {
                mode: 'overlay', ...flags,
                actions: { routeDisplayOverride: true },
                data: { source: { sourceId: 'source-1' }, routing: { state: 'completed', destination: 'local:personal' } },
            });
            await dispose.ready;
            const label = JSON.stringify(flags);
            assert.equal(dom.createButton.hidden, !allowed, label);
            dom.createButton.listeners.get('click')();
            assert.equal(dom.bodyNodes.some(item => item.className === 'calendar-event-modal'), allowed, label);
            // Empty space uses the actual registered context-menu handler.
            const day = { closest: selector => selector === '[data-date]' ? day : null, getAttribute: () => '2026-10-05' };
            dom.root.listeners.get('contextmenu')({ target: day, preventDefault() {}, clientX: 10, clientY: 10 });
            const menu = dom.bodyNodes.find(item => item.className === 'calendar-right-click-menu');
            const createItem = menu.children.find(item => item.innerHTML.includes('Create New Event'));
            assert.equal(Boolean(createItem), allowed, label);
            for (const ref of ['event:native', 'feed:imported']) {
                const target = { closest: selector => selector === '[data-event-ref], [data-event-id]' ? target : null,
                    getAttribute: name => name === 'data-event-ref' ? ref : null };
                dom.root.listeners.get('contextmenu')({ target, preventDefault() {}, clientX: 10, clientY: 10 });
                const labels = menu.children.map(item => item.innerHTML);
                assert.equal(labels.some(html => html.includes('View / Edit Event')), allowed, `${label} ${ref} edit`);
                assert.equal(labels.some(html => html.includes(ref.startsWith('feed:') ? 'Hide Imported Event' : 'Delete Event')), allowed, `${label} ${ref} delete`);
                assert.equal(labels.some(html => html.includes('Duplicate Event')), allowed, `${label} ${ref} duplicate`);
                dom.root.listeners.get('click')({ target });
                const modal = dom.bodyNodes.find(item => item.className === 'calendar-event-modal');
                assert.equal(modal.innerHTML.includes('<select name="calendar_id" disabled>'), !allowed, `${label} ${ref} activation`);
            }
            // Dispatch a synthetic enabled integration button to verify the mutation guard itself.
            const panel = dom.root.children.find(item => item.className === 'calendar-extension-status');
            const routeButton = { disabled: false, getAttribute: () => 'route-display' };
            panel.listeners.get('click')({ target: { closest: () => routeButton }, preventDefault() {} });
            await new Promise(resolve => setImmediate(resolve));
            const canvasAllowed = !flags.forcedShare && (flags.readOnly === false || flags.read_only === false)
                && flags.readOnlyValid !== false && flags.shareModeValid !== false
                && (flags.shareMode === undefined || flags.shareMode === false) && flags.contractVersion !== 99;
            assert.equal(routes, canvasAllowed ? 1 : 0, label);
            const externalTarget = { closest: selector => selector === '[data-event-ref], [data-event-id]' ? externalTarget : null,
                getAttribute: name => name === 'data-event-ref' ? 'external:source' : null };
            dom.root.listeners.get('contextmenu')({ target: externalTarget, preventDefault() {}, clientX: 10, clientY: 10 });
            assert.equal(menu.children.some(item => item.innerHTML.includes('Edit Event')), canvasAllowed, `${label} external source grant`);
            assert.equal(menu.children.some(item => item.innerHTML.includes('Delete Event')), canvasAllowed, `${label} external deletion grant`);
            assert.equal(creates, 0, 'opening controls does not save an event');
            dispose();
        }
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('direct create form fails closed and rechecks a revoked grant at submission', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCalendarEventForm } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/events/event-form.js')).href);
        const dom = permissionDom(runtime);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        let allowed = false, creates = 0;
        const options = {
            document: runtime.document, view: runtime.view, lifecycle,
            adapter: { createEvent: () => { creates++; return { response: { ok: true }, payload: {} }; } },
            calendars: { getCalendarOptions: () => [], getDefaultCalendarId: () => 'local:personal', getCalendarColor: () => '#123456', getStandardColors: () => [] },
            reload() {},
        };
        createCalendarEventForm(options).open({ mode: 'create' });
        assert.equal(dom.bodyNodes.length, 0, 'an absent create grant is denied');
        const form = createCalendarEventForm({ ...options, canCreate: () => allowed });
        form.open({ mode: 'create' });
        assert.equal(dom.bodyNodes.length, 0);
        allowed = true;
        form.open({ mode: 'create' });
        const modal = dom.bodyNodes[0];
        allowed = false;
        await modal.listeners.get('submit')({ target: { id: 'apstudy-event-form' }, preventDefault() {} });
        assert.equal(creates, 0, 'revoked create does not read fields or dispatch a mutation');
        allowed = true;
        runtime.view.APStudyDate = { localInputToIso: value => new Date(value).toISOString() };
        const fields = {
            id: 'apstudy-event-form', title: { value: 'Study group' }, description: { value: '' },
            start: { value: '2026-10-05T10:00:00Z' }, end: { value: '2026-10-05T11:00:00Z' },
            all_day: { checked: false }, reminder_minutes: { value: '10' }, calendar_id: { value: 'local:personal' },
            querySelector: () => ({ textContent: 'Save' }),
        };
        await modal.listeners.get('submit')({ target: fields, preventDefault() {} });
        assert.equal(creates, 1, 'restoring a valid grant permits the actual create mutation');
        lifecycle.dispose();
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('native host defaults only an absent permission flag and shared pages force read-only', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCalendarHost } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/host.js')).href);
        const dom = permissionDom(runtime);
        for (const [flags, allowed] of [
            [{}, true], [{ readOnly: false }, true], [{ read_only: false }, true],
            [{ readOnly: undefined }, false], [{ readOnly: null }, false], [{ readOnly: 'false' }, false],
            [{ read_only: undefined }, false], [{ read_only: null }, false], [{ read_only: true }, false],
            [{ readOnly: false, shareMode: null }, false],
        ]) {
            const host = createCalendarHost(dom.root, {}, flags);
            assert.equal(host.calendarCapabilities.canMutateNative, allowed, JSON.stringify(flags));
            host.lifecycle.dispose();
        }
        runtime.document.body.dataset.calendarReadonly = 'true';
        const shared = createCalendarHost(dom.root, {}, { readOnly: false, shareMode: false, actions: { routeDisplayOverride: true } });
        assert.equal(shared.calendarCapabilities.readOnly, true);
        assert.equal(shared.calendarCapabilities.shareMode, true);
        assert.equal(shared.calendarCapabilities.canMutateNative, false);
        assert.equal(shared.calendarCapabilities.actions.routeDisplayOverride, false);
        shared.lifecycle.dispose();
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('manual range refresh replaces point events at its lower boundary and keeps its upper boundary', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const [{ createCalendarData }, { createCalendarState }] = await Promise.all([
            import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/integrations/data.js')).href),
            import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/state.js')).href),
        ]);
        const state = createCalendarState({ defaultDashboardView: 'week', readOnly: false });
        const lower = '2026-10-05T00:00:00Z', upper = '2026-10-06T00:00:00Z';
        const old = [
            { id: 'point', title: 'Old point', start: lower, end: lower },
            { id: 'deleted', title: 'Deleted missing-end point', start: lower },
            { id: 'negative', title: 'Old negative event', start: lower, end: '2026-10-04T23:00:00Z' },
            { id: 'upper', title: 'Upper point', start: upper, end: upper },
            { id: 'before', title: 'Earlier point', start: '2026-10-04T00:00:00Z' },
        ];
        let refreshed = false;
        const noop = () => {};
        const api = createCalendarData({
            runtimeWindow: runtime.view, state, constants: { calendarBufferDays: 0 },
            dataAdapter: {
                loadRange: () => ({ events: refreshed ? [{ id: 'point', title: 'New point', start: lower }] : old }),
                refresh: () => { refreshed = true; return { response: { ok: true }, payload: {} }; },
            },
            getStartOfWeek: date => date, getEventCalendarKey: () => 'personal',
            buildSimulatedMeetingEvents: () => [], ensureSimulatedCalendarPreference: noop,
            hydrateSelectedSimulatedSections: noop, initCalendarState: noop, loadCalendarState: noop,
            queueCalendarPreferenceSave: noop, render: noop, writeCalendarStateToStorage: noop,
        });
        await api.ensureEventsForRange({ start: new Date('2026-10-04'), end: new Date('2026-10-07') });
        assert.equal(state.events.length, 5);
        await api.runManualRefresh({ start: new Date(lower), end: new Date(upper) });
        assert.deepEqual(state.events.map(event => event.id), ['before', 'point', 'upper']);
        assert.equal(state.events.find(event => event.id === 'point').title, 'New point');
        await api.runManualRefresh({ start: new Date(lower), end: new Date(upper) });
        assert.equal(state.events.filter(event => event.id === 'point').length, 1, 'repeating refresh cannot duplicate its boundary point');
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('context creation and duplication recheck grants when a previously rendered item is activated', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCalendarEventMenu } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/events/context-menu.js')).href);
        const dom = permissionDom(runtime);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        let allowed = true;
        const calls = [];
        const event = { id: 'simulated', source: 'simulated', title: 'Course', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' };
        const options = {
            root: dom.root, document: runtime.document, view: runtime.view, lifecycle, adapter: {},
            state: { public: { readOnly: false }, nativeEditable: true }, mirrors: { personalRef: () => null },
            getCalendarEventByRef: () => event, openEventForm: input => calls.push(input), goToToday() {}, reload() {},
        };
        const closedByDefault = createCalendarEventMenu(options);
        assert.deepEqual(closedByDefault.getEventMenuItems({ event, readOnly: false }).map(item => item.label), ['View Event']);
        const menu = createCalendarEventMenu({ ...options, canCreate: () => allowed });
        menu.register();
        const day = { closest: selector => selector === '[data-date]' ? day : null, getAttribute: () => '2026-10-05' };
        const openMenu = () => dom.root.listeners.get('contextmenu')({ target: day, preventDefault() {}, clientX: 10, clientY: 10 });
        openMenu();
        const element = dom.bodyNodes.find(item => item.className === 'calendar-right-click-menu');
        const create = element.children.find(item => item.innerHTML.includes('Create New Event'));
        const duplicate = menu.getEventMenuItems({ event, readOnly: false }).find(item => item.label === 'Duplicate Event');
        allowed = false;
        create.listeners.get('click')();
        duplicate.onClick({ event, readOnly: false });
        assert.equal(calls.length, 0, 'stale controls cannot create after permission revocation');
        assert.deepEqual(menu.getEventMenuItems({ event, readOnly: false }).map(item => item.label), ['View Event']);
        allowed = true;
        openMenu();
        element.children.find(item => item.innerHTML.includes('Create New Event')).listeners.get('click')();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].mode, 'create');
        assert.equal(calls[0].data.start, '2026-10-05T09:00:00');
        lifecycle.dispose();
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('direct native edit and override forms deny missing grants and recheck revoked grants at submit', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCalendarEventForm } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/events/event-form.js')).href);
        const dom = permissionDom(runtime);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        runtime.view.APStudyDate = { localInputToIso: value => new Date(value).toISOString() };
        const requests = [];
        let allowed = true;
        const options = {
            document: runtime.document, view: runtime.view, lifecycle,
            adapter: {
                updateEvent: input => { requests.push(['edit', input]); return { response: { ok: true }, payload: {} }; },
                overrideEvent: input => { requests.push(['override', input]); return { response: { ok: true }, payload: {} }; },
                createEvent: () => { throw new Error('Editing must never fall back to creation'); },
            },
            calendars: { getCalendarOptions: () => [], getDefaultCalendarId: () => 'local:personal', getCalendarColor: () => '#123456', getStandardColors: () => [] },
            reload() {},
        };
        const data = { id: 'native', event_ref: 'event:native', title: 'Study group', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' };
        for (const mode of ['edit', 'override']) {
            createCalendarEventForm(options).open({ mode, data });
            assert.equal(dom.bodyNodes.length, 0, `${mode} requires an explicit mutation predicate`);
            const form = createCalendarEventForm({ ...options, canMutateEvent: () => allowed });
            form.open({ mode, data });
            const modal = dom.bodyNodes[0];
            allowed = false;
            await modal.listeners.get('submit')({ target: { id: 'apstudy-event-form' }, preventDefault() {} });
            assert.equal(requests.length, mode === 'edit' ? 0 : 1, `${mode} revoked before submit dispatches no request`);
            allowed = true;
            const fields = {
                id: 'apstudy-event-form', title: { value: 'Study group' }, description: { value: '' },
                start: { value: data.start }, end: { value: data.end }, all_day: { checked: false },
                reminder_minutes: { value: '10' }, calendar_id: { value: 'local:personal' }, querySelector: () => ({ textContent: 'Save' }),
            };
            await modal.listeners.get('submit')({ target: fields, preventDefault() {} });
            assert.equal(requests.at(-1)[0], mode);
        }
        assert.equal(requests[0][1].eventId, 'native');
        assert.equal(requests[1][1].payload.event_ref, 'event:native');
        lifecycle.dispose();
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});

test('retained native edit/delete items and delayed confirmation/undo commit recheck mutation eligibility', async () => {
    const runtime = createBrowserRuntime();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const graph = await importCalendarGraph(runtime);
    try {
        const { createCalendarEventMenu } = await import(pathToFileURL(path.join(graph.moduleRoot, 'static/js/calendar/events/context-menu.js')).href);
        const dom = permissionDom(runtime);
        const lifecycle = graph.lifecycle.createCalendarLifecycle({ view: runtime.view });
        let allowed = true, confirm, staged, deletes = 0, hidden = 0;
        const calls = [];
        runtime.view.APStudyConfirm = { request: () => new Promise(resolve => { confirm = resolve; }) };
        runtime.view.APStudyUndo = { stage: input => { staged = input; } };
        const menu = createCalendarEventMenu({
            root: dom.root, document: runtime.document, view: runtime.view, lifecycle,
            adapter: {
                deleteEvent: () => { deletes++; return { response: { ok: true }, payload: {} }; },
                hideEvent: () => { hidden++; return { response: { ok: true }, payload: {} }; },
            },
            state: { public: { readOnly: false }, nativeEditable: true }, mirrors: { open: () => false },
            getCalendarEventByRef() {}, openEventForm: input => calls.push(input), goToToday() {}, reload() {},
            canMutateEvent: () => allowed, canCreate: () => allowed,
        });
        for (const ref of ['event:native', 'feed:imported']) {
            const event = { id: ref, event_ref: ref, title: 'Event' };
            const context = { event, readOnly: false };
            allowed = true;
            const items = menu.getEventMenuItems(context);
            const edit = items.find(item => item.label === 'View / Edit Event');
            const remove = items.find(item => item.danger);
            allowed = false;
            edit.onClick(context);
            await remove.onClick(context);
            assert.equal(calls.at(-1).mode, 'view', 'old edit control downgrades to view after revocation');
            assert.equal(confirm, undefined, 'old delete control cannot even begin confirmation');
            allowed = true;
            const confirming = remove.onClick(context);
            allowed = false;
            confirm(true); confirm = undefined;
            await confirming;
            assert.equal(staged, undefined, 'revocation during confirmation cannot stage deletion');
            allowed = true;
            const accepted = remove.onClick(context);
            confirm(true); confirm = undefined;
            await accepted;
            assert.equal(typeof staged.commit, 'function');
            allowed = false;
            await staged.commit(); staged = undefined;
            assert.equal(deletes, ref.startsWith('feed:') ? 1 : 0);
            assert.equal(hidden, 0, 'revocation before undo expiry cannot dispatch deletion/hide');
            allowed = true;
            const permitted = remove.onClick(context);
            confirm(true); confirm = undefined;
            await permitted;
            await staged.commit(); staged = undefined;
        }
        assert.equal(deletes, 1);
        assert.equal(hidden, 1);
        lifecycle.dispose();
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        await rm(graph.moduleRoot, { recursive: true, force: true });
    }
});
