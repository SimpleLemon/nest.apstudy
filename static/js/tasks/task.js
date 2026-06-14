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
import * as React from "react";
import { createRoot } from "react-dom/client";
import useSound from "use-sound";

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
    const highlightTaskId = new URLSearchParams(window.location.search).get("task") || "";
    const [playComplete] = useSound(completeSound, { volume: soundEnabled ? 0.55 : 0, interrupt: true });

    React.useEffect(() => {
        if (error && window.APStudyToast) {
            window.APStudyToast.error(error);
        }
    }, [error]);
    const [playUncomplete] = useSound(uncompleteSound, { volume: soundEnabled ? 0.35 : 0, playbackRate: 0.86, interrupt: true });
    const listsRef = React.useRef(lists);
    const listMutationVersionsRef = React.useRef(new Map());

    const setListsAndRef = React.useCallback((nextListsOrUpdater) => {
        setLists((current) => {
            const nextLists = typeof nextListsOrUpdater === "function" ? nextListsOrUpdater(current) : nextListsOrUpdater;
            listsRef.current = nextLists;
            return nextLists;
        });
    }, []);

    React.useEffect(() => {
        listsRef.current = lists;
    }, [lists]);

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
            setListsAndRef(nextLists);
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
    }, [highlightTaskId, selectedListId, setListsAndRef]);

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
        const list = listById.get(listId);
        const accepted = await requestDestructiveAction({
            title: "Delete list?",
            message: `Delete "${list?.name || "this list"}" and every task inside it? This cannot be undone.`,
            acceptLabel: "Delete list",
        });
        if (!accepted) return;
        const previousLists = lists;
        const previousTasks = tasks;
        setListsAndRef((current) => removeById(current, listId));
        setTasks((current) => current.filter((task) => task.list_id !== listId));
        if (selectedListId === listId) setSelectedListId("all");
        try {
            await destroyTaskList(listId);
        } catch (err) {
            setError(err.message || "Unable to delete list.");
            setListsAndRef(previousLists);
            setTasks(previousTasks);
        }
    }, [listById, lists, selectedListId, setListsAndRef, tasks]);

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
                    h("h1", { className: "task-title" }, "Tasks"),
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
