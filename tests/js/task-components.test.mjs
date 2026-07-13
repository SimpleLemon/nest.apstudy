import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task-components.js"), "utf8");
const entrySource = await readFile(path.join(repoRoot, "static/js/tasks/task-entry-components.js"), "utf8");
const recurrenceSource = await readFile(path.join(repoRoot, "static/js/tasks/task-recurrence.js"), "utf8");
const deadlineSource = await readFile(path.join(repoRoot, "static/js/tasks/task-deadline.js"), "utf8");
const controlsSource = await readFile(path.join(repoRoot, "static/js/tasks/task-form-controls.js"), "utf8");

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
    assert.match(entrySource, /\bformatTaskDeadline\b/);
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
    assert.match(recurrenceSource, /function RepeatMenuContent\b/);
    assert.match(recurrenceSource, /task-add-repeat-popover/);
    assert.match(recurrenceSource, /onCancel/);
    assert.match(recurrenceSource, /onDone/);
    assert.match(recurrenceSource, /"Cancel"/);
    assert.match(recurrenceSource, /"Done"/);
    assert.match(recurrenceSource, /"Never"/);
    assert.match(recurrenceSource, /"On a date"/);
    assert.match(recurrenceSource, /task-repeat-end-option/);
});

test("task forms use custom listboxes and calendars instead of browser pickers", () => {
    const combined = `${entrySource}\n${recurrenceSource}\n${deadlineSource}`;
    assert.doesNotMatch(combined, /h\("select"/);
    assert.doesNotMatch(combined, /type: "(?:date|datetime-local|time|radio)"/);
    assert.match(controlsSource, /role: "listbox"/);
    assert.match(controlsSource, /role: "grid"/);
    assert.match(controlsSource, /ArrowLeft/);
    assert.match(controlsSource, /PageDown/);
});
