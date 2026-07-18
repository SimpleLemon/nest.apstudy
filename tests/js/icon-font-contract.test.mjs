import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "dist") continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walk(target));
        else if (/\.(html|js)$/.test(entry.name)) files.push(target);
    }
    return files;
}

test("all full templates use the one self-hosted icon-font dependency in the shared partial", async () => {
    const templates = await walk(path.join(root, "templates"));
    for (const template of templates) {
        const source = await readFile(template, "utf8");
        assert.doesNotMatch(source, /fonts\.(googleapis|gstatic)\.com/);
        assert.doesNotMatch(source, /family=Material\+Icons/);
        if (/<html[\s>]/.test(source)) assert.match(source, /_font_assets\.html/);
    }
    const partial = await readFile(path.join(root, "templates/_font_assets.html"), "utf8");
    assert.ok(partial.indexOf("material-symbols-outlined-v361-subset.woff2") < partial.indexOf("css/fonts.css"));
    assert.equal((partial.match(/material-symbols-outlined-v361-subset\.woff2/g) || []).length, 1);
});

test("the local Material Symbols subset is small and blocks glyph-text fallback", async () => {
    const fontPath = path.join(root, "static/fonts/material-symbols-outlined-v361-subset.woff2");
    assert.ok((await stat(fontPath)).size < 25_000);
    const styles = await readFile(path.join(root, "static/css/fonts.css"), "utf8");
    assert.match(styles, /font-family:\s*"Material Symbols Outlined"/);
    assert.match(styles, /font-display:\s*block/);
    assert.match(styles, /font-feature-settings:\s*"liga"/);
    assert.match(styles, /material-symbols-outlined-v361-subset\.woff2/);
    assert.doesNotMatch(await readFile(path.join(root, "static/js/core/sidebar.js"), "utf8"), /fonts\.googleapis\.com/);
});

test("icon glyph text is always hidden from accessibility or replaced by an explicit label", async () => {
    const files = [
        ...await walk(path.join(root, "templates")),
        ...await walk(path.join(root, "static/js")),
    ];
    for (const file of files) {
        const source = await readFile(file, "utf8");
        const unlabelled = source.match(/<span[^>]*material-symbols-outlined(?![^>]*aria-hidden)(?![^>]*aria-label)[^>]*>/g) || [];
        assert.deepEqual(unlabelled, [], `${path.relative(root, file)} has exposed icon glyph text`);
    }
});
