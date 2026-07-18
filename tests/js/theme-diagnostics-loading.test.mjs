import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function walkJavaScript(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walkJavaScript(target));
        else if (entry.name.endsWith(".js")) files.push(target);
    }
    return files;
}

test("first-party JavaScript never uses document.write", async () => {
    for (const file of await walkJavaScript(path.join(root, "static/js"))) {
        const source = await readFile(file, "utf8");
        assert.doesNotMatch(source, /document\.write\s*\(/, path.relative(root, file));
    }
});

test("theme initialization is independent from opt-in asynchronous diagnostics", async () => {
    const theme = await readFile(path.join(root, "static/js/core/theme-init.js"), "utf8");
    const partial = await readFile(path.join(root, "templates/_diagnostics_assets.html"), "utf8");
    assert.doesNotMatch(theme, /console-discord|createElement\(["']script/);
    assert.match(partial, /frontend_console_diagnostics_enabled\|default\(false\)/);
    assert.match(partial, /console-discord\.js/);
    assert.match(partial, /<script[^>]* async><\/script>/);
});

test("every full template keeps synchronous theme init ahead of styles and diagnostics separate", async () => {
    const templateDir = path.join(root, "templates");
    for (const name of await readdir(templateDir)) {
        if (!name.endsWith(".html")) continue;
        const source = await readFile(path.join(templateDir, name), "utf8");
        if (!/<!doctype html>/i.test(source)) continue;
        const head = source.split("</head>", 1)[0];
        assert.match(head, /js\/core\/theme-init\.js/, name);
        assert.match(head, /_diagnostics_assets\.html/, name);
        assert.ok(head.indexOf("js/core/theme-init.js") < head.indexOf("css/themes.css"), name);
    }
});
