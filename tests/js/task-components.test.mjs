import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task-components.js"), "utf8");
const entrySource = await readFile(path.join(repoRoot, "static/js/tasks/task-entry-components.js"), "utf8");

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
        assert.match(source, new RegExp(`export (?:function|const) ${exportName}\\b`));
    }
});

test("task rows and sections are memoized while sortable dependencies stay ID-based", () => {
    assert.match(source, /export const TaskSection = React\.memo/);
    assert.match(entrySource, /export const TaskRow = React\.memo/);
    assert.match(source, /taskItemsEqual\(previous\.tasks, next\.tasks\)/);
    assert.match(source, /taskGroups\.active\.map\(\(task\) => task\.id\)\.join\("\|"\)/);
});

test("task component module depends on shared task utilities instead of duplicating rules", () => {
    assert.match(source, /from "\.\/task-utils\.js"/);
    assert.match(source, /from "\.\/task-entry-components\.js"/);
    assert.match(entrySource, /from "\.\/task-utils\.js"/);
    assert.match(entrySource, /\bformatDeadline\b/);
    assert.match(entrySource, /\bformatRepeat\b/);
    assert.match(source, /\bsortedLists\b/);
    assert.match(source, /\bsplitTasksByCompletion\b/);
});

test("task component module exposes completed section and quick-add popover controls", () => {
    assert.match(source, /task-completed-section/);
    assert.match(entrySource, /task-add-entrybar/);
    assert.match(entrySource, /task-add-popover/);
    assert.match(entrySource, /data-task-add-popover-trigger/);
});

test("task repeat editor uses menu actions and end options instead of an inner toggle", () => {
    assert.doesNotMatch(entrySource, /function repeatToggle\b/);
    assert.match(entrySource, /function RepeatMenuContent\b/);
    assert.match(entrySource, /task-add-repeat-popover/);
    assert.match(entrySource, /onCancel/);
    assert.match(entrySource, /onDone/);
    assert.match(entrySource, /"Cancel"/);
    assert.match(entrySource, /"Done"/);
    assert.match(entrySource, /"Never"/);
    assert.match(entrySource, /"On"/);
    assert.match(entrySource, /task-repeat-end-option/);
});
