import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("landing executes only external first-party scripts in pre-paint order", async () => {
    const template = await readFile(path.join(root, "templates/landing.html"), "utf8");
    const earlyTheme = template.indexOf("js/landing-theme-init.js");
    const sharedTheme = template.indexOf("js/core/theme-init.js");
    const firstStylesheet = template.indexOf("<link rel=\"stylesheet\"");
    assert.ok(earlyTheme >= 0 && earlyTheme < sharedTheme && sharedTheme < firstStylesheet);
    assert.doesNotMatch(template, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/);

    const earlySource = await readFile(path.join(root, "static/js/landing-theme-init.js"), "utf8");
    assert.match(earlySource, /APSTUDY_THEME_LOCKED = true/);
    assert.match(earlySource, /prefers-color-scheme: dark/);
    assert.match(earlySource, /addEventListener\('change', applyLandingTheme\)/);
});
