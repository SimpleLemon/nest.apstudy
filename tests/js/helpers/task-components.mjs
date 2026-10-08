import assert from "node:assert/strict";
import { createHooks, findElements, loadTaskModule } from "./tasks-app.mjs";

// Keep the existing deterministic TaskApp renderer for child UI components.
// Each mount owns its hooks, but executes the unchanged production component.
export async function mountTaskComponent(moduleName, componentName, initialProps) {
    const Component = typeof componentName === "function" ? componentName : (await loadTaskModule(moduleName))[componentName];
    assert.equal(typeof Component, "function", `Task component: ${componentName}`);
    const hooks = createHooks();
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = { ...originalDocument, addEventListener() {}, removeEventListener() {} };
    globalThis.window ||= { addEventListener() {}, removeEventListener() {} };
    let tree;
    let props = initialProps;
    const flush = async () => {
        const previousHooks = globalThis.__taskHooks;
        try {
            globalThis.__taskHooks = hooks;
            for (let pass = 0; pass < 24; pass++) {
                await Promise.resolve();
                if (hooks.dirty) { hooks.begin(); tree = Component(props); hooks.commit(); }
            }
        } finally { globalThis.__taskHooks = previousHooks; }
    };
    await flush();
    const find = (predicate) => {
        const element = findElements(tree, predicate)[0];
        assert.ok(element, "Rendered task control matches predicate");
        return element;
    };
    return {
        flush, tree: () => tree,
        find,
        all: (predicate) => findElements(tree, predicate),
        component: (name) => find((element) => element.type?.name === name),
        byType: (name) => find((element) => element.type === name),
        byClass: (name) => find((element) => element.props?.className?.split(" ").includes(name)),
        byLabel: (label) => find((element) => element.props?.["aria-label"] === label),
        alert: () => findElements(tree, (element) => element.props?.role === "alert")[0],
        async settle(response, payload, error = null) { error ? response.reject(error) : response.resolve(payload); await flush(); },
        async render(nextProps) { props = nextProps; hooks.begin(); tree = ComponentWithHooks(); hooks.commit(); await flush(); },
        dispose() {
            hooks.dispose();
            if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
            if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
        },
    };
    function ComponentWithHooks() {
        const previousHooks = globalThis.__taskHooks;
        try { globalThis.__taskHooks = hooks; return Component(props); }
        finally { globalThis.__taskHooks = previousHooks; }
    }
}

export const triggerEvent = { preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ top: 10, right: 50, bottom: 30, left: 10 }) } };
