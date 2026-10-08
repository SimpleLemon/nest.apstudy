/**
 * API records retain fields supplied by the server; normalization supplies only
 * the defaults documented by Task and TaskList, without validating the payload.
 * @typedef {import('../core/http-types.js').FetchJsonOptions} FetchJsonOptions
 * @typedef {object} TaskRecurrence
 * @property {number} every
 * @property {string} unit
 * @property {string} [startDate]
 * @property {string|null} [endDate]
 * @typedef {object} TaskOccurrence
 * @property {string} occurrence_key
 * @property {string} [id]
 * @property {string} [$id]
 * @property {string|null} [task_id]
 * @property {string|null} [completed_at]
 * @typedef {object} TaskInput
 * @property {string} id
 * @property {string} [$id]
 * @property {string|null} list_id
 * @property {string} title
 * @property {string} [priority]
 * @property {boolean} [starred]
 * @property {number} [order]
 * @property {string|null} [deadline_at]
 * @property {string|null} [deadline_time]
 * @property {number|string|null} [reminder_minutes]
 * @property {string} [timezone]
 * @property {TaskRecurrence|null} [recurrence]
 * @property {string|null} [next_occurrence_key]
 * @property {TaskOccurrence[]} [completed_occurrences]
 * @property {boolean} [completed]
 * @property {string|null} [completed_at]
 * @property {string|null} [created_at]
 * @property {string|null} [updated_at]
 * @typedef {TaskInput & {priority: string, starred: boolean, reminder_minutes: number, completed_occurrences: TaskOccurrence[]}} Task
 * @typedef {object} TaskListInput
 * @property {string} id
 * @property {string} [$id]
 * @property {string} name
 * @property {string} [description]
 * @property {boolean} [hidden]
 * @property {boolean} [collapsed]
 * @property {string} [sort_mode]
 * @property {number} [order]
 * @property {string} [source_key] Identifies a list managed by an integration.
 * @property {string|null} [created_at]
 * @property {string|null} [updated_at]
 * @typedef {TaskListInput & {description: string, hidden: boolean, sort_mode: string}} TaskList
 * @typedef {object} TaskDraft
 * @property {string} title
 * @property {string} [priority]
 * @property {string|null} [deadline_at]
 * @property {string|null} [deadline_time]
 * @property {number|string|null} [reminder_minutes]
 * @property {string} [timezone]
 * @property {TaskRecurrence|null} [recurrence]
 * @typedef {{task_sound_enabled: boolean}} TaskPreferences
 */

export { isoToLocalInput, localInputToIso } from "../core/date-time-module.js";

export const DEFAULT_LIST_NAMES = ["School", "Research", "Personal"];
export const PRIORITY_OPTIONS = [
    { value: "none", label: "None" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
];
export const REPEAT_UNITS = [
    { value: "day", label: "day(s)" },
    { value: "week", label: "week(s)" },
    { value: "month", label: "month(s)" },
    { value: "year", label: "year(s)" },
];
export const DEFAULT_RECURRENCE_UNIT = "week";
export const LIST_SORT_OPTIONS = [
    { value: "default", label: "Default", icon: "drag_indicator" },
    { value: "date", label: "Date", icon: "calendar_today" },
    { value: "deadline", label: "Deadline", icon: "event" },
    { value: "title", label: "Title", icon: "sort_by_alpha" },
];

export function todayDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function defaultRecurrenceEndDate(baseDate = new Date()) {
    const source = baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ? baseDate : new Date();
    const year = source.getFullYear();
    const targetMonth = source.getMonth() + 1;
    const lastDayOfTargetMonth = new Date(year, targetMonth + 1, 0).getDate();
    const clampedDay = Math.min(source.getDate(), lastDayOfTargetMonth);
    const endDate = new Date(year, targetMonth, clampedDay);
    endDate.setDate(endDate.getDate() - 1);
    return dateString(endDate);
}

/** @returns {TaskRecurrence} A fresh editable recurrence rule. */
export function createDefaultRecurrence() {
    return { every: 1, unit: DEFAULT_RECURRENCE_UNIT, startDate: todayDateString(), endDate: null };
}

export function formatDeadline(value) {
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

export function formatRepeat(recurrence) {
    if (!recurrence) return "";
    const every = Number(recurrence.every || 1);
    const unit = recurrence.unit || "day";
    return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
}

/**
 * @param {TaskInput} task
 * @returns {Task}
 */
export function normalizeTask(task) {
    return {
        ...task,
        priority: task.priority || "none",
        starred: Boolean(task.starred),
        reminder_minutes: Number(task.reminder_minutes ?? (task.deadline_time ? 10 : -1)),
        completed_occurrences: Array.isArray(task.completed_occurrences) ? task.completed_occurrences : [],
    };
}

/**
 * @param {TaskListInput} list
 * @returns {TaskList}
 */
export function normalizeList(list) {
    return {
        ...list,
        description: list.description || "",
        hidden: Boolean(list.hidden),
        sort_mode: list.sort_mode || "default",
    };
}

/**
 * @param {string|URL|Request} url
 * @param {FetchJsonOptions} [options]
 * @returns {Promise<unknown>} Unvalidated server payload.
 */
export async function fetchJson(url, options = {}) {
    return window.APStudyHttp.fetchJson(url, {
        ...options,
        jsonMode: "required",
        pendingLabel: options.pendingLabel || "task-save",
    });
}

export function clearCalendarCache() {
    try {
        localStorage.removeItem("calendarEventsCache");
    } catch (err) {
        console.warn("Failed to clear calendar cache after task change.", err);
    }
}

/**
 * Recurring tasks are complete only for their current occurrence key.
 * @param {TaskInput|null|undefined} task
 * @returns {boolean}
 */
export function isTaskCurrentlyCompleted(task) {
    if (!task?.recurrence) return Boolean(task?.completed);
    const key = task.next_occurrence_key;
    return Boolean(key && task.completed_occurrences?.some((item) => item.occurrence_key === key));
}

/**
 * @template {TaskInput} T
 * @param {T[]|null} [tasks]
 * @returns {{active: T[], completed: T[]}}
 */
export function splitTasksByCompletion(tasks) {
    return (tasks || []).reduce((groups, task) => {
        groups[isTaskCurrentlyCompleted(task) ? "completed" : "active"].push(task);
        return groups;
    }, { active: [], completed: [] });
}

/**
 * @param {Partial<TaskPreferences>|null} [preferences]
 * @returns {TaskPreferences}
 */
export function normalizeTaskPreferences(preferences) {
    return {
        task_sound_enabled: preferences?.task_sound_enabled !== false,
    };
}

/** @param {TaskListInput[]} lists @returns {TaskList[]} */
export function sortedLists(lists) {
    return [...lists].map(normalizeList).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.name || "").localeCompare(b.name || ""));
}

/**
 * @template {TaskInput} T
 * @param {T[]} tasks
 * @returns {T[]} A sorted copy retaining the original task objects.
 */
export function sortedTasks(tasks) {
    return [...tasks].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || "").localeCompare(b.title || ""));
}

function timestamp(value, fallback = 0) {
    if (!value) return fallback;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? fallback : time;
}

function priorityRank(value) {
    return { high: 3, medium: 2, low: 1, none: 0 }[String(value || "none").toLowerCase()] || 0;
}

/**
 * @template {TaskInput} T
 * @param {T[]} tasks
 * @param {string} [sortMode]
 * @returns {T[]}
 */
export function sortTasksForList(tasks, sortMode = "default") {
    if (sortMode === "date") {
        return [...tasks].sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || (a.order || 0) - (b.order || 0));
    }
    if (sortMode === "deadline") {
        const noDeadline = Number.MAX_SAFE_INTEGER;
        return [...tasks].sort((a, b) => (
            timestamp(a.deadline_at, noDeadline) - timestamp(b.deadline_at, noDeadline)
            || priorityRank(b.priority) - priorityRank(a.priority)
            || (a.order || 0) - (b.order || 0)
            || (a.title || "").localeCompare(b.title || "")
        ));
    }
    if (sortMode === "title") {
        return [...tasks].sort((a, b) => (a.title || "").localeCompare(b.title || "") || (a.order || 0) - (b.order || 0));
    }
    return sortedTasks(tasks);
}
