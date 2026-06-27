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

test("page setup toolbar click reaches the popover handler for edit-capable views", async () => {
    const { handlePageSetupToolbarClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    const button = { dataset: { editorAction: "page-setup" } };
    const toolbar = { contains: (candidate) => candidate === button };
    let prevented = false;
    let openedWith = null;
    const event = {
        target: { closest: () => button },
        preventDefault: () => { prevented = true; },
    };

    const handled = handlePageSetupToolbarClick(event, toolbar, (trigger) => {
        openedWith = trigger;
    });

    assert.equal(handled, true);
    assert.equal(prevented, true);
    assert.equal(openedWith, button);
});

test("page setup toolbar click ignores controls outside the writing toolbar", async () => {
    const { handlePageSetupToolbarClick } = await importBrowserModule("static/js/notes/editor/utils.js");
    const button = {};
    const handled = handlePageSetupToolbarClick(
        { target: { closest: () => button }, preventDefault: () => assert.fail("should not prevent") },
        { contains: () => false },
        () => assert.fail("should not open"),
    );
    assert.equal(handled, false);
});
