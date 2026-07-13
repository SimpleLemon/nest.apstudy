import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function importBrowserModule(relativePath) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    return import(url);
}

test("page setup trigger captures its visible anchor before opening", async () => {
    const { handlePageSetupTriggerClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    const triggerRect = { left: 24, top: 60, right: 58, bottom: 94, width: 34, height: 34 };
    const button = { getBoundingClientRect: () => triggerRect };
    const popover = { hidden: true };
    let prevented = false;
    let stopped = false;
    let openedWith = null;
    let openedAt = null;
    const event = {
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
    };

    const handled = handlePageSetupTriggerClick(event, button, popover, (trigger, rect) => {
        openedWith = trigger;
        openedAt = rect;
    }, () => assert.fail("should not close"));

    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(openedWith, button);
    assert.equal(openedAt, triggerRect);
});

test("page setup trigger toggles an open popover closed", async () => {
    const { handlePageSetupTriggerClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    const button = { getBoundingClientRect: () => ({ width: 34, height: 34 }) };
    let closed = false;
    const handled = handlePageSetupTriggerClick(
        { preventDefault() {}, stopPropagation() {} },
        button,
        { hidden: false },
        () => assert.fail("should not open"),
        () => { closed = true; },
    );
    assert.equal(handled, true);
    assert.equal(closed, true);
});

test("page setup trigger ignores a missing control or popover", async () => {
    const { handlePageSetupTriggerClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    assert.equal(handlePageSetupTriggerClick({}, null, {}, () => {}, () => {}), false);
    assert.equal(handlePageSetupTriggerClick({}, {}, null, () => {}, () => {}), false);
});

test("delegated page setup click opens from a toolbar overflow item", async () => {
    const { handlePageSetupToolbarClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    const triggerRect = { left: 700, top: 100, right: 734, bottom: 134, width: 34, height: 34 };
    const button = { getBoundingClientRect: () => triggerRect };
    const overflowMenu = { contains: (candidate) => candidate === button };
    const toolbar = { contains: (candidate) => overflowMenu.contains(candidate) };
    const popover = { hidden: true };
    let openedAt = null;
    const event = {
        target: { closest: () => button },
        preventDefault() {},
        stopPropagation() {},
    };

    const handled = handlePageSetupToolbarClick(
        event,
        toolbar,
        popover,
        (_trigger, rect) => { openedAt = rect; },
        () => assert.fail("should not close"),
    );

    assert.equal(handled, true);
    assert.equal(openedAt, triggerRect);
});

test("toolbar binding claims are idempotent across duplicate editor runtimes", async () => {
    const { claimElementBinding } = await importBrowserModule("static/js/notes/editor/utils.js");
    const attributes = new Map();
    const toolbar = {
        getAttribute: (name) => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, value),
    };

    assert.equal(claimElementBinding(toolbar, "notesEditorToolbarBound"), true);
    assert.equal(claimElementBinding(toolbar, "notesEditorToolbarBound"), false);
    assert.equal(attributes.get("data-notes-editor-toolbar-bound"), "true");
});

test("toolbar popovers stay beside their trigger and inside the editor boundary", async () => {
    const { floatingPopoverPosition } = await importBrowserModule("static/js/notes/editor/utils.js");
    const boundaryRect = { left: 100, right: 900 };

    assert.deepEqual(floatingPopoverPosition({
        triggerRect: { left: 820, top: 120, right: 860, bottom: 160 },
        popoverRect: { width: 240, height: 180 },
        boundaryRect,
        viewportWidth: 1000,
        viewportHeight: 700,
    }), { left: 652, top: 166 });

    assert.deepEqual(floatingPopoverPosition({
        triggerRect: { left: 300, top: 620, right: 340, bottom: 660 },
        popoverRect: { width: 220, height: 180 },
        boundaryRect,
        viewportWidth: 1000,
        viewportHeight: 700,
    }), { left: 300, top: 434 });
});
