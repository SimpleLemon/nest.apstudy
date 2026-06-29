import { ActionMenu, EmptyStarter, ListEditorDialog, ListRail, MaterialIcon, TaskSection } from "./task-components.js";
import {
    PrintSheet,
    groupTasksByList,
    listMenuItems,
    mergeById,
    removeById,
    replaceById,
    requestDestructiveAction,
    taskMenuItems,
    toggleActionMenu,
} from "./task-app-helpers.js";
import {
    appendTask,
    applyListOrderUpdates,
    applyTaskOrderUpdates,
    buildCompletedTaskOptimistic,
    buildListOrderUpdates,
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
    normalizeList,
    normalizeTask,
    sortedLists,
} from "./task-utils.js";
import { createTaskSounds } from "./task-audio.js";
import * as React from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

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
    const highlightTaskId = React.useMemo(() => new URLSearchParams(window.location.search).get("task") || "", []);
    const sounds = React.useMemo(() => createTaskSounds({ completeSound, uncompleteSound }), [completeSound, uncompleteSound]);

    React.useEffect(() => {
        if (error && window.APStudyToast) {
            window.APStudyToast.error(error);
        }
    }, [error]);
    const listsRef = React.useRef(lists);
    const tasksRef = React.useRef(tasks);
    const listMutationVersionsRef = React.useRef(new Map());

    const setListsAndRef = React.useCallback((nextListsOrUpdater) => {
        setLists((current) => {
            const nextLists = typeof nextListsOrUpdater === "function" ? nextListsOrUpdater(current) : nextListsOrUpdater;
            listsRef.current = nextLists;
            return nextLists;
        });
    }, []);

    const setTasksAndRef = React.useCallback((nextTasksOrUpdater) => {
        setTasks((current) => {
            const nextTasks = typeof nextTasksOrUpdater === "function" ? nextTasksOrUpdater(current) : nextTasksOrUpdater;
            tasksRef.current = nextTasks;
            return nextTasks;
        });
    }, []);

    React.useEffect(() => {
        listsRef.current = lists;
    }, [lists]);

    React.useEffect(() => {
        tasksRef.current = tasks;
    }, [tasks]);

    React.useEffect(() => () => sounds.dispose(), [sounds]);

    const listById = React.useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);

    const tasksByList = React.useMemo(() => {
        return groupTasksByList(lists, tasks, listById);
    }, [lists, listById, tasks]);
    const listByIdRef = React.useRef(listById);
    const tasksByListRef = React.useRef(tasksByList);
    listByIdRef.current = listById;
    tasksByListRef.current = tasksByList;

    const orderedLists = React.useMemo(() => sortedLists(lists), [lists]);
    const visibleOrderedLists = React.useMemo(() => orderedLists.filter((list) => !list.hidden), [orderedLists]);
    const allListsHidden = lists.length > 0 && visibleOrderedLists.length === 0;

    const load = React.useCallback(async () => {
        setError("");
        try {
            const { lists: nextLists, tasks: nextTasks, preferences } = await fetchTaskBoard();
            setListsAndRef(nextLists);
            setTasksAndRef(nextTasks);
            setSoundEnabled(preferences?.task_sound_enabled !== false);
            if (highlightTaskId) {
                const match = nextTasks.find((task) => task.id === highlightTaskId || task.$id === highlightTaskId);
                const matchList = match ? nextLists.find((list) => list.id === match.list_id) : null;
                if (match && matchList && !matchList.hidden) {
                    setSelectedListId(match.list_id || "all");
                    setExpandedTaskId(match.id);
                }
            } else setSelectedListId((current) => (
                current !== "all" && current !== "starred" && !nextLists.some((list) => list.id === current && !list.hidden)
                    ? "all"
                    : current
            ));
        } catch (err) {
            setError(err.message || "Unable to load tasks.");
        } finally {
            setLoading(false);
        }
    }, [highlightTaskId, setListsAndRef, setTasksAndRef]);

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
        setTasksAndRef((current) => replaceById(current, updatedTask.id, normalizeTask(updatedTask)));
    }, [setTasksAndRef]);

    const createList = React.useCallback(async ({ name, description = "" }) => {
        const listName = (name || "New List").trim();
        if (!listName) return;
        setError("");
        try {
            const created = await createTaskList({ name: listName, description });
            setListsAndRef((current) => sortedLists([...current, created]));
            setSelectedListId(created.id);
            setListDialog(null);
        } catch (err) {
            setError(err.message || "Unable to create list.");
        }
    }, [setListsAndRef]);

    const updateList = React.useCallback(async (listId, updates) => {
        const previousLists = listsRef.current;
        const versions = listMutationVersionsRef.current;
        const version = (versions.get(listId) || 0) + 1;
        versions.set(listId, version);
        const nextUpdates = { ...updates };
        setListsAndRef((current) => mergeById(current, listId, nextUpdates, normalizeList));
        if (nextUpdates.hidden) {
            setSelectedListId((current) => current === listId ? "all" : current);
        }
        try {
            const updatedList = await updateTaskList(listId, nextUpdates);
            if (versions.get(listId) !== version) return;
            setListsAndRef((current) => sortedLists(replaceById(current, listId, updatedList)));
        } catch (err) {
            if (versions.get(listId) !== version) return;
            setError(err.message || "Unable to update list.");
            setListsAndRef(previousLists);
        }
    }, [setListsAndRef]);

    const toggleListVisibility = React.useCallback((listId) => {
        const currentList = listsRef.current.find((list) => list.id === listId);
        if (!currentList) return;
        updateList(listId, { hidden: !currentList.hidden });
    }, [updateList]);

    const deleteList = React.useCallback(async (listId) => {
        const list = listByIdRef.current.get(listId);
        const accepted = await requestDestructiveAction({
            title: "Delete list?",
            message: `Delete "${list?.name || "this list"}" and every task inside it? This cannot be undone.`,
            acceptLabel: "Delete list",
        });
        if (!accepted) return;
        const previousLists = listsRef.current;
        const previousTasks = tasksRef.current;
        setListsAndRef((current) => removeById(current, listId));
        setTasksAndRef((current) => current.filter((task) => task.list_id !== listId));
        setSelectedListId((current) => current === listId ? "all" : current);
        try {
            await destroyTaskList(listId);
        } catch (err) {
            setError(err.message || "Unable to delete list.");
            setListsAndRef(previousLists);
            setTasksAndRef(previousTasks);
        }
    }, [setListsAndRef, setTasksAndRef]);

    const deleteCompletedTasks = React.useCallback(async (listId) => {
        const list = listByIdRef.current.get(listId);
        const accepted = await requestDestructiveAction({
            title: "Delete completed tasks?",
            message: `Delete completed tasks in "${list?.name || "this list"}"? Recurring task definitions will stay, but completed occurrences will be cleared.`,
            acceptLabel: "Delete completed",
        });
        if (!accepted) return;
        const previousTasks = tasksRef.current;
        setTasksAndRef((current) => removeCompletedTasksFromList(current, listId));
        try {
            await destroyCompletedTasks(listId);
        } catch (err) {
            setError(err.message || "Unable to delete completed tasks.");
            setTasksAndRef(previousTasks);
        }
    }, [setTasksAndRef]);

    const createTask = React.useCallback(async (listId, draft) => {
        setError("");
        try {
            const task = await createTaskRecord(listId, draft);
            setTasksAndRef((current) => appendTask(current, task));
        } catch (err) {
            setError(err.message || "Unable to create task.");
            throw err;
        }
    }, [setTasksAndRef]);

    const updateTask = React.useCallback(async (taskId, updates) => {
        const previous = tasksRef.current;
        setTasksAndRef((current) => mergeById(current, taskId, updates, normalizeTask));
        try {
            updateTaskInState(await updateTaskRecord(taskId, updates));
        } catch (err) {
            setError(err.message || "Unable to update task.");
            setTasksAndRef(previous);
        }
    }, [setTasksAndRef, updateTaskInState]);

    const deleteTask = React.useCallback(async (taskId) => {
        const task = tasksRef.current.find((item) => item.id === taskId);
        const accepted = await requestDestructiveAction({
            title: "Delete task?",
            message: `Delete "${task?.title || "this task"}"? This cannot be undone.`,
            acceptLabel: "Delete task",
        });
        if (!accepted) return;
        const previous = tasksRef.current;
        setTasksAndRef((current) => removeById(current, taskId));
        try {
            await destroyTaskRecord(taskId);
        } catch (err) {
            setError(err.message || "Unable to delete task.");
            setTasksAndRef(previous);
        }
    }, [setTasksAndRef]);

    const completeTask = React.useCallback(async (task, completed) => {
        const previous = tasksRef.current;
        const optimistic = buildCompletedTaskOptimistic(task, completed);
        setTasksAndRef((current) => replaceById(current, task.id, optimistic.task));
        completed ? sounds.playComplete(soundEnabled) : sounds.playUncomplete(soundEnabled);
        try {
            updateTaskInState(await completeTaskRecord(task.id, completed, optimistic.occurrenceKey));
        } catch (err) {
            setError(err.message || "Unable to update completion.");
            setTasksAndRef(previous);
        }
    }, [setTasksAndRef, soundEnabled, sounds, updateTaskInState]);

    const reorderLists = React.useCallback(async (orderedIds) => {
        const updates = buildListOrderUpdates(orderedIds);
        setListsAndRef((current) => applyListOrderUpdates(current, updates));
        try {
            await persistListOrder(updates);
        } catch (err) {
            setError(err.message || "Unable to reorder lists.");
            load();
        }
    }, [load, setListsAndRef]);

    const reorderTasks = React.useCallback(async () => {
        const updates = taskOrderUpdatesFromDocument();
        setTasksAndRef((current) => applyTaskOrderUpdates(current, updates));
        try {
            await persistTaskOrder(updates);
        } catch (err) {
            setError(err.message || "Unable to reorder tasks.");
            load();
        }
    }, [load, setTasksAndRef]);

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
        const list = listByIdRef.current.get(listId);
        if (!list) return;
        const listTasks = tasksByListRef.current.get(listId) || [];
        toggleActionMenu(setActionMenu, "list", listId, () => ({
            anchor: position.anchor,
            title: "Sort by",
            items: listMenuItems({ list, listTasks, updateList, openListDialog, printListById, deleteCompletedTasks, deleteList }),
        }));
    }, [deleteCompletedTasks, deleteList, openListDialog, printListById, updateList]);

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
        const loaderHtml = window.APStudyLoader?.html
            ? window.APStudyLoader.html("Loading tasks...", { sizePx: 54, textToneClass: "text-on-surface" })
            : '<span class="loader" style="width:54px; height:54px;" aria-hidden="true"></span><span>Loading tasks...</span>';
        return h("div", {
            className: "task-loading",
            dangerouslySetInnerHTML: { __html: loaderHtml },
        });
    }

    return h(React.Fragment, null,
        h("div", { className: "task-app" },
            h("header", { className: "task-header" },
                h("div", null,
                    h("h1", { className: "task-title workspace-page-title" }, "Tasks"),
                    h("p", { className: "task-subtitle" }, "Lists, deadlines, repeat schedules, and calendar-synced work.")
                )
            ),
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
                        toggleListVisibility,
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
