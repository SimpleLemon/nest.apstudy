import * as React from "react";
import { createRoot } from "react-dom/client";
import useSound from "use-sound";

const h = React.createElement;
const SOUND_STORAGE_KEY = "apstudy-task-sound-enabled";
const DEFAULT_LIST_NAMES = ["School", "Research", "Personal"];
const PRIORITY_OPTIONS = [
    { value: "none", label: "None" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
];
const REPEAT_UNITS = [
    { value: "day", label: "day(s)" },
    { value: "week", label: "week(s)" },
    { value: "month", label: "month(s)" },
    { value: "year", label: "year(s)" },
];

function todayDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isoToLocalInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatDeadline(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function formatRepeat(recurrence) {
    if (!recurrence) return "";
    const every = Number(recurrence.every || 1);
    const unit = recurrence.unit || "day";
    return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
}

function normalizeTask(task) {
    return {
        ...task,
        priority: task.priority || "none",
        completed_occurrences: Array.isArray(task.completed_occurrences) ? task.completed_occurrences : [],
    };
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
    }
    return payload;
}

function clearCalendarCache() {
    try {
        localStorage.removeItem("calendarEventsCache");
    } catch (_) {
        // Ignore storage failures.
    }
}

function getSoundPreference() {
    try {
        return localStorage.getItem(SOUND_STORAGE_KEY) !== "false";
    } catch (_) {
        return true;
    }
}

function saveSoundPreference(enabled) {
    try {
        localStorage.setItem(SOUND_STORAGE_KEY, String(Boolean(enabled)));
    } catch (_) {
        // Ignore storage failures.
    }
}

function isRepeatingTaskCompleted(task) {
    if (!task?.recurrence) return Boolean(task?.completed);
    const key = task.next_occurrence_key;
    return Boolean(key && task.completed_occurrences?.some((item) => item.occurrence_key === key));
}

function sortedLists(lists) {
    return [...lists].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.name || "").localeCompare(b.name || ""));
}

function sortedTasks(tasks) {
    return [...tasks].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || "").localeCompare(b.title || ""));
}

function MaterialIcon({ name, className = "" }) {
    return h("span", { className: `material-symbols-outlined ${className}`, "aria-hidden": "true" }, name);
}

function TaskApp({ completeSound, uncompleteSound }) {
    const [lists, setLists] = React.useState([]);
    const [tasks, setTasks] = React.useState([]);
    const [selectedListId, setSelectedListId] = React.useState("all");
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");
    const [newListName, setNewListName] = React.useState("");
    const [expandedTaskId, setExpandedTaskId] = React.useState("");
    const [soundEnabled, setSoundEnabled] = React.useState(getSoundPreference);
    const highlightTaskId = new URLSearchParams(window.location.search).get("task") || "";
    const [playComplete] = useSound(completeSound, { volume: soundEnabled ? 0.55 : 0, interrupt: true });
    const [playUncomplete] = useSound(uncompleteSound, { volume: soundEnabled ? 0.35 : 0, playbackRate: 0.86, interrupt: true });

    const tasksByList = React.useMemo(() => {
        const grouped = new Map();
        for (const list of lists) grouped.set(list.id, []);
        for (const task of tasks) {
            const listTasks = grouped.get(task.list_id) || [];
            listTasks.push(task);
            grouped.set(task.list_id, listTasks);
        }
        for (const [listId, listTasks] of grouped) grouped.set(listId, sortedTasks(listTasks));
        return grouped;
    }, [lists, tasks]);

    const load = React.useCallback(async () => {
        setError("");
        try {
            const payload = await fetchJson("/api/tasks");
            const nextLists = sortedLists(payload.lists || []);
            const nextTasks = (payload.tasks || []).map(normalizeTask);
            setLists(nextLists);
            setTasks(nextTasks);
            if (highlightTaskId) {
                const match = nextTasks.find((task) => task.id === highlightTaskId || task.$id === highlightTaskId);
                if (match) {
                    setSelectedListId(match.list_id || "all");
                    setExpandedTaskId(match.id);
                }
            } else if (selectedListId !== "all" && !nextLists.some((list) => list.id === selectedListId)) {
                setSelectedListId("all");
            }
        } catch (err) {
            setError(err.message || "Unable to load tasks.");
        } finally {
            setLoading(false);
        }
    }, [highlightTaskId, selectedListId]);

    React.useEffect(() => {
        load();
    }, []);

    const updateTaskInState = React.useCallback((updatedTask) => {
        setTasks((current) => current.map((task) => task.id === updatedTask.id ? normalizeTask(updatedTask) : task));
    }, []);

    const createList = React.useCallback(async (name) => {
        const listName = (name || newListName || "New List").trim();
        if (!listName) return;
        setSaving(true);
        setError("");
        try {
            const payload = await fetchJson("/api/task-lists", {
                method: "POST",
                body: JSON.stringify({ name: listName }),
            });
            setLists((current) => sortedLists([...current, payload.list]));
            setSelectedListId(payload.list.id);
            setNewListName("");
        } catch (err) {
            setError(err.message || "Unable to create list.");
        } finally {
            setSaving(false);
        }
    }, [newListName]);

    const updateList = React.useCallback(async (listId, updates) => {
        setLists((current) => current.map((list) => list.id === listId ? { ...list, ...updates } : list));
        try {
            const payload = await fetchJson(`/api/task-lists/${encodeURIComponent(listId)}`, {
                method: "PATCH",
                body: JSON.stringify(updates),
            });
            setLists((current) => sortedLists(current.map((list) => list.id === listId ? payload.list : list)));
        } catch (err) {
            setError(err.message || "Unable to update list.");
            load();
        }
    }, [load]);

    const deleteList = React.useCallback(async (listId) => {
        if (!window.confirm("Delete this list and its tasks?")) return;
        setLists((current) => current.filter((list) => list.id !== listId));
        setTasks((current) => current.filter((task) => task.list_id !== listId));
        if (selectedListId === listId) setSelectedListId("all");
        try {
            await fetchJson(`/api/task-lists/${encodeURIComponent(listId)}`, { method: "DELETE" });
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to delete list.");
            load();
        }
    }, [load, selectedListId]);

    const createTask = React.useCallback(async (listId, draft) => {
        setError("");
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const deadlineAt = localInputToIso(draft.deadline_at);
        const payload = {
            list_id: listId,
            title: draft.title,
            priority: draft.priority || "none",
            deadline_at: deadlineAt,
            deadline_time: draft.deadline_at ? draft.deadline_at.slice(11, 16) : null,
            timezone,
            recurrence: draft.recurrence || null,
        };
        try {
            const response = await fetchJson("/api/tasks", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            setTasks((current) => sortedTasks([...current, normalizeTask(response.task)]));
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to create task.");
            throw err;
        }
    }, []);

    const updateTask = React.useCallback(async (taskId, updates) => {
        const previous = tasks;
        setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...updates } : task));
        try {
            const response = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
                method: "PATCH",
                body: JSON.stringify(updates),
            });
            updateTaskInState(response.task);
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to update task.");
            setTasks(previous);
        }
    }, [tasks, updateTaskInState]);

    const deleteTask = React.useCallback(async (taskId) => {
        if (!window.confirm("Delete this task?")) return;
        const previous = tasks;
        setTasks((current) => current.filter((task) => task.id !== taskId));
        try {
            await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to delete task.");
            setTasks(previous);
        }
    }, [tasks]);

    const completeTask = React.useCallback(async (task, completed) => {
        const previous = tasks;
        const nextTask = task.recurrence
            ? {
                ...task,
                completed_occurrences: completed
                    ? [...task.completed_occurrences, { occurrence_key: task.next_occurrence_key || "single", completed_at: new Date().toISOString() }]
                    : task.completed_occurrences.filter((item) => item.occurrence_key !== (task.next_occurrence_key || "single")),
            }
            : { ...task, completed, completed_at: completed ? new Date().toISOString() : null };
        setTasks((current) => current.map((item) => item.id === task.id ? nextTask : item));
        if (soundEnabled) {
            completed ? playComplete() : playUncomplete();
        }
        try {
            const response = await fetchJson(`/api/tasks/${encodeURIComponent(task.id)}/complete`, {
                method: "POST",
                body: JSON.stringify({
                    completed,
                    occurrence_key: task.recurrence ? task.next_occurrence_key : "single",
                }),
            });
            updateTaskInState(response.task);
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to update completion.");
            setTasks(previous);
        }
    }, [playComplete, playUncomplete, soundEnabled, tasks, updateTaskInState]);

    const reorderLists = React.useCallback(async (orderedIds) => {
        const updates = orderedIds.map((id, index) => ({ id, order: (index + 1) * 1000 }));
        setLists((current) => sortedLists(current.map((list) => {
            const match = updates.find((item) => item.id === list.id);
            return match ? { ...list, order: match.order } : list;
        })));
        try {
            await fetchJson("/api/tasks/reorder", {
                method: "PATCH",
                body: JSON.stringify({ lists: updates }),
            });
        } catch (err) {
            setError(err.message || "Unable to reorder lists.");
            load();
        }
    }, [load]);

    const reorderTasks = React.useCallback(async () => {
        const containers = Array.from(document.querySelectorAll("[data-task-list-body]"));
        const updates = [];
        containers.forEach((container) => {
            const listId = container.getAttribute("data-list-id");
            Array.from(container.querySelectorAll("[data-task-id]")).forEach((row, index) => {
                updates.push({ id: row.getAttribute("data-task-id"), list_id: listId, order: (index + 1) * 1000 });
            });
        });
        setTasks((current) => current.map((task) => {
            const match = updates.find((item) => item.id === task.id);
            return match ? { ...task, list_id: match.list_id, order: match.order } : task;
        }));
        try {
            await fetchJson("/api/tasks/reorder", {
                method: "PATCH",
                body: JSON.stringify({ tasks: updates }),
            });
            clearCalendarCache();
        } catch (err) {
            setError(err.message || "Unable to reorder tasks.");
            load();
        }
    }, [load]);

    const toggleSound = React.useCallback(() => {
        setSoundEnabled((current) => {
            const next = !current;
            saveSoundPreference(next);
            return next;
        });
    }, []);

    const visibleLists = selectedListId === "all"
        ? sortedLists(lists)
        : sortedLists(lists).filter((list) => list.id === selectedListId);

    if (loading) {
        return h("div", { className: "task-loading" },
            h("span", { className: "loader", style: { width: "54px", height: "54px" }, "aria-hidden": "true" }),
            h("span", null, "Loading tasks...")
        );
    }

    return h("div", { className: "task-app" },
        h("header", { className: "task-header" },
            h("div", null,
                h("h1", { className: "task-title" }, "Tasks"),
                h("p", { className: "task-subtitle" }, "Lists, deadlines, repeat schedules, and calendar-synced work.")
            ),
            h("div", { className: "task-header-actions" },
                h("button", {
                    className: `task-icon-button ${soundEnabled ? "is-on" : ""}`,
                    type: "button",
                    onClick: toggleSound,
                    "aria-label": soundEnabled ? "Mute task sounds" : "Enable task sounds",
                    title: soundEnabled ? "Mute task sounds" : "Enable task sounds",
                }, h(MaterialIcon, { name: soundEnabled ? "volume_up" : "volume_off" })),
                h("form", {
                    className: "task-list-create",
                    onSubmit: (event) => {
                        event.preventDefault();
                        createList();
                    },
                },
                    h("input", {
                        value: newListName,
                        onChange: (event) => setNewListName(event.target.value),
                        placeholder: "New list",
                        disabled: saving,
                    }),
                    h("button", { type: "submit", disabled: saving || !newListName.trim() }, h(MaterialIcon, { name: "add" }), h("span", null, "List"))
                )
            )
        ),
        error ? h("div", { className: "task-error", role: "alert" }, error) : null,
        lists.length === 0
            ? h(EmptyStarter, { onCreate: createList })
            : h("div", { className: "task-layout" },
                h(ListRail, {
                    lists,
                    selectedListId,
                    setSelectedListId,
                    tasksByList,
                    reorderLists,
                    updateList,
                    deleteList,
                }),
                h("section", { className: "task-workspace" },
                    visibleLists.map((list) => h(TaskSection, {
                        key: list.id,
                        list,
                        tasks: tasksByList.get(list.id) || [],
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
                    }))
                )
            )
    );
}

function EmptyStarter({ onCreate }) {
    return h("section", { className: "task-empty-panel" },
        h("div", { className: "task-empty-icon" }, h(MaterialIcon, { name: "checklist" })),
        h("h2", null, "Start with a list"),
        h("p", null, "Create a named list for school, research, personal work, or anything else you want to keep moving."),
        h("div", { className: "task-empty-actions" },
            DEFAULT_LIST_NAMES.map((name) => h("button", { key: name, type: "button", onClick: () => onCreate(name) }, name))
        )
    );
}

function ListRail({ lists, selectedListId, setSelectedListId, tasksByList, reorderLists }) {
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

function TaskSection(props) {
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

function AddTaskForm({ listId, createTask }) {
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
            } catch (_) {
                // The app-level error banner is set by createTask.
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

const mount = document.getElementById("task-root");
if (mount) {
    createRoot(mount).render(h(TaskApp, {
        completeSound: mount.dataset.completeSound || "/static/audio/task-pop.mp3",
        uncompleteSound: mount.dataset.uncompleteSound || "/static/audio/task-pop-down.mp3",
    }));
}
