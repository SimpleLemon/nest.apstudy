import assert from "node:assert/strict";
import test from "node:test";
import { deferred, findElements, loadTaskModule, mountTasksApp } from "./helpers/tasks-app.mjs";
import { mountTaskComponent, triggerEvent } from "./helpers/task-components.mjs";

const task = { id: "one", list_id: "school", title: "Read chapter 3", priority: "none", deadline_at: "2026-10-10T00:00:00Z", deadline_time: null, reminder_minutes: -1, recurrence: { every: 1, unit: "week", startDate: "2026-10-03", endDate: null } };
const board = { lists: [{ id: "school", name: "School" }], tasks: [task], preferences: { task_sound_enabled: false } };
const popover = (view) => view.component("AddTaskPopover").props;
const popoverContent = (view) => popover(view).children[0]({ floatingOwner: "test-owner" });
const detailTrigger = (view, name) => view.find((element) => element.props?.["data-task-add-popover-trigger"] === `${name}-detail`);

test("quick-add validation and failed-create recovery preserve the complete draft for retry", async () => {
    const { validateTaskTitle, taskErrorMessage } = await loadTaskModule("task-entry-components.js");
    assert.equal(validateTaskTitle(""), "Enter a task title before adding it.");
    assert.equal(validateTaskTitle("   "), "Enter a task title before adding it.");
    assert.equal(validateTaskTitle("Read chapter 3"), "");
    assert.equal(taskErrorMessage(new Error("Server unavailable"), "Unable to create task."), "Server unavailable");
    const attempts = [];
    const view = await mountTaskComponent("task-entry-components.js", "AddTaskForm", {
        listId: "school",
        createTask(listId, payload) { const response = deferred(); attempts.push({ listId, payload, ...response }); return response.promise; },
    });
    try {
        await view.byType("form").props.onSubmit(triggerEvent); await view.flush();
        assert.equal(attempts.length, 0);
        assert.equal(view.byType("input").props["aria-invalid"], "true");
        assert.equal(view.alert().props.children[0], "Enter a task title before adding it.");
        assert.equal(view.byType("input").props["aria-describedby"], view.alert().props.id);
        view.byType("input").props.onChange({ target: { value: " Read chapter 3 " } }); await view.flush();
        assert.equal(view.byType("input").props["aria-invalid"], undefined);
        view.byLabel("Priority").props.onClick(triggerEvent); await view.flush();
        const choices = findElements(popoverContent(view), (element) => element.props?.role === "menuitemradio");
        const priority = choices.at(-1).props.children[1].props.children[0];
        choices.at(-1).props.onClick(); await view.flush();
        view.byLabel("Due date").props.onClick(triggerEvent); await view.flush();
        const deadline = { deadline_at: "2026-10-10T00:00:00Z", deadline_time: null, reminder_minutes: -1 };
        popoverContent(view).props.onApply(deadline); await view.flush();
        view.byLabel("Repeat").props.onClick(triggerEvent); await view.flush();
        const recurrence = { ...popoverContent(view).props.recurrence, every: 3 };
        popoverContent(view).props.onChange(recurrence); await view.flush();
        popoverContent(view).props.onDone(); await view.flush();
        const first = view.byType("form").props.onSubmit(triggerEvent); await view.flush();
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].listId, "school");
        assert.equal(attempts[0].payload.title, "Read chapter 3");
        assert.equal(attempts[0].payload.priority, priority.toLowerCase());
        assert.equal(attempts[0].payload.deadline_at, deadline.deadline_at);
        assert.deepEqual(attempts[0].payload.recurrence, recurrence);
        assert.equal(view.byType("input").props.disabled, true);
        assert.equal(view.byType("input").props.value, " Read chapter 3 ", "pending creation retains the draft");
        await view.settle(attempts[0], null, new Error("Server unavailable")); await first;
        assert.equal(view.alert().props.children[0], "Server unavailable");
        assert.equal(view.byType("input").props.disabled, false);
        assert.equal(view.byType("input").props.value, " Read chapter 3 ");
        const retry = view.byType("form").props.onSubmit(triggerEvent); await view.flush();
        assert.deepEqual(attempts[1].payload, attempts[0].payload, "retry sends retained priority, deadline, and recurrence");
        await view.settle(attempts[1], { id: "created" }); await retry;
        assert.equal(view.byType("input").props.value, "");
        assert.equal(view.alert(), undefined);
        view.byType("input").props.onChange({ target: { value: "Next task" } }); await view.flush();
        const next = view.byType("form").props.onSubmit(triggerEvent); await view.flush();
        assert.equal(attempts[2].payload.priority, "none");
        assert.equal(attempts[2].payload.deadline_at, null);
        assert.equal(attempts[2].payload.recurrence, null);
        await view.settle(attempts[2], {}); await next;
    } finally { view.dispose(); }
});

async function withTaskDetails(run) {
    const app = await mountTasksApp(board);
    const row = await mountTaskComponent("task-entry-components.js", "TaskRow", { task, isExpanded: true, updateTask: app.section().updateTask });
    const detail = row.component("TaskDetails");
    const view = await mountTaskComponent(null, detail.type, detail.props);
    try { await run({ app, view }); }
    finally { view.dispose(); row.dispose(); app.dispose(); }
}

test("failed priority updates retain the listbox and error, then a successful retry closes it", async () => withTaskDetails(async ({ app, view }) => {
    const priority = view.component("TaskListbox");
    const field = await mountTaskComponent(null, priority.type, priority.props);
    try {
        field.byLabel("Task priority").props.onClick(); await field.flush();
        field.find((element) => element.props?.role === "option" && element.props.children[1]?.props.children[0] === "High").props.onClick(); await field.flush();
        assert.equal(field.find((element) => element.props?.role === "option").props.disabled, true);
        await field.settle(app.requests[0], null, new Error("Priority save failed")); await app.flush();
        assert.equal(app.error(), "Priority save failed");
        assert.equal(field.alert().props.children[0], "Priority save failed");
        assert.equal(field.byLabel("Task priority").props["aria-expanded"], "true");
        assert.equal(field.find((element) => element.props?.role === "option").props.disabled, false);
        field.find((element) => element.props?.role === "option" && element.props.children[1]?.props.children[0] === "High").props.onClick(); await field.flush();
        await field.settle(app.requests[1], { task: { ...task, priority: "high" } }); await app.flush();
        assert.equal(field.all((element) => element.props?.role === "listbox").length, 0);
        assert.equal(field.alert(), undefined);
        assert.equal(app.error(), "");
    } finally { field.dispose(); }
}));

for (const action of ["apply", "clear"]) {
    test(`failed deadline ${action} retains the editor and error, then a successful retry closes it`, async () => withTaskDetails(async ({ app, view }) => {
        detailTrigger(view, "due").props.onClick(triggerEvent); await view.flush();
        const content = popoverContent(view);
        const panel = await mountTaskComponent(null, content.type, content.props);
        const button = () => panel.byClass(action === "apply" ? "task-primary-button" : "task-deadline-clear");
        try {
            button().props.onClick(); await panel.flush();
            assert.equal(button().props.disabled, true);
            await panel.settle(app.requests[0], null, new Error("Deadline save failed")); await app.flush(); await view.flush();
            assert.equal(app.error(), "Deadline save failed");
            assert.equal(panel.alert().props.children[0], "Deadline save failed");
            assert.equal(detailTrigger(view, "due").props["aria-expanded"], "true");
            assert.equal(button().props.disabled, false);
            const failedPayload = app.requests[0].body;
            button().props.onClick(); await panel.flush();
            assert.deepEqual(app.requests[1].body, failedPayload);
            await panel.settle(app.requests[1], { task: { ...task, ...app.requests[1].body } }); await app.flush(); await view.flush();
            assert.equal(popover(view).popover, null);
            assert.equal(detailTrigger(view, "due").props["aria-expanded"], "false");
            assert.equal(panel.alert(), undefined);
        } finally { panel.dispose(); }
    }));
}

for (const action of ["save", "clear"]) {
    test(`failed recurrence ${action} retains the repeat draft and a successful retry closes it`, async () => withTaskDetails(async ({ app, view }) => {
        detailTrigger(view, "repeat").props.onClick(triggerEvent); await view.flush();
        popoverContent(view).props.onChange({ ...task.recurrence, every: 3 }); await view.flush();
        const invoke = () => popoverContent(view).props[action === "save" ? "onDone" : "onClear"]();
        const first = invoke(); await view.flush();
        await view.settle(app.requests[0], null, new Error("Repeat save failed")); await app.flush();
        assert.deepEqual(await first, { ok: false, error: "Repeat save failed" });
        assert.equal(app.error(), "Repeat save failed");
        assert.equal(detailTrigger(view, "repeat").props["aria-expanded"], "true");
        assert.equal(popoverContent(view).props.recurrence.every, 3);
        assert.deepEqual(app.requests[0].body, { recurrence: action === "clear" ? null : { ...task.recurrence, every: 3 } });
        const retry = invoke(); await view.flush();
        assert.deepEqual(app.requests[1].body, app.requests[0].body);
        await view.settle(app.requests[1], { task: { ...task, ...app.requests[1].body } }); await app.flush(); await retry;
        assert.equal(popover(view).popover, null);
        assert.equal(detailTrigger(view, "repeat").props["aria-expanded"], "false");
    }));
}


test("shared task controls preserve accessible names, state, menu anchoring, and bubbling", async () => {
    const controls = await loadTaskModule("task-form-controls.js");
    const components = await loadTaskModule("task-components.js");
    assert.equal(components.MaterialIcon, controls.MaterialIcon);
    const icon = controls.MaterialIcon({ name: "more_vert", className: "menu-icon" });
    assert.equal(icon.props["aria-hidden"], "true");
    assert.equal(icon.props.className, "material-symbols-outlined menu-icon");
    assert.equal(icon.props.children[0], "more_vert");
    const button = controls.iconButton({ icon: "check", label: "Complete task", active: true, disabled: true, title: "Complete now" });
    assert.equal(button.props.type, "button");
    assert.equal(button.props["aria-label"], "Complete task");
    assert.equal(button.props.title, "Complete now");
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.className, "task-icon-button is-on");
    const anchor = { top: 10, right: 50, bottom: 30, left: 20 };
    for (const stopPropagation of [false, true]) {
        let stopped = 0;
        let opened;
        const trigger = controls.menuTrigger({ id: "school", kind: "list", label: "List options", stopPropagation,
            onOpen: (...args) => { opened = args; } });
        assert.equal(trigger.props["data-task-menu-trigger"], "list:school");
        trigger.props.onClick({ stopPropagation() { stopped += 1; }, currentTarget: { getBoundingClientRect: () => anchor } });
        assert.equal(stopped, Number(stopPropagation));
        assert.deepEqual(opened, ["school", { anchor }]);
    }
    let position;
    controls.menuTrigger({ id: "one", kind: "task", onOpen: (_id, next) => { position = next; },
        getPosition: () => ({ top: 7, left: 9 }) }).props.onClick({});
    assert.deepEqual(position, { top: 7, left: 9 });
});

test('malformed task recurrence success keeps the actual editor draft for a valid retry', async () => withTaskDetails(async ({ app, view }) => {
    detailTrigger(view, 'repeat').props.onClick(triggerEvent); await view.flush();
    popoverContent(view).props.onChange({ ...task.recurrence, every: 3 }); await view.flush();
    const first = popoverContent(view).props.onDone(); await view.flush();
    await app.settle(app.requests[0], new Response('<html>Log in</html>', { headers: { 'Content-Type': 'text/html' } }));
    assert.deepEqual(await first, { ok: false, error: 'Invalid JSON response.' });
    await view.flush();
    assert.equal(detailTrigger(view, 'repeat').props['aria-expanded'], 'true');
    assert.equal(popoverContent(view).props.recurrence.every, 3);
    assert.match(app.error(), /Invalid JSON response/);
    const retry = popoverContent(view).props.onDone(); await view.flush();
    assert.deepEqual(app.requests[1].body, app.requests[0].body);
    await app.settle(app.requests[1], { task: { ...task, recurrence: { ...task.recurrence, every: 3 } } });
    await retry; await view.flush();
    assert.equal(popover(view).popover, null);
    assert.equal(app.error(), '');
}));

test('actual Task options click opens anchored configure, move and delete entries', async () => {
    const initialTask = { ...task, recurrence: null };
    const app = await mountTasksApp({
        lists: [{ id: 'school', name: 'School' }, { id: 'personal', name: 'Personal' }],
        tasks: [initialTask, { ...initialTask, id: 'two', title: 'Second task', order: 2000 }],
        preferences: { task_sound_enabled: false },
    });
    let expanded;
    const row = await mountTaskComponent('task-entry-components.js', 'TaskRow', {
        ...app.section(), task: initialTask, isExpanded: false, setExpandedTaskId: id => { expanded = id; },
    });
    let menu;
    const anchor = { top: 10, right: 50, bottom: 30, left: 10 };
    const open = async () => {
        row.byLabel('Task options').props.onClick(triggerEvent); await app.flush();
        assert.deepEqual(app.menu().anchor, anchor);
        if (menu) await menu.render(app.actionMenu());
        else menu = await mountTaskComponent('task-components.js', 'ActionMenu', app.actionMenu());
    };
    const entry = label => menu.find(element => element.props?.role === 'menuitem' && element.props.children[1]?.props.children[0] === label);
    try {
        await open();
        assert.equal(entry('Move task earlier').props.disabled, true);
        assert.equal(entry('Move task later').props.disabled, false);
        entry('Configure task').props.onClick();
        assert.equal(expanded, 'one');
        await app.flush(); assert.equal(app.menu(), null); await open();
        entry('Move task later').props.onClick(); await app.flush();
        assert.deepEqual(app.requests[0].body.tasks.map(item => item.id), ['two', 'one']);
        await app.settle(app.requests[0], {});
        await app.flush(); assert.equal(app.menu(), null); await open();
        entry('Move to Personal').props.onClick(); await app.flush();
        assert.equal(app.requests[1].body.tasks.find(item => item.id === 'one').list_id, 'personal');
        await app.settle(app.requests[1], {});
        assert.deepEqual(app.section('personal').tasks.map(item => item.id), ['one']);
        await app.flush(); assert.equal(app.menu(), null); await open();
        entry('Delete task').props.onClick(); await app.flush();
        assert.equal(app.undo.length, 1);
        assert.equal(app.section('personal').tasks.length, 0);
        assert.equal(app.requests.length, 2, 'delete entry stages its undo window before sending');
        const deletion = app.undo[0].commit({ reason: 'commit' });
        assert.equal(app.requests[2].method, 'DELETE');
        assert.equal(app.requests[2].url, '/api/tasks/one');
        await app.settle(app.requests[2], {}); await deletion;
    } finally { menu?.dispose(); row.dispose(); app.dispose(); }
});
