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

const SOUND_STORAGE_KEY = "apstudy-task-sound-enabled";

export function todayDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function isoToLocalInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

export function normalizeTask(task) {
    return {
        ...task,
        priority: task.priority || "none",
        completed_occurrences: Array.isArray(task.completed_occurrences) ? task.completed_occurrences : [],
    };
}

export async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
    }
    return payload;
}

export function clearCalendarCache() {
    try {
        localStorage.removeItem("calendarEventsCache");
    } catch (err) {
        console.warn("Failed to clear calendar cache after task change.", err);
    }
}

export function getSoundPreference() {
    try {
        return localStorage.getItem(SOUND_STORAGE_KEY) !== "false";
    } catch (err) {
        console.warn("Failed to read task sound preference; defaulting sound on.", err);
        return true;
    }
}

export function saveSoundPreference(enabled) {
    try {
        localStorage.setItem(SOUND_STORAGE_KEY, String(Boolean(enabled)));
    } catch (err) {
        console.warn("Failed to save task sound preference.", err);
    }
}

export function isRepeatingTaskCompleted(task) {
    if (!task?.recurrence) return Boolean(task?.completed);
    const key = task.next_occurrence_key;
    return Boolean(key && task.completed_occurrences?.some((item) => item.occurrence_key === key));
}

export function sortedLists(lists) {
    return [...lists].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.name || "").localeCompare(b.name || ""));
}

export function sortedTasks(tasks) {
    return [...tasks].sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || "").localeCompare(b.title || ""));
}
