import { ActionMenu, EmptyStarter, ListEditorDialog, ListRail, MaterialIcon, TaskSection } from "./task-components.js";
import {
    appendTask,
    applyListOrderUpdates,
    applyTaskOrderUpdates,
    buildCompletedTaskOptimistic,
    buildListOrderUpdates,
    completedForDeleteSweep,
    completeTaskRecord,
    createTaskList,
    createTaskRecord,
    destroyCompletedTasks,
    destroyTaskList,
    destroyTaskRecord,
    fetchTaskBoard,
    persistListOrder,
    persistTaskOrder,
    removeCompletedTasksFromList,
    taskOrderUpdatesFromDocument,
    updateTaskList,
    updateTaskRecord,
} from "./task-data.js";
import {
    LIST_SORT_OPTIONS,
    formatDeadline,
    formatRepeat,
    isRepeatingTaskCompleted,
    normalizeList,
    normalizeTask,
    sortTasksForList,
    sortedLists,
} from "./task-utils.js";
import * as React from "react";
import { createRoot } from "react-dom/client";
import useSound from "use-sound";

const h = React.createElement;

function PrintSheet({ list, tasks }) {
    if (!list) return null;
    return h("section", { className: "task-print-sheet", "aria-hidden": "true" },
        h("header", null,
            h("h1", null, list.name),
            list.description ? h("p", null, list.description) : null
        ),
        tasks.length
            ? h("ol", null, tasks.map((task) => {
                const completed = isRepeatingTaskCompleted(task);
                return h("li", { key: task.id, className: completed ? "is-completed" : "" },
                    h("div", { className: "task-print-title" }, task.title),
                    h("div", { className: "task-print-meta" },
                        task.priority && task.priority !== "none" ? h("span", null, `Priority: ${task.priority}`) : null,
                        task.deadline_at ? h("span", null, `Deadline: ${formatDeadline(task.deadline_at)}`) : null,
                        task.recurrence ? h("span", null, formatRepeat(task.recurrence)) : null,
                        completed ? h("span", null, "Completed") : null
                    )
                );
            }))
            : h("p", null, "No tasks in this list.")
    );
}

function replaceById(items, id, nextItem) {
    return items.map((item) => item.id === id ? nextItem : item);
}

function mergeById(items, id, updates, normalize) {
    const existing = items.find((item) => item.id === id);
    return existing ? replaceById(items, id, normalize({ ...existing, ...updates })) : items;
}

function removeById(items, id) {
    return items.filter((item) => item.id !== id);
}

function groupTasksByList(lists, tasks, listById) {
    const grouped = new Map(lists.map((list) => [list.id, []]));
    for (const task of tasks) {
        const listTasks = grouped.get(task.list_id) || [];
        listTasks.push(task);
        grouped.set(task.list_id, listTasks);
    }
    for (const [listId, listTasks] of grouped) {
        grouped.set(listId, sortTasksForList(listTasks, listById.get(listId)?.sort_mode));
    }
    return grouped;
}

function toggleActionMenu(setActionMenu, type, id, buildMenu) {
    setActionMenu((current) => current?.type === type && current.id === id
        ? null
        : { type, id, nonce: Date.now(), ...buildMenu() });
}

function listMenuItems({ list, listTasks, updateList, openListDialog, printListById, deleteCompletedTasks, deleteList }) {
    return [
        ...LIST_SORT_OPTIONS.map((option) => ({
            label: option.label,
            icon: option.icon,
            checked: (list.sort_mode || "default") === option.value,
            onClick: () => updateList(list.id, { sort_mode: option.value }),
        })),
        { separator: true },
        { label: "Rename list", icon: "edit", onClick: () => openListDialog({ mode: "edit", list }) },
        { label: "Print list", icon: "print", onClick: () => printListById(list.id) },
        {
            label: "Delete all completed tasks",
            icon: "playlist_remove",
            disabled: !listTasks.some(completedForDeleteSweep),
            onClick: () => deleteCompletedTasks(list.id),
        },
        { label: "Delete list", icon: "delete", danger: true, onClick: () => deleteList(list.id) },
    ];
}

function taskMenuItems(taskId, position, deleteTask) {
    return [
        { label: "Configure task", icon: "tune", onClick: () => position.configure?.() },
        { label: "Delete task", icon: "delete", danger: true, onClick: () => deleteTask(taskId) },
    ];
}

function requestDestructiveAction({ title, message, acceptLabel }) {
    return window.APStudyConfirm?.request?.({
        title,
        message,
        acceptLabel,
        danger: true,
    }) ?? Promise.resolve(false);
}

function TaskApp({ completeSound, uncompleteSound }) {
    const [lists, setLists] = React.useState([]);
    const [tasks, setTasks] = React.useState([]);
    const [selectedListId, setSelectedListId] = React.useState("all");
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState("");
    const [expandedTaskId, setExpandedTaskId] = React.useState("");
    const [soundEnabled, setSoundEnabled] = React.useState(true);
    const [listDialog, setListDialog] = React.useState(null);
    const [actionMenu, setActionMenu] = React.useState(null);
    const [printListId, setPrintListId] = React.useState("");
    const highlightTaskId = new URLSearchParams(window.location.search).get("task") || "";
    const [playComplete] = useSound(completeSound, { volume: soundEnabled ? 0.55 : 0, interrupt: true });
    const [playUncomplete] = useSound(uncompleteSound, { volume: soundEnabled ? 0.35 : 0, playbackRate: 0.86, interrupt: true });

    const listById = React.useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);

    const tasksByList = React.useMemo(() => {
        return groupTasksByList(lists, tasks, listById);
    }, [lists, listById, tasks]);

    const orderedLists = React.useMemo(() => sortedLists(lists), [lists]);
    const visibleOrderedLists = React.useMemo(() => orderedLists.filter((list) => !list.hidden), [orderedLists]);
    const allListsHidden = lists.length > 0 && visibleOrderedLists.length === 0;

    const load = React.useCallback(async () => {
        setError("");
        try {
            const { lists: nextLists, tasks: nextTasks, preferences } = await fetchTaskBoard();
            setLists(nextLists);
            setTasks(nextTasks);
            setSoundEnabled(preferences?.task_sound_enabled !== false);
            if (highlightTaskId) {
                const match = nextTasks.find((task) => task.id === highlightTaskId || task.$id === highlightTaskId);
                const matchList = match ? nextLists.find((list) => list.id === match.list_id) : null;
                if (match && matchList && !matchList.hidden) {
                    setSelectedListId(match.list_id || "all");
                    setExpandedTaskId(match.id);
                }
            } else if (selectedListId !== "all" && selectedListId !== "starred" && !nextLists.some((list) => list.id === selectedListId && !list.hidden)) {
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

    React.useEffect(() => {
        if (!printListId) return undefined;
        const clearPrintList = () => setPrintListId("");
        window.addEventListener("afterprint", clearPrintList, { once: true });
        const timer = window.setTimeout(() => window.print(), 60);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener("afterprint", clearPrintList);
        };
    }, [printListId]);

    const updateTaskInState = React.useCallback((updatedTask) => {
        setTasks((current) => replaceById(current, updatedTask.id, normalizeTask(updatedTask)));
    }, []);

    const createList = React.useCallback(async ({ name, description = "" }) => {
        const listName = (name || "New List").trim();
        if (!listName) return;
        setError("");
        try {
            const created = await createTaskList({ name: listName, description });
            setLists((current) => sortedLists([...current, created]));
            setSelectedListId(created.id);
            setListDialog(null);
        } catch (err) {
            setError(err.message || "Unable to create list.");
        }
    }, []);

    const updateList = React.useCallback(async (listId, updates) => {
        const previousLists = lists;
        const nextUpdates = { ...updates };
        setLists((current) => mergeById(current, listId, nextUpdates, normalizeList));
        if (nextUpdates.hidden && selectedListId === listId) setSelectedListId("all");
        try {
            const updatedList = await updateTaskList(listId, nextUpdates);
            setLists((current) => sortedLists(replaceById(current, listId, updatedList)));
        } catch (err) {
            setError(err.message || "Unable to update list.");
            setLists(previousLists);
        }
    }, [lists, selectedListId]);

    const deleteList = React.useCallback(async (listId) => {
        const list = listById.get(listId);
        const accepted = await requestDestructiveAction({
            title: "Delete list?",
            message: `Delete "${list?.name || "this list"}" and every task inside it? This cannot be undone.`,
            acceptLabel: "Delete list",
        });
        if (!accepted) return;
        const previousLists = lists;
        const previousTasks = tasks;
        setLists((current) => removeById(current, listId));
        setTasks((current) => current.filter((task) => task.list_id !== listId));
        if (selectedListId === listId) setSelectedListId("all");
        try {
            await destroyTaskList(listId);
        } catch (err) {
            setError(err.message || "Unable to delete list.");
            setLists(previousLists);
            setTasks(previousTasks);
        }
    }, [listById, lists, selectedListId, tasks]);

    const deleteCompletedTasks = React.useCallback(async (listId) => {
        const list = listById.get(listId);
        const accepted = await requestDestructiveAction({
            title: "Delete completed tasks?",
            message: `Delete completed tasks in "${list?.name || "this list"}"? Recurring task definitions will stay, but completed occurrences will be cleared.`,
            acceptLabel: "Delete completed",
        });
        if (!accepted) return;
        const previousTasks = tasks;
        setTasks((current) => removeCompletedTasksFromList(current, listId));
        try {
            await destroyCompletedTasks(listId);
        } catch (err) {
            setError(err.message || "Unable to delete completed tasks.");
            setTasks(previousTasks);
        }
    }, [listById, tasks]);

    const createTask = React.useCallback(async (listId, draft) => {
        setError("");
        try {
            const task = await createTaskRecord(listId, draft);
            setTasks((current) => appendTask(current, task));
        } catch (err) {
            setError(err.message || "Unable to create task.");
            throw err;
        }
    }, []);

    const updateTask = React.useCallback(async (taskId, updates) => {
        const previous = tasks;
        setTasks((current) => mergeById(current, taskId, updates, normalizeTask));
        try {
            updateTaskInState(await updateTaskRecord(taskId, updates));
        } catch (err) {
            setError(err.message || "Unable to update task.");
            setTasks(previous);
        }
    }, [tasks, updateTaskInState]);

    const deleteTask = React.useCallback(async (taskId) => {
        const task = tasks.find((item) => item.id === taskId);
        const accepted = await requestDestructiveAction({
            title: "Delete task?",
            message: `Delete "${task?.title || "this task"}"? This cannot be undone.`,
            acceptLabel: "Delete task",
        });
        if (!accepted) return;
        const previous = tasks;
        setTasks((current) => removeById(current, taskId));
        try {
            await destroyTaskRecord(taskId);
        } catch (err) {
            setError(err.message || "Unable to delete task.");
            setTasks(previous);
        }
    }, [tasks]);

    const completeTask = React.useCallback(async (task, completed) => {
        const previous = tasks;
        const optimistic = buildCompletedTaskOptimistic(task, completed);
        setTasks((current) => replaceById(current, task.id, optimistic.task));
        if (soundEnabled) {
            completed ? playComplete() : playUncomplete();
        }
        try {
            updateTaskInState(await completeTaskRecord(task.id, completed, optimistic.occurrenceKey));
        } catch (err) {
            setError(err.message || "Unable to update completion.");
            setTasks(previous);
        }
    }, [playComplete, playUncomplete, soundEnabled, tasks, updateTaskInState]);

    const reorderLists = React.useCallback(async (orderedIds) => {
        const updates = buildListOrderUpdates(orderedIds);
        setLists((current) => applyListOrderUpdates(current, updates));
        try {
            await persistListOrder(updates);
        } catch (err) {
            setError(err.message || "Unable to reorder lists.");
            load();
        }
    }, [load]);

    const reorderTasks = React.useCallback(async () => {
        const updates = taskOrderUpdatesFromDocument();
        setTasks((current) => applyTaskOrderUpdates(current, updates));
        try {
            await persistTaskOrder(updates);
        } catch (err) {
            setError(err.message || "Unable to reorder tasks.");
            load();
        }
    }, [load]);

    const openListDialog = React.useCallback((request) => {
        if (request?.mode === "quick") {
            createList({ name: request.name, description: "" });
            return;
        }
        setListDialog({ id: `${request.mode}-${request.list?.id || "new"}-${Date.now()}`, ...request });
    }, [createList]);

    const submitListDialog = React.useCallback(async (values) => {
        if (!listDialog) return;
        if (listDialog.mode === "create") {
            await createList(values);
            return;
        }
        if (listDialog.list?.id) {
            await updateList(listDialog.list.id, values);
            setListDialog(null);
        }
    }, [createList, listDialog, updateList]);

    const printListById = React.useCallback((listId) => {
        setPrintListId(listId);
    }, []);

    const openListMenu = React.useCallback((listId, position) => {
        const list = listById.get(listId);
        if (!list) return;
        const listTasks = tasksByList.get(listId) || [];
        toggleActionMenu(setActionMenu, "list", listId, () => ({
            anchor: position.anchor,
            title: "Sort by",
            items: listMenuItems({ list, listTasks, updateList, openListDialog, printListById, deleteCompletedTasks, deleteList }),
        }));
    }, [deleteCompletedTasks, deleteList, listById, openListDialog, printListById, tasksByList, updateList]);

    const openTaskMenu = React.useCallback((taskId, position) => {
        toggleActionMenu(setActionMenu, "task", taskId, () => ({
            anchor: position.anchor,
            items: taskMenuItems(taskId, position, deleteTask),
        }));
    }, [deleteTask]);

    const workspaceLists = React.useMemo(() => {
        if (selectedListId === "all") return visibleOrderedLists;
        if (selectedListId === "starred") {
            return visibleOrderedLists
                .map((list) => ({ ...list, starredOnly: true }))
                .filter((list) => (tasksByList.get(list.id) || []).some((task) => task.starred));
        }
        const selected = listById.get(selectedListId);
        return selected && !selected.hidden ? [selected] : [];
    }, [listById, selectedListId, tasksByList, visibleOrderedLists]);

    const printListRecord = listById.get(printListId);
    const printTasks = printListRecord ? tasksByList.get(printListRecord.id) || [] : [];

    if (loading) {
        return h("div", { className: "task-loading" },
            h("span", { className: "loader", style: { width: "54px", height: "54px" }, "aria-hidden": "true" }),
            h("span", null, "Loading tasks...")
        );
    }

    return h(React.Fragment, null,
        h("div", { className: "task-app" },
            h("header", { className: "task-header" },
                h("div", null,
                    h("h1", { className: "task-title" }, "Tasks"),
                    h("p", { className: "task-subtitle" }, "Lists, deadlines, repeat schedules, and calendar-synced work.")
                )
            ),
            error ? h("div", { className: "task-error", role: "alert" }, error) : null,
            lists.length === 0
                ? h(EmptyStarter, { onCreate: openListDialog })
                : h("div", { className: "task-layout" },
                    h(ListRail, {
                        lists,
                        selectedListId,
                        setSelectedListId,
                        tasksByList,
                        reorderLists,
                        updateList,
                        openListDialog,
                        openListMenu,
                    }),
                    h("section", { className: "task-workspace" },
                        allListsHidden
                            ? h("section", { className: "task-hidden-empty" },
                                h(MaterialIcon, { name: "visibility_off" }),
                                h("h2", null, "All lists are hidden"),
                                h("p", null, "Select a list to see your tasks")
                            )
                            : workspaceLists.length === 0
                                ? h("section", { className: "task-hidden-empty" },
                                    h(MaterialIcon, { name: selectedListId === "starred" ? "star" : "checklist" }),
                                    h("h2", null, selectedListId === "starred" ? "No starred tasks yet" : "Select a list to see your tasks"),
                                    h("p", null, selectedListId === "starred" ? "Star a task from any visible list to pin it here." : "Choose All tasks, Starred, or a visible list.")
                                )
                                : workspaceLists.map((list) => {
                                    const listTasks = tasksByList.get(list.id) || [];
                                    const sectionTasks = list.starredOnly ? listTasks.filter((task) => task.starred) : listTasks;
                                    return h(TaskSection, {
                                        key: `${list.starredOnly ? "starred" : "list"}-${list.id}`,
                                        list,
                                        tasks: sectionTasks,
                                        updateList,
                                        createTask,
                                        updateTask,
                                        deleteTask,
                                        completeTask,
                                        expandedTaskId,
                                        setExpandedTaskId,
                                        reorderTasks,
                                        highlightTaskId,
                                        openListMenu,
                                        openTaskMenu,
                                    });
                                })
                    )
                ),
        ),
        h(ActionMenu, { menu: actionMenu, onClose: () => setActionMenu(null) }),
        h(ListEditorDialog, { dialog: listDialog, onClose: () => setListDialog(null), onSubmit: submitListDialog }),
        h(PrintSheet, { list: printListRecord, tasks: printTasks })
    );
}

const mount = document.getElementById("task-root");
if (mount) {
    createRoot(mount).render(h(TaskApp, {
        completeSound: mount.dataset.completeSound || "/static/audio/task-pop.mp3",
        uncompleteSound: mount.dataset.uncompleteSound || "/static/audio/task-pop-down.mp3",
    }));
}
