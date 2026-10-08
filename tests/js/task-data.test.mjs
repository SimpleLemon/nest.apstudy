import assert from "node:assert/strict";
import test from "node:test";
import { loadTaskModule } from "./helpers/tasks-app.mjs";

globalThis.window = {};
const data = await loadTaskModule("task-data.js");

test("builds task API payloads with normalized deadline and recurrence fields", () => {
    assert.equal(globalThis.window.APStudyDate, undefined);
    const payload = data.buildTaskDraftPayload("list-1", {
        title: "Read",
        priority: "",
        deadline_at: "2026-05-20T14:30",
        recurrence: { every: 1, unit: "week" },
    }, "America/New_York");

    assert.equal(payload.list_id, "list-1");
    assert.equal(payload.priority, "none");
    assert.equal(payload.deadline_time, "14:30");
    assert.equal(payload.reminder_minutes, 10);
    assert.equal(payload.timezone, "America/New_York");
    assert.deepEqual(payload.recurrence, { every: 1, unit: "week" });
    assert.match(payload.deadline_at, /^2026-05-20T/);
    assert.equal(payload.deadline_at, new Date("2026-05-20T14:30").toISOString());
});

test("task payloads preserve priority and distinguish date-only from timed deadlines", () => {
    const dateOnly = data.buildTaskDraftPayload("list-1", {
        title: "Submit outline",
        priority: "high",
        deadline_at: "2026-05-20",
        deadline_time: null,
        reminder_minutes: -540,
    }, "America/Chicago");
    assert.equal(dateOnly.priority, "high");
    assert.equal(dateOnly.deadline_time, null);
    assert.equal(dateOnly.reminder_minutes, -540);
    assert.match(dateOnly.deadline_at, /^2026-05-20T/);

    const timed = data.buildTaskDraftPayload("list-1", {
        title: "Join review",
        priority: "urgent",
        deadline_at: "2026-05-20T14:30",
        deadline_time: "14:30",
        reminder_minutes: 10,
    }, "America/Chicago");
    assert.equal(timed.priority, "urgent");
    assert.equal(timed.deadline_time, "14:30");
    assert.equal(timed.reminder_minutes, 10);
});

test("task payload serialization keeps an explicit undefined deadline time as null", () => {
    const draft = { title: "Read", deadline_at: "2026-05-20T14:30" };
    const explicit = data.buildTaskDraftPayload("list-1", { ...draft, deadline_time: undefined }, "UTC");
    const inferred = data.buildTaskDraftPayload("list-1", draft, "UTC");
    const serializedExplicit = JSON.parse(JSON.stringify(explicit));
    const serializedInferred = JSON.parse(JSON.stringify(inferred));

    assert.equal(explicit.deadline_time, null);
    assert.ok(Object.hasOwn(serializedExplicit, "deadline_time"));
    assert.equal(serializedExplicit.deadline_time, null);
    assert.equal(serializedExplicit.reminder_minutes, -1);
    assert.equal(serializedInferred.deadline_time, "14:30");
    assert.equal(serializedInferred.reminder_minutes, 10);
    for (const key of ["list_id", "title", "priority", "deadline_at", "timezone", "recurrence"]) {
        assert.deepEqual(serializedExplicit[key], serializedInferred[key]);
    }
});

test("computes optimistic completed state for one-off and recurring tasks", () => {
    const now = new Date("2026-05-20T12:00:00Z");
    assert.deepEqual(data.buildCompletedTaskOptimistic({ id: "one-off", completed_occurrences: [] }, true, now), {
        occurrenceKey: "single",
        task: {
            id: "one-off",
            completed: true,
            completed_at: "2026-05-20T12:00:00.000Z",
            completed_occurrences: [],
            priority: "none",
            starred: false,
            reminder_minutes: -1,
        },
    });

    const recurring = data.buildCompletedTaskOptimistic({
        id: "repeat",
        recurrence: { every: 1, unit: "day" },
        next_occurrence_key: "2026-05-20",
        completed_occurrences: [],
    }, true, now);
    assert.equal(recurring.occurrenceKey, "2026-05-20");
    assert.deepEqual(recurring.task.completed_occurrences, [{
        occurrence_key: "2026-05-20",
        completed_at: "2026-05-20T12:00:00.000Z",
    }]);
});

test("creates list and task ordering updates without mutating input arrays", () => {
    const lists = [{ id: "a", name: "A", order: 1000 }, { id: "b", name: "B", order: 2000 }];
    const listUpdates = data.buildListOrderUpdates(["b", "a"]);
    assert.deepEqual(listUpdates, [{ id: "b", order: 1000 }, { id: "a", order: 2000 }]);
    assert.deepEqual(data.applyListOrderUpdates(lists, listUpdates).map((item) => `${item.id}:${item.order}`), ["b:1000", "a:2000"]);
    assert.deepEqual(lists.map((item) => `${item.id}:${item.order}`), ["a:1000", "b:2000"]);

    const tasks = [{ id: "one", list_id: "old", order: 1000 }, { id: "two", list_id: "old", order: 2000 }];
    const taskUpdates = [{ id: "two", list_id: "new", order: 1000 }];
    assert.deepEqual(data.applyTaskOrderUpdates(tasks, taskUpdates).map((item) => `${item.id}:${item.list_id}:${item.order}`), [
        "one:old:1000",
        "two:new:1000",
    ]);
});

test("normalizes task board payloads returned by the API layer", () => {
    const board = data.normalizeTaskBoard({
        lists: [{ id: "b", name: "B", order: 2 }, { id: "a", name: "A", order: 1, hidden: true }],
        tasks: [{ id: "task", title: "Write", starred: 1 }],
        preferences: { task_sound_enabled: false },
    });

    assert.deepEqual(board.lists.map((item) => item.id), ["a", "b"]);
    assert.equal(board.lists[0].hidden, true);
    assert.equal(board.tasks[0].priority, "none");
    assert.equal(board.tasks[0].starred, true);
    assert.equal(board.preferences.task_sound_enabled, false);
});

test('mutation journal settlements preserve pending intentions and discriminate stale tickets', async () => {
    const journal = data.createEntityMutationJournal();
    const entity = { id: 'one', title: 'Original', starred: false };
    const first = journal.begin(entity, { title: 'First' });
    const second = journal.begin(entity, { title: 'Second' });
    assert.deepEqual(second.changes, { title: 'Second' });
    let completed = false;
    const waiting = journal.waitFor(['one', 'absent']).then(() => { completed = true; });
    const accepted = journal.settle(first, { ...entity, title: 'Accepted first' });
    assert.deepEqual(accepted, { stale: false, latest: false, changes: { title: 'Second' } });
    await Promise.resolve();
    assert.equal(completed, false, 'completion waits for all pending entries');
    assert.deepEqual(journal.settle(second), { stale: false, latest: true, changes: { title: 'Accepted first' } });
    await waiting;
    assert.equal(completed, true);
    const third = journal.begin(entity, { starred: true });
    journal.invalidate('one');
    assert.deepEqual(journal.settle(third, { ...entity, starred: true }), { stale: true });
    assert.equal(journal.rebase('one', (value) => value), null);
});

test('list creation returns nullable cancellation or a normalized API list', async () => {
    const oldHttp = globalThis.window.APStudyHttp;
    const requests = [];
    globalThis.window.APStudyHttp = { fetchJson: async (url, options) => { requests.push({ url, options }); return { list: { id: 'new-list', name: 'Study' } }; } };
    try {
        assert.equal(await data.createTaskList({ name: '  ' }), null);
        assert.equal(requests.length, 0);
        assert.deepEqual(await data.createTaskList({ name: ' Study ' }), { id: 'new-list', name: 'Study', description: '', hidden: false, sort_mode: 'default' });
        assert.equal(requests.length, 1);
        assert.deepEqual(JSON.parse(requests[0].options.body), { name: 'Study', description: '' });
    } finally { globalThis.window.APStudyHttp = oldHttp; }
});
