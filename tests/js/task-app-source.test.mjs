import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mountTasksApp } from "./helpers/tasks-app.mjs";
import { mountTaskComponent } from "./helpers/task-components.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task.js"), "utf8");

test("task app composes adjacent UI, persistence, and sound modules", () => {
    assert.match(source, /from "\.\/task-components\.js"/);
    assert.match(source, /from "\.\/task-app-helpers\.js"/);
    assert.match(source, /from "\.\/task-data\.js"/);
    assert.match(source, /from "\.\/task-audio\.js"/);
    assert.doesNotMatch(source, /fetch\("\/api\/tasks/);
});

test("task printing follows the completed disclosure and renders ordinary and recurring checkboxes", async () => {
    const list = { id: "school", name: "School" };
    const task = (id, values = {}) => ({ id, list_id: list.id, title: id, order: 1000, completed: false, ...values });
    const recurrence = { every: 1, unit: "week", startDate: "2026-10-03", endDate: null };
    const app = await mountTasksApp({
        lists: [list, { id: "personal", name: "Personal" }],
        tasks: [
            task("active"), task("done", { completed: true }),
            task("repeat-active", { recurrence, completed: true, next_occurrence_key: "next" }),
            task("repeat-done", { recurrence, next_occurrence_key: "next", completed_occurrences: [{ occurrence_key: "next" }] }),
            task("other-list", { list_id: "personal" }),
        ],
        preferences: { task_sound_enabled: false },
    });
    let sheet;
    const print = async () => {
        if (!app.menu()) { app.section().openListMenu("school", { anchor: {} }); await app.flush(); }
        app.menu().items.find((item) => item.label === "Print list").onClick(); await app.flush();
    };
    try {
        await print();
        sheet = await mountTaskComponent("task-app-helpers.js", "PrintSheet", app.printSheet());
        assert.equal(app.printSheet().includeCompleted, false);
        assert.deepEqual(sheet.all((element) => element.type === "li").map((element) => element.props.key), ["active", "repeat-active"]);
        assert.deepEqual(sheet.all((element) => element.props?.className === "task-print-checkbox").map((element) => element.props.children[0]), ["", ""]);
        app.section().onCompletedOpenChange("school", true); await app.flush();
        await print(); await sheet.render(app.printSheet());
        assert.equal(app.printSheet().includeCompleted, true);
        const rows = sheet.all((element) => element.type === "li");
        assert.deepEqual(rows.map((element) => element.props.key), ["active", "done", "repeat-active", "repeat-done"]);
        assert.deepEqual(rows.map((element) => element.props.className), ["", "is-completed", "", "is-completed"]);
        assert.deepEqual(sheet.all((element) => element.props?.className === "task-print-checkbox").map((element) => element.props.children[0]), ["", "✓", "", "✓"]);
        app.section().onCompletedOpenChange("school", false); await app.flush();
        await print(); await sheet.render(app.printSheet());
        assert.equal(app.printSheet().includeCompleted, false);
        assert.equal(sheet.all((element) => element.type === "li").length, 2);
    } finally { sheet?.dispose(); app.dispose(); }
});
