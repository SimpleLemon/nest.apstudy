import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const confirmCallsites = [
    "static/js/calendar_context_menu.js",
    "static/js/courses.js",
    "static/js/notes/list.js",
    "static/js/settings.js",
    "static/js/tasks/task-app-helpers.js",
];

test("destructive flows use the shared website confirmation modal", async () => {
    const globalSource = await readFile(path.join(repoRoot, "static/js/global.js"), "utf8");
    assert.match(globalSource, /window\.APStudyConfirm/);
    assert.match(globalSource, /apstudy-confirm/);

    for (const relativePath of confirmCallsites) {
        const source = await readFile(path.join(repoRoot, relativePath), "utf8");
        assert.doesNotMatch(source, /window\.confirm|\bconfirm\s*\(/);
        assert.match(source, /APStudyConfirm\?\.request/);
    }
});
