import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const globalSource = await readFile(path.join(repoRoot, "static/js/core/global.js"), "utf8");
const globalStyles = await readFile(path.join(repoRoot, "static/css/global.css"), "utf8");

test("global.js exposes APStudyFormField helpers", () => {
    assert.match(globalSource, /window\.APStudyFormField\s*=/);
    assert.match(globalSource, /\bmarkInvalid\b/);
    assert.match(globalSource, /\bclearInvalid\b/);
    assert.match(globalSource, /\bclearAll\b/);
    assert.match(globalSource, /\bbindAutoClear\b/);
    assert.match(globalSource, /setAttribute\("aria-invalid", "true"\)/);
    assert.match(globalSource, /removeAttribute\("aria-invalid"\)/);
});

test("global.css styles invalid inputs and groups with theme error token", () => {
    assert.match(globalStyles, /\[aria-invalid="true"\]/);
    assert.match(globalStyles, /border-color:\s*var\(--color-error/);
    assert.match(globalStyles, /\[aria-invalid="true"\]:is\(:focus, :focus-visible\)/);
    assert.match(globalStyles, /\[id\$="-group"\]/);
});

test("global.css defines shared ui-search-field component classes", () => {
    assert.match(globalStyles, /\.ui-search-field\b/);
    assert.match(globalStyles, /\.ui-search-field__input\b/);
    assert.match(globalStyles, /\.ui-search-field--admin\b/);
    assert.match(globalStyles, /\.ui-search-field--compact\b/);
    assert.match(globalStyles, /\.ui-search-field--onboarding\b/);
});
