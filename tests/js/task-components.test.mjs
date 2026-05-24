import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task-components.js"), "utf8");

test("task component module keeps the expected public component surface", () => {
    const expectedExports = [
        "ActionMenu",
        "EmptyStarter",
        "ListEditorDialog",
        "ListRail",
        "MaterialIcon",
        "TaskSection",
    ];

    for (const exportName of expectedExports) {
        assert.match(source, new RegExp(`export function ${exportName}\\b`));
    }
});

test("task component module depends on shared task utilities instead of duplicating rules", () => {
    assert.match(source, /from "\.\/task-utils\.js"/);
    assert.match(source, /\bformatDeadline\b/);
    assert.match(source, /\bformatRepeat\b/);
    assert.match(source, /\bsortedLists\b/);
    assert.match(source, /\bsplitTasksByCompletion\b/);
});

test("task component module exposes completed section and quick-add popover controls", () => {
    assert.match(source, /task-completed-section/);
    assert.match(source, /task-add-entrybar/);
    assert.match(source, /task-add-popover/);
    assert.match(source, /data-task-add-popover-trigger/);
});

test("task repeat editor uses menu actions and end options instead of an inner toggle", () => {
    assert.doesNotMatch(source, /function repeatToggle\b/);
    assert.match(source, /function RepeatMenuContent\b/);
    assert.match(source, /task-add-repeat-popover/);
    assert.match(source, /onCancel/);
    assert.match(source, /onDone/);
    assert.match(source, /"Cancel"/);
    assert.match(source, /"Done"/);
    assert.match(source, /"Never"/);
    assert.match(source, /"On"/);
    assert.match(source, /task-repeat-end-option/);
});
