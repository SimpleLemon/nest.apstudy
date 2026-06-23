import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sidebarInitSource = await readFile(
    path.join(repoRoot, "static/js/core/sidebar-init.js"),
    "utf8",
);

function createSidebarInitContext({ storedValue = null, sidebarDefault = "expanded", storageThrows = false } = {}) {
    const storage = new Map();
    if (storedValue !== null) {
        storage.set("sidebar-collapsed", storedValue);
    }

    const documentElement = {
        classList: {
            classes: new Set(),
            toggle(className, enabled) {
                if (enabled) {
                    this.classes.add(className);
                } else {
                    this.classes.delete(className);
                }
            },
        },
        dataset: {},
    };

    const context = {
        console: { warn() {} },
        document: {
            documentElement,
        },
        localStorage: {
            getItem(key) {
                if (storageThrows) {
                    throw new Error("blocked");
                }
                return storage.has(key) ? storage.get(key) : null;
            },
            setItem(key, value) {
                storage.set(key, value);
            },
        },
        window: {
            APSTUDY_SIDEBAR_DEFAULT: sidebarDefault,
        },
    };

    vm.runInNewContext(sidebarInitSource, context);
    return context;
}

test("sidebar init applies early collapsed class from localStorage", () => {
    const context = createSidebarInitContext({ storedValue: "true", sidebarDefault: "expanded" });

    assert.equal(
        context.document.documentElement.classList.classes.has("apstudy-sidebar-collapsed"),
        true,
    );
    assert.equal(context.window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED("expanded"), true);
});

test("sidebar init falls back to server default when localStorage is empty", () => {
    const collapsed = createSidebarInitContext({ sidebarDefault: "collapsed" });
    const expanded = createSidebarInitContext({ sidebarDefault: "expanded" });

    assert.equal(
        collapsed.document.documentElement.classList.classes.has("apstudy-sidebar-collapsed"),
        true,
    );
    assert.equal(
        expanded.document.documentElement.classList.classes.has("apstudy-sidebar-collapsed"),
        false,
    );
    assert.equal(collapsed.window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED("collapsed"), true);
    assert.equal(expanded.window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED("expanded"), false);
});

test("sidebar init prefers persisted state over server default", () => {
    const context = createSidebarInitContext({ storedValue: "false", sidebarDefault: "collapsed" });

    assert.equal(
        context.document.documentElement.classList.classes.has("apstudy-sidebar-collapsed"),
        false,
    );
    assert.equal(context.window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED("collapsed"), false);
});

test("sidebar init tolerates blocked localStorage and uses server default", () => {
    const context = createSidebarInitContext({ sidebarDefault: "collapsed", storageThrows: true });

    assert.equal(
        context.document.documentElement.classList.classes.has("apstudy-sidebar-collapsed"),
        true,
    );
});
