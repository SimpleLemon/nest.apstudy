import * as React from "react";
import { createRoot } from "react-dom/client";
import useSound from "use-sound";

import { EmptyStarter, ListRail, MaterialIcon, TaskSection } from "./task-components.js";
import {
    clearCalendarCache,
    fetchJson,
    getSoundPreference,
    localInputToIso,
    normalizeTask,
    saveSoundPreference,
    sortedLists,
    sortedTasks,
} from "./task-utils.js";

const h = React.createElement;

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

const mount = document.getElementById("task-root");
if (mount) {
    createRoot(mount).render(h(TaskApp, {
        completeSound: mount.dataset.completeSound || "/static/audio/task-pop.mp3",
        uncompleteSound: mount.dataset.uncompleteSound || "/static/audio/task-pop-down.mp3",
    }));
}
