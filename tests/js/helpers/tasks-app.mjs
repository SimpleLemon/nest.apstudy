import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const httpSource = await readFile(new URL("../../../static/js/core/http.js", import.meta.url), "utf8");
const dateTimeSource = await readFile(new URL("../../../static/js/core/date-time.js", import.meta.url), "utf8");

// Execute the production component and dependency graph with deterministic hook
// commits. Child UI rendering is kept as an element tree, so race tests can call
// the same callbacks TaskApp passes to its real sections and menus.
const moduleUrls = new Map();
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const reactUrl = dataUrl(`
    export const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
    export const Fragment = Symbol("Fragment");
    export class Component {}
    export const memo = (component) => component;
    export const useState = (...args) => globalThis.__taskHooks.useState(...args);
    export const useRef = (...args) => globalThis.__taskHooks.useRef(...args);
    export const useMemo = (...args) => globalThis.__taskHooks.useMemo(...args);
    export const useCallback = (callback, dependencies) => useMemo(() => callback, dependencies);
    export const useEffect = (...args) => globalThis.__taskHooks.useEffect(...args);
    export const useLayoutEffect = useEffect;
    export const useId = () => "task-test-id";
`);
const imports = {
    react: reactUrl,
    "react-dom": dataUrl("export const createPortal = (content) => content;"),
    "react-dom/client": dataUrl("export const createRoot = () => { throw new Error('Unexpected DOM mount in component test'); };"),
    sortablejs: dataUrl("export default { create() { throw new Error('Unexpected child UI rendering'); } };"),
};
async function taskModuleUrl(modulePath) {
    const key = modulePath.href;
    if (moduleUrls.has(key)) return moduleUrls.get(key);
    let source = await readFile(modulePath, "utf8");
    for (const match of [...source.matchAll(/\b(?:from|import)\s*(["'])(\.{1,2}\/[^"']+|react(?:-dom(?:\/client)?)?|sortablejs)\1/g)]) {
        const dependency = match[2];
        const url = dependency.startsWith(".") ? await taskModuleUrl(new URL(dependency, modulePath)) : imports[dependency];
        assert.ok(url, `Supported task dependency: ${dependency}`);
        source = source.replaceAll(match[0], match[0].replace(dependency, url));
    }
    const url = dataUrl(source);
    moduleUrls.set(key, url);
    return url;
}

export async function loadTaskModule(name) {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    // The real date definitions install their module exports on the browser's
    // window. Supply that environment for standalone component imports too.
    if (!originalWindow) globalThis.window = {};
    try {
        return await import(await taskModuleUrl(new URL(`../../../static/js/tasks/${name}`, import.meta.url)));
    } finally {
        if (!originalWindow) delete globalThis.window;
    }
}
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}
const equalDependencies = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

export function createHooks() {
    const slots = [];
    let index = 0;
    let dirty = true;
    let effects = [];
    return {
        begin() { index = 0; dirty = false; effects = []; },
        get dirty() { return dirty; },
        useState(initial) {
            const slot = slots[index++] ||= { value: typeof initial === "function" ? initial() : initial, queue: [] };
            for (const update of slot.queue.splice(0)) slot.value = typeof update === "function" ? update(slot.value) : update;
            slot.set ||= (update) => { slot.queue.push(update); dirty = true; };
            return [slot.value, slot.set];
        },
        useRef(initial) { return slots[index++] ||= { current: initial }; },
        useMemo(factory, dependencies) {
            const slot = slots[index++] ||= {};
            if (!equalDependencies(slot.dependencies, dependencies)) {
                slot.value = factory(); slot.dependencies = dependencies;
            }
            return slot.value;
        },
        useEffect(callback, dependencies) {
            const slot = slots[index++] ||= {};
            if (equalDependencies(slot.dependencies, dependencies)) return;
            slot.dependencies = dependencies;
            effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
        },
        commit() { effects.forEach((effect) => effect()); },
        dispose() { slots.forEach((slot) => { if (typeof slot.cleanup === "function") slot.cleanup(); }); },
    };
}
export function findElements(tree, predicate) {
    if (!tree || typeof tree !== "object") return [];
    if (Array.isArray(tree)) return tree.flatMap((child) => findElements(child, predicate));
    return [...(predicate(tree) ? [tree] : []), ...findElements(tree.props?.children, predicate)];
}

export async function mountTasksApp(board) {
    const saved = new Map(["window", "document", "localStorage", "CustomEvent", "__taskHooks"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const hooks = createHooks();
    const requests = [];
    const undo = [];
    const timers = new Map();
    const listeners = new Map();
    let now = 0;
    let timerId = 0;
    let printCount = 0;
    let disposed = false;
    let pending = 0;
    const window = {
        location: { search: "" },
        setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout: (id) => timers.delete(id),
        addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
        removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter((listener) => listener !== callback)); },
        dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
        print() { printCount += 1; },
        APStudyConfirm: { request: async () => true },
        APStudyUndo: { stage: (entry) => undo.push(entry) },
        fetch(url, options = {}) {
            if (url === "/api/tasks" && !options.method) return Promise.resolve(new Response(JSON.stringify(board), { headers: { "Content-Type": "application/json" } }));
            const response = deferred();
            requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : null,
                reject: response.reject,
                resolve: payload => response.resolve(payload instanceof Response ? payload : new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } })),
            });
            return response.promise;
        },
    };
    runInNewContext(httpSource, { window, URL, FormData });
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: {
        track(operation) { pending += 1; return operation.finally(() => { pending -= 1; }); },
    } });
    runInNewContext(dateTimeSource, { window, Date });
    window.APStudyDate = window.APStudyCoreServices.dateTime;
    Object.assign(globalThis, {
        window, document: { getElementById: () => null }, localStorage: { removeItem() {} }, __taskHooks: hooks,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        hooks.dispose();
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    };
    let TaskApp;
    try {
        ({ TaskApp } = await loadTaskModule("task.js"));
    } catch (error) {
        dispose();
        throw error;
    }
    let tree;
    const flush = async () => {
        // API normalization and effect-triggered state each take a microtask.
        for (let pass = 0; pass < 24; pass += 1) {
            await Promise.resolve();
            if (hooks.dirty) { hooks.begin(); tree = TaskApp({}); hooks.commit(); }
        }
    };
    try { await flush(); }
    catch (error) { dispose(); throw error; }
    const component = (name) => {
        const match = findElements(tree, (element) => element.type?.name === name)[0];
        assert.ok(match, `Rendered task component: ${name}`);
        return match.props;
    };
    return {
        window, requests, undo, flush, pending: () => pending,
        rail: () => component("ListRail"),
        section: (id = "school") => {
            const match = findElements(tree, (element) => element.type?.name === "TaskSection" && element.props.list.id === id)[0];
            assert.ok(match, `Rendered task section: ${id}`);
            return match.props;
        },
        error: () => findElements(tree, (element) => element.props?.role === "alert")[0]?.props.children[0] || "",
        async settle(request, payload, error = null) { error ? request.reject(error) : request.resolve(payload); await flush(); },
        async advance(milliseconds) {
            now += milliseconds;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
            await flush();
        },
        menu: () => component("ActionMenu").menu,
        actionMenu: () => component("ActionMenu"),
        printSheet: () => component("PrintSheet"),
        printCount: () => printCount,
        dispose,
    };
}
