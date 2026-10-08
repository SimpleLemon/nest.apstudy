import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mountTasksApp } from "./helpers/tasks-app.mjs";

const list = (id, values = {}) => ({ id, name: id, order: 1000, ...values });
const task = (id, values = {}) => ({ id, list_id: "school", title: id, completed: false, order: 1000, ...values });
const board = () => ({ lists: [list("school"), list("personal")], tasks: [task("one"), task("two")], preferences: { task_sound_enabled: false } });
const findTask = (app, id) => app.section().tasks.find((item) => item.id === id);
async function withApp(run) {
    const app = await mountTasksApp(board());
    try { await run(app); }
    finally { await app.dispose(); }
}

test("list visibility keeps the newest intent when old success and failure responses arrive later", async () => withApp(async (app) => {
    app.rail().toggleListVisibility("school"); await app.flush();
    app.rail().toggleListVisibility("school"); await app.flush();
    assert.deepEqual(app.requests.map((request) => request.body), [{ hidden: true }, { hidden: false }]);
    await app.settle(app.requests[1], { list: list("school", { hidden: false }) });
    await app.settle(app.requests[0], { list: list("school", { hidden: true }) });
    assert.equal(app.rail().lists.find((item) => item.id === "school").hidden, false);
    app.rail().toggleListVisibility("school"); await app.flush();
    app.rail().toggleListVisibility("school"); await app.flush();
    await app.settle(app.requests[3], { list: list("school", { hidden: false }) });
    await app.settle(app.requests[2], null, new Error("Obsolete visibility failure"));
    assert.equal(app.rail().lists.find((item) => item.id === "school").hidden, false);
    assert.equal(app.error(), "");
}));

test("task edit retries survive an older failure and preserve unrelated edits", async () => withApp(async (app) => {
    const first = app.section().updateTask("one", { title: "First attempt" }); await app.flush();
    const retry = app.section().updateTask("one", { title: "Retried title" }); await app.flush();
    const other = app.section().updateTask("two", { title: "Independent title" }); await app.flush();
    assert.equal(app.requests.length, 3);
    await app.settle(app.requests[1], { task: task("one", { title: "Retried title" }) });
    await app.settle(app.requests[2], { task: task("two", { title: "Independent title" }) });
    await app.settle(app.requests[0], null, new Error("Older save failed"));
    assert.equal(findTask(app, "one").title, "Retried title");
    assert.equal(findTask(app, "two").title, "Independent title");
    assert.equal((await first).stale, true);
    assert.equal((await retry).title, "Retried title");
    await other;
    assert.equal(app.error(), "");
}));

test("completion failure rolls back its own task without erasing an unrelated completed edit", async () => withApp(async (app) => {
    const completion = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    const edit = app.section().updateTask("two", { title: "Independent title" }); await app.flush();
    await app.settle(app.requests[1], { task: task("two", { title: "Independent title" }) });
    await app.settle(app.requests[0], null, new Error("Completion failed"));
    await Promise.all([completion, edit]);
    assert.equal(findTask(app, "two").title, "Independent title");
    assert.equal(findTask(app, "one").completed, false);
}));

test("late completion responses cannot reverse a newer completion intent", async () => withApp(async (app) => {
    const complete = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    const uncomplete = app.section().completeTask(findTask(app, "one"), false); await app.flush();
    await app.settle(app.requests[1], { task: task("one", { completed: false }) });
    await app.settle(app.requests[0], { task: task("one", { completed: true }) });
    await Promise.all([complete, uncomplete]);
    assert.equal(findTask(app, "one").completed, false);
}));

test("deletion and undo invalidate an older completion failure", async () => withApp(async (app) => {
    const completion = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    await app.section().deleteTask("one"); await app.flush();
    assert.equal(findTask(app, "one"), undefined);
    assert.equal(app.undo.length, 1);
    app.undo[0].restore(); await app.flush();
    assert.equal(findTask(app, "one").completed, true);
    await app.settle(app.requests[0], null, new Error("Obsolete completion failure"));
    await completion;
    assert.equal(findTask(app, "one").completed, true);
    assert.equal(app.error(), "");
}));

test("a completion failure cannot resurrect a task deleted while the request was pending", async () => withApp(async (app) => {
    const completion = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    await app.section().deleteTask("one"); await app.flush();
    await app.settle(app.requests[0], null, new Error("Late failure"));
    await completion;
    assert.equal(findTask(app, "one"), undefined);
    const deletion = app.undo[0].commit({ reason: "pagehide" });
    assert.equal(app.requests[1].method, "DELETE");
    assert.equal(app.requests[1].keepalive, true);
    await app.settle(app.requests[1], {});
    await deletion;
}));

test("list failure rolls back only its own list and retains another list's successful edit", async () => withApp(async (app) => {
    const first = app.rail().updateList("school", { description: "Pending description" }); await app.flush();
    const other = app.rail().updateList("personal", { description: "Saved description" }); await app.flush();
    await app.settle(app.requests[1], { list: list("personal", { description: "Saved description" }) });
    await app.settle(app.requests[0], null, new Error("School save failed"));
    await Promise.all([first, other]);
    assert.equal(app.rail().lists.find((item) => item.id === "personal").description, "Saved description");
    assert.equal(app.rail().lists.find((item) => item.id === "school").description, "");
}));

test("deleting a list invalidates pending list and task writes even if undo restores its records", async () => withApp(async (app) => {
    const listWrite = app.rail().updateList("school", { description: "Pending description" }); await app.flush();
    const taskWrite = app.section().updateTask("one", { title: "Pending title" }); await app.flush();
    app.section().openListMenu("school", { anchor: {} }); await app.flush();
    await app.menu().items.find((item) => item.label === "Delete list").onClick(); await app.flush();
    assert.deepEqual(app.rail().lists.map((item) => item.id), ["personal"]);
    app.undo[0].restore(); await app.flush();
    await app.settle(app.requests[0], null, new Error("Obsolete list failure"));
    await app.settle(app.requests[1], null, new Error("Obsolete task failure"));
    await Promise.all([listWrite, taskWrite]);
    assert.equal(app.rail().lists.find((item) => item.id === "school").description, "Pending description");
    assert.equal(findTask(app, "one").title, "Pending title");
    assert.equal(app.error(), "");
}));

test("deleting completed tasks waits for acknowledged writes and captures only persisted completions", async () => withApp(async (app) => {
    const completion = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    app.section().openListMenu("school", { anchor: {} }); await app.flush();
    const deletion = app.menu().items.find((item) => item.label === "Delete all completed tasks").onClick(); await app.flush();
    assert.equal(app.undo.length, 0);
    await app.settle(app.requests[0], { task: task("one", { completed: true, completed_at: "2026-10-05T12:00:00Z" }) });
    await completion; await deletion; await app.flush();
    assert.equal(findTask(app, "one"), undefined);
    const edit = app.section().updateTask("two", { title: "Retained edit" }); await app.flush();
    await app.settle(app.requests[1], { task: task("two", { title: "Retained edit" }) }); await edit;
    const commit = app.undo[0].commit({ reason: "timeout" });
    assert.deepEqual(app.requests[2].body, { selection: [{ task_id: "one", completed_at: "2026-10-05T12:00:00Z" }] });
    await app.settle(app.requests[2], {}); await commit;
    assert.equal(findTask(app, "two").title, "Retained edit");
}));

test("print timer uses the selected list and completed disclosure and cancels when disposed", async () => withApp(async (app) => {
    const completion = app.section().completeTask(findTask(app, "one"), true); await app.flush();
    await app.settle(app.requests[0], { task: task("one", { completed: true }) }); await completion;
    app.section().onCompletedOpenChange("school", true); await app.flush();
    app.section().openListMenu("school", { anchor: {} }); await app.flush();
    app.menu().items.find((item) => item.label === "Print list").onClick(); await app.flush();
    assert.equal(app.printSheet().includeCompleted, true);
    assert.deepEqual(app.printSheet().tasks.map((item) => item.id), ["one", "two"]);
    await app.advance(59);
    assert.equal(app.printCount(), 0);
    await app.advance(1);
    assert.equal(app.printCount(), 1);
    app.window.dispatchEvent({ type: "afterprint" }); await app.flush();
    assert.equal(app.printSheet().list, undefined);
    app.menu().items.find((item) => item.label === "Print list").onClick(); await app.flush();
    await app.dispose();
    await app.advance(60);
    assert.equal(app.printCount(), 1);
}));

test("malformed JSON and login HTML task saves restore optimistic edits and expose recoverable feedback", async () => withApp(async (app) => {
    for (const [body, contentType] of [["broken", "application/json"], ["<html>Log in</html>", "text/html"]]) {
        const requestIndex = app.requests.length;
        const save = app.section().updateTask("one", { title: "Draft edit" }); await app.flush();
        assert.equal(findTask(app, "one").title, "Draft edit");
        assert.equal(app.pending(), 1);
        await app.settle(app.requests[requestIndex], new Response(body, { headers: { "Content-Type": contentType } }));
        const result = await save; await app.flush();
        assert.deepEqual(result, { ok: false, error: "Invalid JSON response." });
        assert.equal(findTask(app, "one").title, "one");
        assert.match(app.error(), /Invalid JSON response/);
        assert.equal(app.pending(), 0);
    }
}));

for (const reverse of [false, true]) {
    test(`all failed overlapping task/list/completion writes restore accepted fields (${reverse ? 'newer' : 'older'} failure first)`, async () => withApp(async app => {
        const titleA = app.section().updateTask('one', { title: 'First unsaved' });
        const titleB = app.section().updateTask('one', { title: 'Second unsaved' });
        const listA = app.rail().updateList('school', { description: 'First unsaved' });
        const listB = app.rail().updateList('school', { description: 'Second unsaved' });
        const completionA = app.section().completeTask(findTask(app, 'two'), true);
        const completionB = app.section().completeTask(findTask(app, 'two'), false);
        await app.flush();
        assert.equal(app.requests.length, 6);
        assert.equal(app.pending(), 6);
        for (const index of reverse ? [5, 3, 1, 4, 2, 0] : [0, 2, 4, 1, 3, 5]) {
            await app.settle(app.requests[index], null, new Error(`Failed ${index}`));
        }
        await Promise.all([titleA, titleB, listA, listB, completionA, completionB]); await app.flush();
        assert.equal(findTask(app, 'one').title, 'one');
        assert.equal(findTask(app, 'two').completed, false);
        assert.equal(app.rail().lists.find(item => item.id === 'school').description, '');
        assert.equal(app.pending(), 0);
    }));
}

test('independent concurrent fields survive full stale responses on the same task and list', async () => withApp(async app => {
    const titleWrite = app.section().updateTask('one', { title: 'Saved title' });
    const priorityWrite = app.section().updateTask('one', { priority: 'high' });
    const descriptionWrite = app.rail().updateList('school', { description: 'Saved description' });
    const visibilityWrite = app.rail().updateList('school', { hidden: true });
    await app.flush();
    await app.settle(app.requests[1], { task: task('one', { priority: 'high' }) });
    await app.settle(app.requests[3], { list: list('school', { hidden: true }) });
    assert.equal(app.pending(), 2);
    await app.settle(app.requests[0], { task: task('one', { title: 'Saved title' }) });
    await app.settle(app.requests[2], { list: list('school', { description: 'Saved description' }) });
    await Promise.all([titleWrite, priorityWrite, descriptionWrite, visibilityWrite]); await app.flush();
    // Hidden sections do not render, so inspect through the print snapshot after showing it.
    assert.equal(app.rail().lists.find(item => item.id === 'school').description, 'Saved description');
    const show = app.rail().updateList('school', { hidden: false }); await app.flush();
    await app.settle(app.requests[4], { list: list('school', { hidden: false, description: 'Saved description' }) }); await show; await app.flush();
    assert.equal(findTask(app, 'one').title, 'Saved title');
    assert.equal(findTask(app, 'one').priority, 'high');
    assert.equal(app.pending(), 0);
}));

test('older rejected edit preserves a newer accepted independent field and accepted completion', async () => withApp(async app => {
    const titleWrite = app.section().updateTask('one', { title: 'Unsaved' }); await app.flush();
    const priorityWrite = app.section().updateTask('one', { priority: 'high' }); await app.flush();
    const completion = app.section().completeTask(findTask(app, 'one'), true); await app.flush();
    await app.settle(app.requests[2], { task: task('one', { title: 'Unsaved', priority: 'high', completed: true, completed_at: '2026-10-05T12:00:00Z' }) });
    await app.settle(app.requests[1], { task: task('one', { title: 'Unsaved', priority: 'high' }) });
    await app.settle(app.requests[0], null, new Error('Title failed'));
    await Promise.all([titleWrite, priorityWrite, completion]); await app.flush();
    assert.equal(findTask(app, 'one').title, 'one');
    assert.equal(findTask(app, 'one').priority, 'high');
    assert.equal(findTask(app, 'one').completed, true);
    assert.equal(app.error(), '');
}));

test('deferred completed-task commit sends captured boundaries and preserves tasks completed during Undo', async () => {
    const recurring = task('repeat', { recurrence: { every: 1, unit: 'week' }, next_occurrence_key: 'next', completed_occurrences: [{ id: 'old-row', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' }] });
    const app = await mountTasksApp({ ...board(), tasks: [task('one', { completed: true, completed_at: '2026-10-01T12:00:00Z' }), task('two'), recurring] });
    try {
        app.section().openListMenu('school', { anchor: {} }); await app.flush();
        await app.menu().items.find(item => item.label === 'Delete all completed tasks').onClick(); await app.flush();
        assert.equal(findTask(app, 'one'), undefined);
        assert.deepEqual(findTask(app, 'repeat').completed_occurrences, []);
        const second = app.section().completeTask(findTask(app, 'two'), true); await app.flush();
        await app.settle(app.requests[0], { task: task('two', { completed: true, completed_at: '2026-10-05T12:00:00Z' }) }); await second;
        const repeat = app.section().completeTask(findTask(app, 'repeat'), true); await app.flush();
        await app.settle(app.requests[1], { task: { ...recurring, completed_occurrences: [{ id: 'old-row', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' }, { id: 'new-row', occurrence_key: 'next', completed_at: '2026-10-05T12:00:00Z' }] } }); await repeat;
        const commit = app.undo[0].commit({ reason: 'pagehide' });
        assert.equal(app.requests[2].keepalive, true);
        assert.deepEqual(app.requests[2].body, { selection: [
            { task_id: 'one', completed_at: '2026-10-01T12:00:00Z' },
            { task_id: 'repeat', occurrences: [{ id: 'old-row', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' }] },
        ] });
        // Pass the actual browser request body through the authenticated Flask route.
        const boundary = spawnSync('.venv/bin/python', ['tests/js/helpers/task-deletion-api.py'], {
            env: { ...process.env, PYTHONPATH: process.cwd() },
            input: JSON.stringify({ body: app.requests[2].body,
                tasks: [
                    { $id: 'one', user_id: 'user-1', list_id: 'school', completed: true, completed_at: '2026-10-01T12:00:00Z' },
                    { $id: 'two', user_id: 'user-1', list_id: 'school', completed: true, completed_at: '2026-10-05T12:00:00Z' },
                    { $id: 'repeat', user_id: 'user-1', list_id: 'school', recurrence_json: JSON.stringify(recurring.recurrence) },
                ],
                completions: [
                    { $id: 'old-row', task_id: 'repeat', user_id: 'user-1', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' },
                    { $id: 'new-row', task_id: 'repeat', user_id: 'user-1', occurrence_key: 'next', completed_at: '2026-10-05T12:00:00Z' },
                ],
            }), encoding: 'utf8',
        });
        assert.equal(boundary.status, 0, boundary.stderr);
        const server = JSON.parse(boundary.stdout);
        assert.equal(server.status, 200);
        assert.deepEqual(server.payload, { ok: true, deleted_tasks: 1, cleared_completions: 1 });
        assert.deepEqual(server.tasks.map(item => item.$id), ['two', 'repeat']);
        assert.deepEqual(server.completions.map(item => item.$id), ['new-row']);
        await app.settle(app.requests[2], server.payload); await commit; await app.flush();
        assert.equal(findTask(app, 'two').completed, true);
        assert.deepEqual(findTask(app, 'repeat').completed_occurrences.map(item => item.id), ['new-row']);
    } finally { app.dispose(); }
});

test('recurring sweep Undo merges captured occurrences with later pending completion and its failed rollback', async () => {
    const old = { id: 'old', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' };
    const recurring = task('repeat', { recurrence: { every: 1, unit: 'week' }, next_occurrence_key: 'new', completed_occurrences: [old] });
    const app = await mountTasksApp({ ...board(), tasks: [recurring] });
    try {
        app.section().openListMenu('school', { anchor: {} }); await app.flush();
        await app.menu().items.find(item => item.label === 'Delete all completed tasks').onClick(); await app.flush();
        const completion = app.section().completeTask(findTask(app, 'repeat'), true); await app.flush();
        app.undo[0].restore(); await app.flush();
        assert.deepEqual(findTask(app, 'repeat').completed_occurrences.map(item => item.occurrence_key), ['old', 'new']);
        await app.settle(app.requests[0], null, new Error('New completion failed')); await completion; await app.flush();
        assert.deepEqual(findTask(app, 'repeat').completed_occurrences, [old]);
    } finally { app.dispose(); }
});

test('recurring overlapping current-occurrence failures restore earlier accepted occurrence history', async () => {
    const old = { id: 'old', occurrence_key: 'old', completed_at: '2026-10-01T12:00:00Z' };
    const recurring = task('repeat', { recurrence: { every: 1, unit: 'week' }, next_occurrence_key: 'next', completed_occurrences: [old] });
    const app = await mountTasksApp({ ...board(), tasks: [recurring] });
    try {
        const first = app.section().completeTask(findTask(app, 'repeat'), true); await app.flush();
        const second = app.section().completeTask(findTask(app, 'repeat'), false); await app.flush();
        await app.settle(app.requests[1], null, new Error('Uncomplete failed'));
        await app.settle(app.requests[0], null, new Error('Complete failed'));
        await Promise.all([first, second]); await app.flush();
        assert.deepEqual(findTask(app, 'repeat').completed_occurrences, [old]);
        assert.equal(app.pending(), 0);
    } finally { app.dispose(); }
});

test('same task edit keeps navigation pending through its response decode and rolls back malformed decode', async () => withApp(async app => {
    const decoding = Promise.withResolvers();
    const response = new Response('broken', { headers: { 'Content-Type': 'application/json' } });
    const decode = response.json.bind(response);
    response.json = async () => { await decoding.promise; return decode(); };
    const write = app.section().updateTask('one', { title: 'Unsaved' }); await app.flush();
    app.requests[0].resolve(response); await app.flush();
    assert.equal(app.pending(), 1);
    assert.equal(findTask(app, 'one').title, 'Unsaved');
    decoding.resolve(); await write; await app.flush();
    assert.equal(app.pending(), 0);
    assert.equal(findTask(app, 'one').title, 'one');
    assert.match(app.error(), /Invalid JSON response/);
}));
