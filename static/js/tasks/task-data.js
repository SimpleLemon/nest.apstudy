import {
    clearCalendarCache,
    fetchJson,
    localInputToIso,
    normalizeList,
    normalizeTaskPreferences,
    normalizeTask,
    sortedLists,
    sortedTasks,
} from "./task-utils.js";

/**
 * @typedef {import('./task-utils.js').Task} Task
 * @typedef {import('./task-utils.js').TaskInput} TaskInput
 * @typedef {import('./task-utils.js').TaskList} TaskList
 * @typedef {import('./task-utils.js').TaskListInput} TaskListInput
 * @typedef {import('./task-utils.js').TaskDraft} TaskDraft
 * @typedef {import('./task-utils.js').TaskPreferences} TaskPreferences
 * @typedef {{lists?: TaskListInput[], tasks?: TaskInput[], preferences?: Partial<TaskPreferences>}} TaskBoardPayload
 * @typedef {{lists: TaskList[], tasks: Task[], preferences: TaskPreferences}} TaskBoard
 * @typedef {{name?: string, description?: string}} TaskListDraft
 * @typedef {TaskDraft & {list_id: string, priority: string, deadline_at: string|null, deadline_time: string|null, reminder_minutes: number, timezone: string, recurrence: import('./task-utils.js').TaskRecurrence|null}} TaskDraftPayload
 * @typedef {{keepalive?: boolean}} DeleteOptions
 * @typedef {{id: string|null, occurrence_key: string, completed_at: string|null}} CapturedCompletion
 * @typedef {{task_id: string, completed_at: string|null, occurrences?: never}|{task_id: string, occurrences: CapturedCompletion[], completed_at?: never}} CompletedTaskSelection
 * @typedef {DeleteOptions & {selection?: CompletedTaskSelection[]}} CompletedDeleteOptions
 * @typedef {{id: string, order: number}} ListOrderUpdate
 * @typedef {{id: string|null, list_id: string|null, order: number}} TaskOrderUpdate
 */

/** @param {TaskInput} task @returns {boolean} */
export function completedForDeleteSweep(task) {
    if (task.recurrence) return task.completed_occurrences?.length > 0;
    return Boolean(task.completed);
}

/**
 * @param {TaskBoardPayload} payload
 * @returns {TaskBoard}
 */
export function normalizeTaskBoard(payload) {
    return {
        lists: sortedLists((payload.lists || []).map(normalizeList)),
        tasks: (payload.tasks || []).map(normalizeTask),
        preferences: normalizeTaskPreferences(payload.preferences),
    };
}

/** @returns {Promise<TaskBoard>} */
export async function fetchTaskBoard() {
    return normalizeTaskBoard(/** @type {TaskBoardPayload} */ (await fetchJson("/api/tasks")));
}

/**
 * @param {TaskListDraft} draft
 * @returns {Promise<TaskList|null>}
 */
export async function createTaskList({ name, description = "" }) {
    const listName = (name || "New List").trim();
    if (!listName) return null;
    const payload = /** @type {{list: TaskListInput}} */ (await fetchJson("/api/task-lists", {
        method: "POST",
        body: JSON.stringify({ name: listName, description }),
    }));
    return normalizeList(payload.list);
}

/**
 * @param {string} listId
 * @param {Partial<TaskListInput>} updates
 * @returns {Promise<TaskList>}
 */
export async function updateTaskList(listId, updates) {
    const payload = /** @type {{list: TaskListInput}} */ (await fetchJson(`/api/task-lists/${encodeURIComponent(listId)}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
    }));
    return normalizeList(payload.list);
}

/** @param {string} listId @param {DeleteOptions} [options] @returns {Promise<void>} */
export async function destroyTaskList(listId, options = {}) {
    await fetchJson(`/api/task-lists/${encodeURIComponent(listId)}`, {
        method: "DELETE",
        keepalive: options.keepalive === true,
    });
    clearCalendarCache();
}

/**
 * Preserve recurring definitions while clearing their completion history.
 * @param {Task[]} tasks
 * @param {string} listId
 * @returns {Task[]}
 */
export function removeCompletedTasksFromList(tasks, listId) {
    return tasks.flatMap((task) => {
        if (task.list_id !== listId) return [task];
        if (task.recurrence) return [{ ...task, completed_occurrences: [] }];
        return task.completed ? [] : [task];
    });
}

/**
 * An omitted selection sweeps current completions. An explicit selection,
 * including [], limits deletion to the captured identity and timestamp boundaries.
 * @param {string} listId
 * @param {CompletedDeleteOptions} [options]
 * @returns {Promise<void>}
 */
export async function destroyCompletedTasks(listId, options = {}) {
    await fetchJson(`/api/task-lists/${encodeURIComponent(listId)}/completed-tasks`, {
        method: "DELETE",
        keepalive: options.keepalive === true,
        ...(options.selection ? { body: JSON.stringify({ selection: options.selection }) } : {}),
    });
    clearCalendarCache();
}

/**
 * @param {string} listId
 * @param {TaskDraft} draft
 * @param {string} [timezone]
 * @returns {TaskDraftPayload}
 */
export function buildTaskDraftPayload(listId, draft, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") {
    const rawDeadline = draft.deadline_at || null;
    const deadlineAt = rawDeadline && /(?:Z|[+-]\d{2}:\d{2})$/.test(rawDeadline)
        ? rawDeadline
        : localInputToIso(rawDeadline);
    const deadlineTime = Object.prototype.hasOwnProperty.call(draft, "deadline_time")
        ? draft.deadline_time ?? null
        : rawDeadline ? rawDeadline.slice(11, 16) : null;
    return {
        list_id: listId,
        title: draft.title,
        priority: draft.priority || "none",
        deadline_at: deadlineAt,
        deadline_time: deadlineTime,
        reminder_minutes: deadlineAt ? Number(draft.reminder_minutes ?? (deadlineTime ? 10 : -1)) : -1,
        timezone: draft.timezone || timezone,
        recurrence: draft.recurrence || null,
    };
}

/**
 * @param {string} listId
 * @param {TaskDraft} draft
 * @returns {Promise<Task>}
 */
export async function createTaskRecord(listId, draft) {
    const response = /** @type {{task: TaskInput}} */ (await fetchJson("/api/tasks", {
        method: "POST",
        body: JSON.stringify(buildTaskDraftPayload(listId, draft)),
    }));
    clearCalendarCache();
    return normalizeTask(response.task);
}

/**
 * @param {string} taskId
 * @param {Partial<TaskInput>} updates
 * @returns {Promise<Task>}
 */
export async function updateTaskRecord(taskId, updates) {
    const response = /** @type {{task: TaskInput}} */ (await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
    }));
    clearCalendarCache();
    return normalizeTask(response.task);
}

/** @param {string} taskId @param {DeleteOptions} [options] @returns {Promise<void>} */
export async function destroyTaskRecord(taskId, options = {}) {
    await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        keepalive: options.keepalive === true,
    });
    clearCalendarCache();
}

/**
 * @param {Task} task
 * @param {boolean} completed
 * @param {Date} [now]
 * @returns {{occurrenceKey: string|null|undefined, task: Task}}
 */
export function buildCompletedTaskOptimistic(task, completed, now = new Date()) {
    const occurrenceKey = task.recurrence ? task.next_occurrence_key : "single";
    const normalizedOccurrenceKey = occurrenceKey || "single";
    const nextTask = task.recurrence
        ? {
            ...task,
            completed_occurrences: completed
                ? [...task.completed_occurrences, { occurrence_key: normalizedOccurrenceKey, completed_at: now.toISOString() }]
                : task.completed_occurrences.filter((item) => item.occurrence_key !== normalizedOccurrenceKey),
        }
        : { ...task, completed, completed_at: completed ? now.toISOString() : null };

    return { occurrenceKey, task: normalizeTask(nextTask) };
}

/**
 * @param {string} taskId
 * @param {boolean} completed
 * @param {string|null|undefined} occurrenceKey
 * @returns {Promise<Task>}
 */
export async function completeTaskRecord(taskId, completed, occurrenceKey) {
    const response = /** @type {{task: TaskInput}} */ (await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ completed, occurrence_key: occurrenceKey }),
    }));
    clearCalendarCache();
    return normalizeTask(response.task);
}

/** @param {string[]} orderedIds @returns {ListOrderUpdate[]} */
export function buildListOrderUpdates(orderedIds) {
    return orderedIds.map((id, index) => ({ id, order: (index + 1) * 1000 }));
}

/** @param {TaskListInput[]} lists @param {ListOrderUpdate[]} updates @returns {TaskList[]} */
export function applyListOrderUpdates(lists, updates) {
    const orderById = new Map(updates.map((item) => [item.id, item.order]));
    return sortedLists(lists.map((list) => {
        const order = orderById.get(list.id);
        return order == null ? list : normalizeList({ ...list, order });
    }));
}

/**
 * DOM attributes are copied as-is; missing identifiers remain null for the
 * caller/API to validate. Ordering restarts within each list container.
 * @param {Document|Element|DocumentFragment} [root]
 * @returns {TaskOrderUpdate[]}
 */
export function taskOrderUpdatesFromDocument(root = document) {
    const containers = Array.from(root.querySelectorAll("[data-task-list-body]"));
    return containers.flatMap((container) => {
        const listId = container.getAttribute("data-list-id");
        return Array.from(container.querySelectorAll("[data-task-id]")).map((row, index) => ({
            id: row.getAttribute("data-task-id"),
            list_id: listId,
            order: (index + 1) * 1000,
        }));
    });
}

/** @param {Task[]} tasks @param {TaskOrderUpdate[]} updates @returns {Task[]} */
export function applyTaskOrderUpdates(tasks, updates) {
    const updateById = new Map(updates.map((item) => [item.id, item]));
    return tasks.map((task) => {
        const match = updateById.get(task.id);
        return match ? normalizeTask({ ...task, list_id: match.list_id, order: match.order }) : task;
    });
}

/** @param {ListOrderUpdate[]} updates @returns {Promise<void>} */
export async function persistListOrder(updates) {
    await fetchJson("/api/tasks/reorder", {
        method: "PATCH",
        body: JSON.stringify({ lists: updates }),
    });
}

/** @param {TaskOrderUpdate[]} updates @returns {Promise<void>} */
export async function persistTaskOrder(updates) {
    await fetchJson("/api/tasks/reorder", {
        method: "PATCH",
        body: JSON.stringify({ tasks: updates }),
    });
    clearCalendarCache();
}

/** @param {Task[]} tasks @param {TaskInput} task @returns {Task[]} */
export function appendTask(tasks, task) {
    return sortedTasks([...tasks, normalizeTask(task)]);
}

/**
 * @template {{id: string}} T
 * @typedef {object} MutationOptions
 * @property {string[]} [fields]
 * @property {(value: T) => T} [optimistic]
 * @property {((value: T, response: T) => T)|null} [accepted]
 */
/**
 * @template {{id: string}} T
 * @typedef {object} MutationEntry
 * @property {'pending'|'accepted'|'failed'} status
 * @property {(value: T) => T} optimistic
 * @property {(value: T, response: T) => T} accepted
 * @property {T|null} [response]
 */
/**
 * @template {{id: string}} T
 * @typedef {{baseline: T, fields: Set<string>, entries: MutationEntry<T>[], completion: Promise<void>, finish: () => void}} MutationRecord
 */
/**
 * @template {{id: string}} T
 * @typedef {{id: string, record: MutationRecord<T>, entry: MutationEntry<T>, changes: Partial<T>}} MutationTicket
 */
/**
 * @template {{id: string}} T
 * @typedef {{stale: true}|{stale: false, changes: Partial<T>, latest: boolean}} MutationSettlement
 */
/**
 * @template {{id: string}} T
 * @typedef {object} EntityMutationJournal
 * @property {(entity: T, changes: Partial<T>, options?: MutationOptions<T>) => MutationTicket<T>} begin Projects the new intention over all earlier pending/accepted entries.
 * @property {(ticket: MutationTicket<T>, response?: T|null) => MutationSettlement<T>} settle Missing/null response rolls back that entry; invalidated tickets are stale.
 * @property {(id: string, update: (value: T) => T) => Partial<T>|null} rebase Updates the baseline while retaining pending intentions; null means no active record.
 * @property {(ids: string[]) => Promise<(void|undefined)[]>} waitFor Waits for all current writes, or invalidation; absent IDs resolve immediately.
 * @property {(id: string) => void} invalidate Discards projection and releases waiters for the ID.
 * @property {() => void} reset Invalidates every active record and releases its waiters.
 */
/**
 * Keep accepted fields and pending intentions separate until every write settles.
 * @template {{id: string}} T
 * @returns {EntityMutationJournal<T>}
 */
export function createEntityMutationJournal() {
    const records = new Map();
    const project = (record) => {
        let value = { ...record.baseline };
        for (const entry of record.entries) {
            if (entry.status === 'pending') value = entry.optimistic(value);
            else if (entry.status === 'accepted') value = entry.accepted(value, entry.response);
        }
        return Object.fromEntries([...record.fields].map(field => [field, value[field]]));
    };
    return {
        begin(entity, changes, { fields = Object.keys(changes), optimistic = value => ({ ...value, ...changes }), accepted = null } = {}) {
            let record = records.get(entity.id);
            if (!record) {
                let finish;
                const completion = new Promise(resolve => { finish = resolve; });
                record = { baseline: entity, fields: new Set(), entries: [], completion, finish };
                records.set(entity.id, record);
            }
            fields.forEach(field => record.fields.add(field));
            const entry = { status: 'pending', optimistic, accepted: accepted || ((value, response) => ({
                ...value, ...Object.fromEntries(fields.filter(field => Object.hasOwn(response, field)).map(field => [field, response[field]])),
            })) };
            record.entries.push(entry);
            return { id: entity.id, record, entry, changes: project(record) };
        },
        settle(ticket, response = null) {
            const { id, record, entry } = ticket;
            if (records.get(id) !== record) return { stale: true };
            entry.status = response ? 'accepted' : 'failed';
            entry.response = response;
            const changes = project(record);
            const latest = record.entries.at(-1) === entry;
            if (!record.entries.some(item => item.status === 'pending')) { records.delete(id); record.finish(); }
            return { changes, latest, stale: false };
        },
        rebase(id, update) {
            const record = records.get(id);
            if (!record) return null;
            record.baseline = update(record.baseline);
            return project(record);
        },
        waitFor(ids) { return Promise.all(ids.map(id => records.get(id)?.completion)); },
        invalidate(id) { records.get(id)?.finish(); records.delete(id); },
        reset() { records.forEach(record => record.finish()); records.clear(); },
    };
}


/**
 * Capture acknowledged completion identities for a deferred deletion. Returned
 * occurrence records are new objects and include nullable timestamp boundaries.
 * @param {Task[]} tasks
 * @returns {CompletedTaskSelection[]}
 */
export function completedTaskSelection(tasks) {
    return tasks.filter(completedForDeleteSweep).map(task => task.recurrence ? {
        task_id: task.id,
        occurrences: task.completed_occurrences.map(item => ({
            id: item.id || item.$id || null,
            occurrence_key: item.occurrence_key,
            completed_at: item.completed_at ?? null,
        })),
    } : { task_id: task.id, completed_at: task.completed_at ?? null });
}

/**
 * Merge captured history without replacing any newer completion for the same key.
 * @template {TaskInput} T
 * @param {T} current
 * @param {TaskInput} captured
 * @returns {T & {completed_occurrences: import('./task-utils.js').TaskOccurrence[]}}
 */
export function restoreCapturedCompletions(current, captured) {
    const occurrences = [...(current.completed_occurrences || [])];
    for (const item of captured.completed_occurrences || []) {
        if (!occurrences.some(existing => existing.occurrence_key === item.occurrence_key)) occurrences.push(item);
    }
    return { ...current, completed_occurrences: occurrences };
}
