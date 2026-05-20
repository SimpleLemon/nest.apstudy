import * as React from "react";

import {
    DEFAULT_LIST_NAMES,
    PRIORITY_OPTIONS,
    REPEAT_UNITS,
    formatDeadline,
    formatRepeat,
    isRepeatingTaskCompleted,
    isoToLocalInput,
    localInputToIso,
    sortedLists,
    todayDateString,
} from "./task-utils.js";

const h = React.createElement;

export function MaterialIcon({ name, className = "" }) {
    return h("span", { className: `material-symbols-outlined ${className}`, "aria-hidden": "true" }, name);
}

export function EmptyStarter({ onCreate }) {
    return h("section", { className: "task-empty-panel" },
        h("div", { className: "task-empty-icon" }, h(MaterialIcon, { name: "checklist" })),
        h("h2", null, "Start with a list"),
        h("p", null, "Create a named list for school, research, personal work, or anything else you want to keep moving."),
        h("div", { className: "task-empty-actions" },
            DEFAULT_LIST_NAMES.map((name) => h("button", { key: name, type: "button", onClick: () => onCreate(name) }, name))
        )
    );
}

export function ListRail({ lists, selectedListId, setSelectedListId, tasksByList, reorderLists }) {
    const railRef = React.useRef(null);
    React.useEffect(() => {
        if (!railRef.current || typeof window.Sortable === "undefined") return undefined;
        const sortable = window.Sortable.create(railRef.current, {
            animation: 150,
            draggable: ".task-list-nav-item",
            handle: ".task-drag-handle",
            ghostClass: "task-sortable-ghost",
            chosenClass: "task-sortable-chosen",
            onEnd: () => {
                const ids = Array.from(railRef.current.querySelectorAll("[data-list-id]")).map((item) => item.getAttribute("data-list-id"));
                reorderLists(ids);
            },
        });
        return () => sortable.destroy();
    }, [lists.map((list) => list.id).join("|"), reorderLists]);

    const totalTasks = lists.reduce((total, list) => total + (tasksByList.get(list.id)?.length || 0), 0);
    return h("aside", { className: "task-list-rail" },
        h("button", {
            type: "button",
            className: `task-list-all ${selectedListId === "all" ? "is-active" : ""}`,
            onClick: () => setSelectedListId("all"),
        },
            h(MaterialIcon, { name: "select_all" }),
            h("span", null, "All Lists"),
            h("strong", null, totalTasks)
        ),
        h("div", { ref: railRef, className: "task-list-nav" },
            sortedLists(lists).map((list) => {
                const count = tasksByList.get(list.id)?.length || 0;
                return h("button", {
                    key: list.id,
                    type: "button",
                    "data-list-id": list.id,
                    className: `task-list-nav-item ${selectedListId === list.id ? "is-active" : ""}`,
                    onClick: () => setSelectedListId(list.id),
                },
                    h("span", { className: "task-drag-handle", "aria-hidden": "true" }, h(MaterialIcon, { name: "drag_indicator" })),
                    h("span", { className: "task-list-nav-name" }, list.name),
                    h("strong", null, count)
                );
            })
        )
    );
}

export function TaskSection(props) {
    const {
        list,
        tasks,
        updateList,
        deleteList,
        createTask,
        updateTask,
        deleteTask,
        completeTask,
        expandedTaskId,
        setExpandedTaskId,
        reorderTasks,
        highlightTaskId,
    } = props;
    const [nameDraft, setNameDraft] = React.useState(list.name);
    const bodyRef = React.useRef(null);

    React.useEffect(() => {
        setNameDraft(list.name);
    }, [list.name]);

    React.useEffect(() => {
        if (!bodyRef.current || typeof window.Sortable === "undefined") return undefined;
        const sortable = window.Sortable.create(bodyRef.current, {
            group: { name: "tasks", pull: true, put: true },
            animation: 150,
            draggable: ".task-row",
            handle: ".task-row-drag",
            ghostClass: "task-sortable-ghost",
            chosenClass: "task-sortable-chosen",
            onEnd: reorderTasks,
        });
        return () => sortable.destroy();
    }, [list.id, tasks.map((task) => task.id).join("|"), reorderTasks]);

    const commitName = () => {
        const next = nameDraft.trim() || "Untitled List";
        if (next !== list.name) updateList(list.id, { name: next });
        setNameDraft(next);
    };

    return h("article", { className: "task-list-section" },
        h("div", { className: "task-list-section-header" },
            h("button", {
                type: "button",
                className: "task-icon-button task-collapse-button",
                onClick: () => updateList(list.id, { collapsed: !list.collapsed }),
                "aria-label": list.collapsed ? "Expand list" : "Collapse list",
            }, h(MaterialIcon, { name: list.collapsed ? "chevron_right" : "expand_more" })),
            h("input", {
                className: "task-list-title-input",
                value: nameDraft,
                onChange: (event) => setNameDraft(event.target.value),
                onBlur: commitName,
                onKeyDown: (event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                },
                "aria-label": "List name",
            }),
            h("span", { className: "task-list-count" }, `${tasks.length} task${tasks.length === 1 ? "" : "s"}`),
            h("button", {
                type: "button",
                className: "task-icon-button",
                onClick: () => deleteList(list.id),
                "aria-label": "Delete list",
                title: "Delete list",
            }, h(MaterialIcon, { name: "delete" }))
        ),
        !list.collapsed && h("div", { ref: bodyRef, className: "task-list-body", "data-task-list-body": "true", "data-list-id": list.id },
            tasks.length === 0
                ? h("div", { className: "task-list-empty" }, "No tasks in this list yet.")
                : tasks.map((task) => h(TaskRow, {
                    key: task.id,
                    task,
                    isExpanded: expandedTaskId === task.id,
                    setExpandedTaskId,
                    updateTask,
                    deleteTask,
                    completeTask,
                    highlighted: highlightTaskId && task.id === highlightTaskId,
                }))
        ),
        !list.collapsed && h(AddTaskForm, { listId: list.id, createTask })
    );
}

function TaskRow({ task, isExpanded, setExpandedTaskId, updateTask, deleteTask, completeTask, highlighted }) {
    const [titleDraft, setTitleDraft] = React.useState(task.title);
    const completed = isRepeatingTaskCompleted(task);
    React.useEffect(() => setTitleDraft(task.title), [task.title]);

    const commitTitle = () => {
        const next = titleDraft.trim();
        if (next && next !== task.title) updateTask(task.id, { title: next });
        if (!next) setTitleDraft(task.title);
    };

    return h("div", {
        className: `task-row ${completed ? "is-completed" : ""} ${highlighted ? "is-highlighted" : ""}`,
        "data-task-id": task.id,
    },
        h("div", { className: "task-row-main" },
            h("span", { className: "task-row-drag", "aria-hidden": "true" }, h(MaterialIcon, { name: "drag_indicator" })),
            h("button", {
                type: "button",
                className: `task-checkbox ${completed ? "is-checked" : ""}`,
                onClick: () => completeTask(task, !completed),
                "aria-label": completed ? "Mark task incomplete" : "Complete task",
            }, completed ? h(MaterialIcon, { name: "check" }) : null),
            h("div", { className: "task-title-wrap" },
                h("input", {
                    className: "task-title-input",
                    value: titleDraft,
                    onChange: (event) => setTitleDraft(event.target.value),
                    onBlur: commitTitle,
                    onKeyDown: (event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                    },
                    "aria-label": "Task title",
                }),
                h("span", { className: "task-title-strike", "aria-hidden": "true" })
            ),
            h(PriorityBadge, { priority: task.priority }),
            task.deadline_at ? h("span", { className: "task-row-meta" }, h(MaterialIcon, { name: "schedule" }), formatDeadline(task.deadline_at)) : null,
            task.recurrence ? h("span", { className: "task-row-meta" }, h(MaterialIcon, { name: "repeat" }), formatRepeat(task.recurrence)) : null,
            h("button", {
                type: "button",
                className: "task-icon-button",
                onClick: () => setExpandedTaskId(isExpanded ? "" : task.id),
                "aria-label": isExpanded ? "Close task options" : "Open task options",
            }, h(MaterialIcon, { name: "more_horiz" }))
        ),
        isExpanded ? h(TaskDetails, { task, updateTask, deleteTask }) : null
    );
}

function PriorityBadge({ priority }) {
    if (!priority || priority === "none") return null;
    return h("span", { className: `task-priority task-priority-${priority}` },
        h(MaterialIcon, { name: priority === "high" ? "priority_high" : "flag" }),
        priority
    );
}

function TaskDetails({ task, updateTask, deleteTask }) {
    const [repeatEnabled, setRepeatEnabled] = React.useState(Boolean(task.recurrence));
    const recurrence = task.recurrence || { every: 1, unit: "week", startDate: todayDateString(), endDate: null };
    React.useEffect(() => setRepeatEnabled(Boolean(task.recurrence)), [task.recurrence]);
    const patchRecurrence = (updates) => {
        const next = { ...recurrence, ...updates };
        updateTask(task.id, { recurrence: next });
    };

    return h("div", { className: "task-details" },
        h("label", null,
            h("span", null, "Priority"),
            h("select", {
                value: task.priority || "none",
                onChange: (event) => updateTask(task.id, { priority: event.target.value }),
            }, PRIORITY_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label)))
        ),
        h("label", null,
            h("span", null, "Deadline"),
            h("input", {
                type: "datetime-local",
                value: isoToLocalInput(task.deadline_at),
                onChange: (event) => updateTask(task.id, {
                    deadline_at: localInputToIso(event.target.value),
                    deadline_time: event.target.value ? event.target.value.slice(11, 16) : null,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                }),
            })
        ),
        h("label", { className: "task-repeat-toggle" },
            h("input", {
                type: "checkbox",
                checked: repeatEnabled,
                onChange: (event) => {
                    setRepeatEnabled(event.target.checked);
                    updateTask(task.id, { recurrence: event.target.checked ? recurrence : null });
                },
            }),
            h("span", null, "Repeat")
        ),
        repeatEnabled ? h("div", { className: "task-repeat-grid" },
            h("label", null,
                h("span", null, "Every"),
                h("input", {
                    type: "number",
                    min: "1",
                    max: "365",
                    value: recurrence.every || 1,
                    onChange: (event) => patchRecurrence({ every: Number(event.target.value || 1) }),
                })
            ),
            h("label", null,
                h("span", null, "Unit"),
                h("select", {
                    value: recurrence.unit || "week",
                    onChange: (event) => patchRecurrence({ unit: event.target.value }),
                }, REPEAT_UNITS.map((option) => h("option", { key: option.value, value: option.value }, option.label)))
            ),
            h("label", null,
                h("span", null, "Start"),
                h("input", {
                    type: "date",
                    value: recurrence.startDate || todayDateString(),
                    onChange: (event) => patchRecurrence({ startDate: event.target.value || todayDateString() }),
                })
            ),
            h("label", null,
                h("span", null, "End"),
                h("input", {
                    type: "date",
                    value: recurrence.endDate || "",
                    onChange: (event) => patchRecurrence({ endDate: event.target.value || null }),
                })
            )
        ) : null,
        h("button", { type: "button", className: "task-danger-button", onClick: () => deleteTask(task.id) },
            h(MaterialIcon, { name: "delete" }),
            h("span", null, "Delete")
        )
    );
}

export function AddTaskForm({ listId, createTask }) {
    const [focused, setFocused] = React.useState(false);
    const [title, setTitle] = React.useState("");
    const [priority, setPriority] = React.useState("none");
    const [deadline, setDeadline] = React.useState("");
    const [repeatEnabled, setRepeatEnabled] = React.useState(false);
    const [recurrence, setRecurrence] = React.useState({ every: 1, unit: "week", startDate: todayDateString(), endDate: null });
    const [saving, setSaving] = React.useState(false);
    const expanded = focused || title || deadline || repeatEnabled || priority !== "none";

    const reset = () => {
        setTitle("");
        setPriority("none");
        setDeadline("");
        setRepeatEnabled(false);
        setRecurrence({ every: 1, unit: "week", startDate: todayDateString(), endDate: null });
    };

    return h("form", {
        className: `task-add-form ${expanded ? "is-expanded" : ""}`,
        onFocus: () => setFocused(true),
        onSubmit: async (event) => {
            event.preventDefault();
            if (!title.trim()) return;
            setSaving(true);
            try {
                await createTask(listId, {
                    title: title.trim(),
                    priority,
                    deadline_at: deadline,
                    recurrence: repeatEnabled ? recurrence : null,
                });
                reset();
            } catch (err) {
                console.warn("Task creation failed; app-level error banner was shown.", err);
            } finally {
                setSaving(false);
            }
        },
    },
        h("div", { className: "task-add-primary" },
            h(MaterialIcon, { name: "add_task" }),
            h("input", {
                value: title,
                onChange: (event) => setTitle(event.target.value),
                onBlur: () => setFocused(false),
                placeholder: "Add a task",
                disabled: saving,
            }),
            h("button", { type: "submit", disabled: saving || !title.trim() }, "Add")
        ),
        expanded ? h("div", { className: "task-add-details" },
            h("select", { value: priority, onChange: (event) => setPriority(event.target.value) },
                PRIORITY_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))
            ),
            h("input", { type: "datetime-local", value: deadline, onChange: (event) => setDeadline(event.target.value) }),
            h("label", { className: "task-repeat-toggle" },
                h("input", { type: "checkbox", checked: repeatEnabled, onChange: (event) => setRepeatEnabled(event.target.checked) }),
                h("span", null, "Repeat")
            ),
            repeatEnabled ? h("div", { className: "task-repeat-grid task-repeat-grid-compact" },
                h("input", {
                    type: "number",
                    min: "1",
                    max: "365",
                    value: recurrence.every,
                    onChange: (event) => setRecurrence((current) => ({ ...current, every: Number(event.target.value || 1) })),
                    "aria-label": "Repeat every",
                }),
                h("select", {
                    value: recurrence.unit,
                    onChange: (event) => setRecurrence((current) => ({ ...current, unit: event.target.value })),
                    "aria-label": "Repeat unit",
                }, REPEAT_UNITS.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
                h("input", {
                    type: "date",
                    value: recurrence.startDate,
                    onChange: (event) => setRecurrence((current) => ({ ...current, startDate: event.target.value || todayDateString() })),
                    "aria-label": "Repeat start date",
                }),
                h("input", {
                    type: "date",
                    value: recurrence.endDate || "",
                    onChange: (event) => setRecurrence((current) => ({ ...current, endDate: event.target.value || null })),
                    "aria-label": "Repeat end date",
                })
            ) : null
        ) : null
    );
}
