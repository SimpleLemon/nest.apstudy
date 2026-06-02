/* ──────────────────────────────────────────────────────────────────────────────
   Dashboard Calendar & Assignments
   ──────────────────────────────────────────────────────────────────────────── */
/* ── Constants ─────────────────────────────────────────────────────────────── */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MINUTES_PER_DAY = 1440;
const HOUR_HEIGHT_PX = 60;
const WEEK_MINIMUM_DAY_WIDTH_PX = 100;
const ALL_DAY_MIN_HEIGHT_PX = 44;
const SIMULATED_CALENDAR_NAME = "Simulated Courses";
const CANVAS_CALENDAR_NAME = "Canvas";
const CANVAS_SOURCE_ID = "canvas";
const LOCAL_SOURCE_PREFIX = "local:";
const DEFAULT_LOCAL_CALENDAR_ID = "local:default";
const DEFAULT_LOCAL_CALENDAR_NAME = "Personal";
const TASK_CALENDAR_ID = "local:tasks";
const TASK_CALENDAR_NAME = "Tasks";
const COURSES_SELECTION_STORAGE_KEY = "coursesSelectedSectionIds";
const COURSES_MODAL_ANIMATION_MS = 180;
const DEFAULT_DASHBOARD_VIEW = document.body?.dataset.defaultDashboardView === "month" ? "month" : "week";
const EVENTS_CACHE_KEY = "calendarEventsCache";
const DEFAULT_CALENDAR_BUFFER_DAYS = 7;
const CALENDAR_BUFFER_DAYS = Number.isFinite(
    Number.parseInt(document.body?.dataset.calendarBufferDays, 10)
)
    ? Number.parseInt(document.body?.dataset.calendarBufferDays, 10)
    : DEFAULT_CALENDAR_BUFFER_DAYS;
const CALENDAR_READ_ONLY = document.body?.dataset.calendarReadonly === "true";
const PUBLIC_SHARE_CODE = document.body?.dataset.publicShareCode || "";
const PUBLIC_CALENDAR_TITLE = document.body?.dataset.publicCalendarTitle || "Shared Calendar";
const PUBLIC_CALENDAR_RANGE_LABEL = document.body?.dataset.publicCalendarRangeLabel || "Shared dates";
const CALENDAR_SHARE_CLOSE_MS = 140;
const PREFERENCE_SAVE_DELAY_MS = 1000;
const PREFERENCE_SAVE_TIMEOUT_MS = 5000;
const PREFERENCE_SAVE_RETRY_DELAYS_MS = [1000, 3000];
const PREFERENCE_SAVE_WARNING_COOLDOWN_MS = 60000;
const PREFERENCE_BATCH_LIMIT = 50;
const PREFERENCE_BATCH_ENDPOINT = "/api/calendar/preferences/batch";
const PREFERENCE_LOAD_RETRY_COOLDOWN_MS = 15000;
const TOGGLE_REFRESH_DELAY_MS = 1000;
const COMPACT_CALENDAR_QUERY = window.matchMedia("(max-width: 640px)");
const {
    formatDateKey,
    formatMonthGridDayLabel,
    dateToDayIndex,
    layoutTimedEvents,
    formatHourLabel,
    formatTimeOnly,
    formatTimedEventRange,
    formatAllDayRange,
    getStartOfWeek,
    isToday,
    getUrgencyLabel,
    getUrgencyLabelAllDay,
    getAccent,
    isTaskEvent,
    getTaskPriorityColor,
    adjustHexLuminance,
    hexToRgba,
    escapeHtml,
    formatMultilineText,
} = window.APStudyCalendarUtils;
/* ── Application State ─────────────────────────────────────────────────────── */
const state = {
    events: [],
    eventsMeta: { lastFetched: null, refreshIntervalMinutes: null },
    feedConfigured: false,
    loadingDashboard: false,
    refreshInFlight: false,
    view: DEFAULT_DASHBOARD_VIEW,
    anchorDate: new Date(),
    calendars: {},
    calendarSources: [],
    loadedRange: null,
    pendingRanges: new Set(),
    calendarColors: ["#ef4444", "#f97316", "#eab308", "#84cc16", "#0ea5e9", "#d946ef", "#b08968"],
    public: {
        readOnly: CALENDAR_READ_ONLY,
        shareCode: PUBLIC_SHARE_CODE,
        title: PUBLIC_CALENDAR_TITLE,
        rangeLabel: PUBLIC_CALENDAR_RANGE_LABEL,
    },
    shares: {
        items: [],
        loading: false,
        saving: false,
        loaded: false,
        editingId: null,
        error: "",
        notice: "",
    },
    courses: {
        terms: [],
        sections: [],
        sectionsById: {},
        indexLoaded: false,
        selectedSectionIds: new Set(),
        pinnedSectionIds: new Set(),
        modalOpen: false,
        isClosing: false,
        animateOnOpen: false,
        showSelectedOnly: false,
        loading: false,
        error: "",
        searchQuery: "",
        searchInput: "",
        termFilter: "",
        filteredSectionIds: [],
        expandedDetails: new Set(),
    },
    ui: {
        calendarMenuOpen: false,
        contextMenuEl: null,
        rgbModalEl: null,
        sourceInfoModalEl: null,
        sourceCreateModalEl: null,
        contextAnchorEl: null,
        contextCalendarName: null,
        weeklyAutoScrollKey: null,
        hoverCardEl: null,
        hoverCardAnchorEl: null,
        hoverCardHideTimer: null,
        expandedUpcomingRefs: new Set(),
        shareModalEl: null,
        preferenceDirty: new Set(),
        preferenceFlushTimer: null,
        preferenceInFlight: false,
        preferenceRetryCount: 0,
        preferenceRetryTimer: null,
        preferenceNotice: "",
        preferenceNoticeAt: 0,
        toggleRefreshTimer: null,
        toggleRefreshNeedsFeed: false,
        toggleRefreshNeedsEvents: false,
    },
    preferences: {
        loaded: false,
        loading: null,
        cache: {},
        lastLoadedAt: null,
        lastAttemptAt: null,
    },
};
function initCalendarState() {
    const calendars = {};
    const addCalendar = (key, options = {}) => {
        if (!key || calendars[key]) return;
        const colorIndex = Object.keys(calendars).length % state.calendarColors.length;
        calendars[key] = {
            visible: true,
            color: options.color || options.color_hex || state.calendarColors[colorIndex],
            colorIndex,
            label: options.label || key,
            defaultName: options.defaultName || options.label || key,
            url: options.url || "",
            kind: options.kind || "local",
            editable: Boolean(options.editable),
            sourceId: options.sourceId || null,
            legacyNames: Array.isArray(options.legacyNames) ? options.legacyNames.filter(Boolean) : [],
        };
    };
    for (const source of state.calendarSources) {
        const sourceId = source.id || "";
        addCalendar(sourceId, {
            label: source.display_name || source.default_name || sourceId,
            defaultName: source.default_name || source.display_name || sourceId,
            url: source.url || "",
            color: source.color_hex || source.color || "",
            kind: source.kind || "external",
            editable: source.editable !== false,
            sourceId,
            legacyNames: [source.default_name, ...(Array.isArray(source.legacy_names) ? source.legacy_names : [])],
        });
    }
    for (const event of state.events) {
        const cal = getEventCalendarKey(event);
        const fallbackLabel = cal === DEFAULT_LOCAL_CALENDAR_ID ? DEFAULT_LOCAL_CALENDAR_NAME : (event.course || "Other");
        addCalendar(cal, {
            label: fallbackLabel,
            defaultName: fallbackLabel,
            legacyNames: [fallbackLabel],
        });
    }
    if (!state.public.readOnly && state.courses.selectedSectionIds.size > 0 && !calendars[SIMULATED_CALENDAR_NAME]) {
        addCalendar(SIMULATED_CALENDAR_NAME, {
            label: SIMULATED_CALENDAR_NAME,
            defaultName: SIMULATED_CALENDAR_NAME,
            legacyNames: [SIMULATED_CALENDAR_NAME],
        });
    }
    state.calendars = calendars;
}
function getCalendarLabel(calendarName) {
    return state.calendars[calendarName]?.label || calendarName || "Other";
}
function isLocalCalendar(calendarName) {
    return String(calendarName || "").startsWith(LOCAL_SOURCE_PREFIX);
}
function getCalendarOptionsForEventForm() {
    const entries = Object.entries(state.calendars)
        .filter(([name]) => name !== SIMULATED_CALENDAR_NAME)
        .sort(([, a], [, b]) => getCalendarLabelFromData(a).localeCompare(getCalendarLabelFromData(b)));
    if (!entries.some(([name]) => name === DEFAULT_LOCAL_CALENDAR_ID)) {
        entries.unshift([
            DEFAULT_LOCAL_CALENDAR_ID,
            {
                label: DEFAULT_LOCAL_CALENDAR_NAME,
                defaultName: DEFAULT_LOCAL_CALENDAR_NAME,
                color: state.calendarColors[4] || "#0ea5e9",
                kind: "local",
                editable: true,
                sourceId: DEFAULT_LOCAL_CALENDAR_ID,
            },
        ]);
    }
    return entries.map(([id, data]) => ({
        id,
        label: getCalendarLabelFromData(data) || id,
        color: data.color || state.calendarColors[4] || "#0ea5e9",
        kind: data.kind || (isLocalCalendar(id) ? "local" : "external"),
    }));
}
function getDefaultCalendarIdForEventForm() {
    const localVisible = Object.entries(state.calendars).find(([name, data]) => isLocalCalendar(name) && data.visible !== false);
    if (localVisible) return localVisible[0];
    const localAny = Object.keys(state.calendars).find((name) => isLocalCalendar(name));
    return localAny || DEFAULT_LOCAL_CALENDAR_ID;
}
function getCalendarEventRef(event) {
    if (!event) return "";
    return event.event_ref || (event.id ? `user:${event.id}` : "") || (event.uid ? `legacy:${event.uid}` : "");
}
function getEventsForCurrentContextLookup() {
    const range = getCurrentViewCountRange();
    const events = [...state.events];
    if (!state.public.readOnly && state.courses.selectedSectionIds.size > 0) {
        events.push(...buildSimulatedMeetingEvents(range.start, range.end));
    }
    return events;
}
function getCalendarEventByRef(eventRef) {
    if (!eventRef) return null;
    return getEventsForCurrentContextLookup().find((event) => getCalendarEventRef(event) === eventRef) || null;
}
function getEventCalendarKey(event) {
    if (event?.source_type === "user" || (event?.id && !event?.uid)) {
        return event.calendar_id || DEFAULT_LOCAL_CALENDAR_ID;
    }
    return event.calendar_id || event.course || "Other";
}
function getEventCalendarLabel(event) {
    return getCalendarLabel(getEventCalendarKey(event));
}
function getSavedCalendarInfo(saved, key) {
    if (!saved || !key) return null;
    if (saved[key]) return saved[key];
    const legacyNames = state.calendars[key]?.legacyNames || [];
    for (const legacyName of legacyNames) {
        if (saved[legacyName]) return saved[legacyName];
    }
    return null;
}
function writeCalendarStateToStorage() {
    if (state.public.readOnly) return;
    localStorage.setItem("calendarState", JSON.stringify(Object.fromEntries(
        Object.entries(state.calendars).map(([cal, data]) => [cal, { visible: data.visible, color: data.color }])
    )));
}
function trackCalendarMutation(request, label = "calendar-save") {
    return window.APStudyPendingMutations?.track(request, label) || request;
}
function fetchWithTimeout(url, options = {}, timeoutMs = PREFERENCE_SAVE_TIMEOUT_MS) {
    const controller = new AbortController();
    const { signal, ...rest } = options || {};
    if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...rest, signal: controller.signal }).finally(() => {
        window.clearTimeout(timeoutId);
    });
}
function buildCalendarPreferencePayload(calendarName) {
    const pref = state.calendars[calendarName];
    if (!pref) return null;
    return {
        calendar_name: calendarName,
        color_hex: pref.color,
        visible: pref.visible,
    };
}
function markCalendarPreferenceDirty(calendarName) {
    if (state.public.readOnly) return;
    if (!state.calendars[calendarName]) return;
    state.ui.preferenceDirty.add(calendarName);
}
function clearPreferenceNotice() {
    if (!state.ui.preferenceNotice) return;
    state.ui.preferenceNotice = "";
    state.ui.preferenceNoticeAt = 0;
    renderCalendarMenu();
}
function showPreferenceNotice() {
    const now = Date.now();
    if (state.ui.preferenceNotice && now - state.ui.preferenceNoticeAt < PREFERENCE_SAVE_WARNING_COOLDOWN_MS) {
        return;
    }
    state.ui.preferenceNotice = "Calendar changes are taking longer to save. We will keep trying in the background.";
    state.ui.preferenceNoticeAt = now;
    renderCalendarMenu();
}
function scheduleCalendarPreferenceFlush(delayMs = PREFERENCE_SAVE_DELAY_MS) {
    if (state.public.readOnly) return;
    if (state.ui.preferenceFlushTimer) {
        clearTimeout(state.ui.preferenceFlushTimer);
    }
    if (state.ui.preferenceRetryTimer) {
        clearTimeout(state.ui.preferenceRetryTimer);
        state.ui.preferenceRetryTimer = null;
    }
    state.ui.preferenceFlushTimer = setTimeout(() => {
        state.ui.preferenceFlushTimer = null;
        void flushCalendarPreferenceQueue();
    }, delayMs);
}
function scheduleCalendarPreferenceRetry() {
    const attempt = state.ui.preferenceRetryCount || 0;
    if (attempt < PREFERENCE_SAVE_RETRY_DELAYS_MS.length) {
        const delay = PREFERENCE_SAVE_RETRY_DELAYS_MS[attempt];
        state.ui.preferenceRetryCount = attempt + 1;
        if (state.ui.preferenceRetryTimer) {
            clearTimeout(state.ui.preferenceRetryTimer);
        }
        state.ui.preferenceRetryTimer = setTimeout(() => {
            state.ui.preferenceRetryTimer = null;
            void flushCalendarPreferenceQueue();
        }, delay);
        return;
    }
    state.ui.preferenceRetryCount = attempt + 1;
    showPreferenceNotice();
}
async function flushCalendarPreferenceQueue() {
    if (state.public.readOnly) return;
    if (state.ui.preferenceInFlight) return;
    if (!state.ui.preferenceDirty.size) return;

    const pending = Array.from(state.ui.preferenceDirty).slice(0, PREFERENCE_BATCH_LIMIT);
    pending.forEach((calendarName) => state.ui.preferenceDirty.delete(calendarName));
    const preferences = pending.map(buildCalendarPreferencePayload).filter(Boolean);
    if (!preferences.length) return;

    state.ui.preferenceInFlight = true;
    const request = trackCalendarMutation(fetchWithTimeout(PREFERENCE_BATCH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences }),
    }), "calendar-save");

    try {
        const res = await request;
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(payload.error || "Unable to save calendar preferences.");
        }

        state.ui.preferenceRetryCount = 0;
        clearPreferenceNotice();

        if (state.preferences.cache && typeof state.preferences.cache === "object") {
            for (const pref of preferences) {
                if (!pref?.calendar_name) continue;
                state.preferences.cache[pref.calendar_name] = {
                    ...state.preferences.cache[pref.calendar_name],
                    calendar_name: pref.calendar_name,
                    color_hex: pref.color_hex,
                    visible: pref.visible,
                };
            }
        }

        const errors = Array.isArray(payload.errors) ? payload.errors : [];
        if (errors.length) {
            for (const err of errors) {
                if (err?.calendar_name) {
                    state.ui.preferenceDirty.add(err.calendar_name);
                }
            }
            scheduleCalendarPreferenceFlush();
        }
    } catch (err) {
        console.warn("Failed to save calendar preferences:", err);
        pending.forEach((calendarName) => state.ui.preferenceDirty.add(calendarName));
        scheduleCalendarPreferenceRetry();
    } finally {
        state.ui.preferenceInFlight = false;
        if (state.ui.preferenceDirty.size && !state.ui.preferenceFlushTimer && !state.ui.preferenceRetryTimer) {
            scheduleCalendarPreferenceFlush();
        }
    }
}
function queueCalendarPreferenceSave(calendarName, delayMs = PREFERENCE_SAVE_DELAY_MS) {
    markCalendarPreferenceDirty(calendarName);
    scheduleCalendarPreferenceFlush(delayMs);
}
function saveCalendarState() {
    if (state.public.readOnly) return;
    const toSave = {};
    for (const [cal, data] of Object.entries(state.calendars)) {
        toSave[cal] = { visible: data.visible, color: data.color };
        markCalendarPreferenceDirty(cal);
    }
    localStorage.setItem("calendarState", JSON.stringify(toSave));
    scheduleCalendarPreferenceFlush(0);
}
function applyStoredCalendarState(saved) {
    if (!saved) return;
    try {
        const data = JSON.parse(saved);
        for (const cal of Object.keys(state.calendars)) {
            const info = getSavedCalendarInfo(data, cal);
            if (!info) continue;
            if (typeof info.visible === "boolean") state.calendars[cal].visible = info.visible;
            if (typeof info.color === "string") state.calendars[cal].color = info.color;
        }
    } catch (err) {
        console.warn("Ignoring invalid saved calendar state:", err);
        localStorage.removeItem("calendarState");
    }
}
function applyCachedCalendarPreferences(prefsByName) {
    if (!prefsByName) return;
    for (const cal of Object.keys(state.calendars)) {
        if (state.ui.preferenceDirty.has(cal)) continue;
        const pref = getSavedCalendarInfo(prefsByName, cal);
        if (!pref) continue;
        if (typeof pref.visible === "boolean") state.calendars[cal].visible = pref.visible;
        if (typeof pref.color_hex === "string" && /^#[0-9a-fA-F]{6}$/.test(pref.color_hex)) {
            state.calendars[cal].color = pref.color_hex;
        }
        if (typeof pref.display_name === "string" && pref.display_name.trim() && state.calendars[cal].editable) {
            state.calendars[cal].label = pref.display_name.trim();
        }
    }
}
function invalidateCalendarPreferencesCache() {
    state.preferences.loaded = false;
    state.preferences.loading = null;
    state.preferences.cache = {};
    state.preferences.lastLoadedAt = null;
    state.preferences.lastAttemptAt = null;
}
async function ensureCalendarPreferencesLoaded(force = false) {
    if (state.public.readOnly) return;
    if (state.preferences.loading) return state.preferences.loading;
    if (state.preferences.loaded && !force) return;

    const now = Date.now();
    if (!force && state.preferences.lastAttemptAt && now - state.preferences.lastAttemptAt < PREFERENCE_LOAD_RETRY_COOLDOWN_MS) {
        return;
    }
    state.preferences.lastAttemptAt = now;

    state.preferences.loading = (async () => {
        try {
            const res = await fetch("/api/calendar/preferences");
            if (!res.ok) return;
            const payload = await res.json().catch(() => ({}));
            const prefs = Array.isArray(payload.preferences) ? payload.preferences : [];
            state.preferences.cache = Object.fromEntries(
                prefs.filter((pref) => pref.calendar_name).map((pref) => [pref.calendar_name, pref])
            );
            state.preferences.loaded = true;
            state.preferences.lastLoadedAt = Date.now();
        } catch (err) {
            console.warn("Failed to load calendar preferences:", err);
        } finally {
            state.preferences.loading = null;
        }
    })();

    return state.preferences.loading;
}
async function loadCalendarState(options = {}) {
    if (state.public.readOnly) return;
    const saved = localStorage.getItem("calendarState");
    if (saved) {
        applyStoredCalendarState(saved);
    }
    await ensureCalendarPreferencesLoaded(Boolean(options.force));
    applyCachedCalendarPreferences(state.preferences.cache);
}
const calendarCourses = window.APStudyCalendarCourses.createCalendarCourses({
    state,
    constants: {
        coursesSelectionStorageKey: COURSES_SELECTION_STORAGE_KEY,
        coursesModalAnimationMs: COURSES_MODAL_ANIMATION_MS,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
    },
    render,
    saveCalendarState,
    escapeHtml,
});
const {
    initializeCourseSelectionsFromStorage,
    hydrateSelectedSimulatedSections,
    applyCoursesFiltersFromUrl,
    writeCourseFiltersToUrl,
    openCoursesModal,
    closeCoursesModal,
    submitCoursesSearch,
    applyCourseFilters,
    toggleCourseSectionSelection,
    renderCoursesModal,
    ensureSimulatedCalendarPreference,
    buildSimulatedMeetingEvents,
} = calendarCourses;
const calendarData = window.APStudyCalendarData.createCalendarData({
    state,
    constants: {
        calendarBufferDays: CALENDAR_BUFFER_DAYS,
        eventsCacheKey: EVENTS_CACHE_KEY,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
        taskCalendarId: TASK_CALENDAR_ID,
        taskCalendarName: TASK_CALENDAR_NAME,
        toggleRefreshDelayMs: TOGGLE_REFRESH_DELAY_MS,
    },
    buildSimulatedMeetingEvents,
    ensureSimulatedCalendarPreference,
    getEventCalendarKey,
    getStartOfWeek,
    hydrateSelectedSimulatedSections,
    initCalendarState,
    loadCalendarState,
    queueCalendarPreferenceSave,
    render,
    writeCalendarStateToStorage,
});
const {
    getBufferedRange,
    getCurrentRenderRange,
    getEventCalendarColor,
    getVisibleEvents,
    loadCalendarData,
    refreshCalendarFeed,
    runManualRefresh,
    setCalendarColor,
    toggleCalendarVisibility,
    ensureEventsForRange,
} = calendarData;
/* ── Bootstrap ─────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
    if (!state.public.readOnly) {
        applyCoursesFiltersFromUrl();
        initializeCourseSelectionsFromStorage();
    }
    wireControls();
    loadCalendarData();
});
window.state = state;
window.render = render;
window.loadCalendarData = loadCalendarData;
window.refreshCalendarFeed = refreshCalendarFeed;
window.ensureEventsForRange = ensureEventsForRange;
window.runManualRefresh = runManualRefresh;
window.getBufferedRangeForView = () => getBufferedRange(getCurrentRenderRange());
window.getCalendarEventByRef = getCalendarEventByRef;
window.getCalendarOptionsForEventForm = getCalendarOptionsForEventForm;
window.getDefaultCalendarIdForEventForm = getDefaultCalendarIdForEventForm;
window.getCalendarColorForEventForm = (calendarName) => state.calendars[calendarName]?.color || state.calendarColors[4] || "#0ea5e9";
window.getStandardCalendarColors = () => [...state.calendarColors];
/* ── Controls ──────────────────────────────────────────────────────────────── */
function wireControls() {
    let lastCompactCalendar = isCompactCalendarViewport();
    window.addEventListener("resize", () => {
        const nextCompactCalendar = isCompactCalendarViewport();
        if (nextCompactCalendar === lastCompactCalendar) return;
        lastCompactCalendar = nextCompactCalendar;
        renderCalendarView();
    });
    // Check if courses panel should be opened on load (e.g., from redirect)
    if (!state.public.readOnly && sessionStorage.getItem("openCoursesPanelOnLoad") === "true") {
        sessionStorage.removeItem("openCoursesPanelOnLoad");
        // Open courses modal after a short delay to ensure DOM is ready
        setTimeout(() => {
            if (!state.courses.modalOpen) {
                openCoursesModal();
            }
        }, 100);
    }
    // Handle My Courses button from profile menu
    if (!state.public.readOnly) {
        document.addEventListener("profile-my-courses-click", () => {
            if (state.courses.modalOpen) {
                closeCoursesModal();
                return;
            }
            openCoursesModal();
        });
    }
    document.getElementById("calendar-view-week")?.addEventListener("click", () => {
        state.view = "week";
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    document.getElementById("calendar-view-month")?.addEventListener("click", () => {
        state.view = "month";
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    document.getElementById("calendar-prev")?.addEventListener("click", () => {
        state.anchorDate = shiftAnchorDate(-1);
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    document.getElementById("calendar-next")?.addEventListener("click", () => {
        state.anchorDate = shiftAnchorDate(1);
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    document.getElementById("calendar-refresh")?.addEventListener("click", () => {
        void runManualRefresh(getBufferedRange(getCurrentRenderRange()));
    });
    document.getElementById("calendar-share")?.addEventListener("click", () => {
        openCalendarShareModal();
    });
    document.getElementById("calendar-toggle-menu")?.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = !state.ui.calendarMenuOpen;
        state.ui.calendarMenuOpen = opening;
        if (!state.ui.calendarMenuOpen) {
            closeCalendarContextMenu();
            closeRgbModal();
        } else {
            void ensureCalendarPreferencesLoaded();
            if (state.ui.preferenceDirty.size) {
                scheduleCalendarPreferenceFlush(0);
            }
        }
        renderCalendarMenu();
    });
    document.getElementById("calendar-menu")?.addEventListener("change", (event) => {
        const checkbox = event.target.closest(".js-calendar-checkbox");
        if (!checkbox) return;
        event.stopPropagation();
        const calendarName = checkbox.getAttribute("data-calendar-name");
        if (!calendarName) return;
        toggleCalendarVisibility(calendarName);
        state.ui.calendarMenuOpen = true;
        renderCalendarMenu();
    });
    document.getElementById("calendar-menu")?.addEventListener("click", (event) => {
        const addBtn = event.target.closest(".js-calendar-add-source");
        if (addBtn) {
            event.preventDefault();
            event.stopPropagation();
            if (state.public.readOnly) return;
            openCalendarSourceCreateModal();
            return;
        }
        const moreBtn = event.target.closest(".js-calendar-more");
        if (!moreBtn) return;
        event.stopPropagation();
        if (state.public.readOnly) return;
        const calendarName = moreBtn.getAttribute("data-calendar-name");
        if (!calendarName) return;
        if (state.ui.contextMenuEl && state.ui.contextCalendarName === calendarName && state.ui.contextAnchorEl === moreBtn) {
            closeCalendarContextMenu();
            return;
        }
        openCalendarContextMenu(calendarName, moreBtn);
    });
    document.addEventListener("pointerdown", (event) => {
        const popoverRoot = document.getElementById("calendar-popover-root");
        const inRoot = popoverRoot ? popoverRoot.contains(event.target) : false;
        const inContext = state.ui.contextMenuEl ? state.ui.contextMenuEl.contains(event.target) : false;
        const inRgb = state.ui.rgbModalEl ? state.ui.rgbModalEl.contains(event.target) : false;
        const inSourceInfo = state.ui.sourceInfoModalEl ? state.ui.sourceInfoModalEl.contains(event.target) : false;
        const inSourceCreate = state.ui.sourceCreateModalEl ? state.ui.sourceCreateModalEl.contains(event.target) : false;
        const inShare = state.ui.shareModalEl ? state.ui.shareModalEl.contains(event.target) : false;
        if (!inRoot && !inContext && !inRgb && !inSourceInfo && !inSourceCreate && !inShare) {
            closeAllCalendarPopups();
        }
    }, true);
    window.addEventListener("resize", () => {
        positionCalendarContextMenu();
    });
    window.addEventListener("scroll", () => {
        positionCalendarContextMenu();
        positionCalendarHoverCard();
    }, true);
    window.addEventListener("resize", () => {
        positionCalendarHoverCard();
    });
    wireCalendarHoverCard();
    document.addEventListener("click", (event) => {
        const upcomingToggle = event.target.closest(".js-upcoming-toggle");
        if (upcomingToggle) {
            event.preventDefault();
            const eventRef = upcomingToggle.getAttribute("data-event-ref");
            if (!eventRef) return;
            if (state.ui.expandedUpcomingRefs.has(eventRef)) {
                state.ui.expandedUpcomingRefs.delete(eventRef);
            } else {
                state.ui.expandedUpcomingRefs.add(eventRef);
            }
            renderAssignments();
            return;
        }
        const closeBtn = event.target.closest("#courses-modal-close");
        if (closeBtn) {
            closeCoursesModal();
            return;
        }
        if (event.target.id === "courses-modal-overlay") {
            closeCoursesModal();
            return;
        }
        const infoBtn = event.target.closest(".js-course-info-toggle");
        if (infoBtn) {
            event.preventDefault();
            const sectionId = infoBtn.getAttribute("data-section-id");
            if (!sectionId) return;
            if (state.courses.expandedDetails.has(sectionId)) {
                state.courses.expandedDetails.delete(sectionId);
            } else {
                state.courses.expandedDetails.add(sectionId);
            }
            renderCoursesModal();
            return;
        }
        const addBtn = event.target.closest(".js-course-toggle");
        if (addBtn) {
            event.preventDefault();
            const sectionId = addBtn.getAttribute("data-section-id");
            if (!sectionId) return;
            toggleCourseSectionSelection(sectionId);
            return;
        }
        const searchSubmitBtn = event.target.closest("#courses-search-submit");
        if (searchSubmitBtn) {
            event.preventDefault();
            submitCoursesSearch();
            return;
        }
    });
    document.addEventListener("input", (event) => {
        const searchInput = event.target.closest("#courses-search-input");
        if (!searchInput) return;
        state.courses.searchInput = searchInput.value || "";
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        const searchInput = event.target.closest("#courses-search-input");
        if (!searchInput) return;
        event.preventDefault();
        submitCoursesSearch();
    });
    document.addEventListener("change", (event) => {
        const termSelect = event.target.closest("#courses-term-select");
        if (!termSelect) return;
        state.courses.termFilter = termSelect.value || "";
        applyCourseFilters();
        writeCourseFiltersToUrl();
        renderCoursesModal();
    });
    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && state.courses.modalOpen) {
            closeCoursesModal();
        }
        if (event.key === "Escape") {
            closeAllCalendarPopups();
        }
    });
    window.addEventListener("popstate", () => {
        applyCoursesFiltersFromUrl();
        state.courses.searchInput = state.courses.searchQuery;
        applyCourseFilters();
        if (state.courses.modalOpen) {
            renderCoursesModal();
        }
    });
}
function wireCalendarHoverCard() {
    const root = document.getElementById("calendar-view-root");
    if (!root || root.dataset.hoverCardWired === "true") return;
    root.dataset.hoverCardWired = "true";
    root.addEventListener("pointerover", (event) => {
        if (event.pointerType === "touch") return;
        const eventEl = getCalendarEventElement(event.target);
        if (!eventEl) return;
        if (event.relatedTarget && eventEl.contains(event.relatedTarget)) return;
        showCalendarHoverCard(eventEl);
    });
    root.addEventListener("pointerout", (event) => {
        const eventEl = getCalendarEventElement(event.target);
        if (!eventEl) return;
        const related = event.relatedTarget;
        if (related && (eventEl.contains(related) || state.ui.hoverCardEl?.contains(related))) return;
        scheduleCalendarHoverCardHide();
    });
    root.addEventListener("focusin", (event) => {
        const eventEl = getCalendarEventElement(event.target);
        if (eventEl) showCalendarHoverCard(eventEl);
    });
    root.addEventListener("focusout", (event) => {
        const related = event.relatedTarget;
        if (related && state.ui.hoverCardEl?.contains(related)) return;
        scheduleCalendarHoverCardHide(80);
    });
}
function getCalendarEventElement(target) {
    if (!(target instanceof Element)) return null;
    const root = document.getElementById("calendar-view-root");
    const eventEl = target.closest("[data-event-ref]");
    return eventEl && root?.contains(eventEl) ? eventEl : null;
}
function ensureCalendarHoverCard() {
    if (state.ui.hoverCardEl) return state.ui.hoverCardEl;
    const card = document.createElement("div");
    card.className = "calendar-event-hover-card";
    card.setAttribute("role", "tooltip");
    card.hidden = true;
    card.addEventListener("pointerenter", () => {
        if (state.ui.hoverCardHideTimer) {
            clearTimeout(state.ui.hoverCardHideTimer);
            state.ui.hoverCardHideTimer = null;
        }
    });
    card.addEventListener("pointerleave", () => scheduleCalendarHoverCardHide());
    document.body.appendChild(card);
    state.ui.hoverCardEl = card;
    return card;
}
function showCalendarHoverCard(anchorEl) {
    const eventRef = anchorEl.getAttribute("data-event-ref");
    const event = getCalendarEventByRef(eventRef);
    if (!event) return;
    if (state.ui.hoverCardHideTimer) {
        clearTimeout(state.ui.hoverCardHideTimer);
        state.ui.hoverCardHideTimer = null;
    }
    const card = ensureCalendarHoverCard();
    state.ui.hoverCardAnchorEl = anchorEl;
    card.innerHTML = buildCalendarHoverCardHtml(event);
    card.hidden = false;
    card.style.visibility = "hidden";
    positionCalendarHoverCard();
    card.style.visibility = "";
}
function scheduleCalendarHoverCardHide(delayMs = 120) {
    if (state.ui.hoverCardHideTimer) clearTimeout(state.ui.hoverCardHideTimer);
    state.ui.hoverCardHideTimer = setTimeout(() => {
        hideCalendarHoverCard();
    }, delayMs);
}
function hideCalendarHoverCard() {
    if (state.ui.hoverCardHideTimer) {
        clearTimeout(state.ui.hoverCardHideTimer);
        state.ui.hoverCardHideTimer = null;
    }
    if (state.ui.hoverCardEl) {
        state.ui.hoverCardEl.hidden = true;
        state.ui.hoverCardEl.innerHTML = "";
    }
    state.ui.hoverCardAnchorEl = null;
}
function positionCalendarHoverCard() {
    const card = state.ui.hoverCardEl;
    const anchorEl = state.ui.hoverCardAnchorEl;
    if (!card || card.hidden || !anchorEl || !document.body.contains(anchorEl)) return;
    const margin = 12;
    const gap = 8;
    const wide = window.innerWidth >= 900;
    const preferredWidth = wide ? 420 : 320;
    const width = Math.max(260, Math.min(preferredWidth, window.innerWidth - margin * 2));
    card.style.width = `${width}px`;
    card.style.maxHeight = `${Math.max(180, window.innerHeight - margin * 2)}px`;
    card.style.left = "0px";
    card.style.top = "0px";
    const anchorRect = anchorEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;
    if (wide && anchorRect.right + gap + cardRect.width + margin <= window.innerWidth) {
        left = anchorRect.right + gap;
        top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
    } else if (wide && anchorRect.left - gap - cardRect.width >= margin) {
        left = anchorRect.left - cardRect.width - gap;
        top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
    } else {
        const availableBelow = Math.max(0, window.innerHeight - anchorRect.bottom - gap - margin);
        const availableAbove = Math.max(0, anchorRect.top - gap - margin);
        const placeBelow = availableBelow >= availableAbove;
        const availableHeight = Math.max(120, placeBelow ? availableBelow : availableAbove);
        card.style.maxHeight = `${availableHeight}px`;
        const adjustedRect = card.getBoundingClientRect();
        if (left + cardRect.width + margin > window.innerWidth) {
            left = window.innerWidth - adjustedRect.width - margin;
        }
        if (left < margin) left = margin;
        top = placeBelow ? anchorRect.bottom + gap : anchorRect.top - adjustedRect.height - gap;
    }
    const finalRect = card.getBoundingClientRect();
    top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - finalRect.height - margin));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
}
function buildCalendarHoverCardHtml(event) {
    const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
    const calendarLabel = getEventCalendarLabel(event);
    return `
        <div class="calendar-event-hover-title">${escapeHtml(event.title || "Untitled")}</div>
        <div class="calendar-event-hover-meta">${escapeHtml(timeDisplay)}</div>
        <div class="calendar-event-hover-calendar">${escapeHtml(calendarLabel)}</div>
        ${event.description ? `<div class="calendar-event-hover-description">${formatMultilineText(event.description)}</div>` : ""}
    `;
}
function closeCalendarDropdown() {
    state.ui.calendarMenuOpen = false;
    renderCalendarMenu();
}
function closeCalendarContextMenu() {
    if (state.ui.contextMenuEl) {
        state.ui.contextMenuEl.remove();
        state.ui.contextMenuEl = null;
    }
    state.ui.contextAnchorEl = null;
    state.ui.contextCalendarName = null;
}
function closeRgbModal() {
    if (state.ui.rgbModalEl) {
        state.ui.rgbModalEl.remove();
        state.ui.rgbModalEl = null;
    }
}
function closeSourceInfoModal() {
    if (state.ui.sourceInfoModalEl) {
        state.ui.sourceInfoModalEl.remove();
        state.ui.sourceInfoModalEl = null;
    }
}
function closeCalendarShareModal(immediate = false) {
    if (state.ui.shareModalEl) {
        const modal = state.ui.shareModalEl;
        if (immediate) {
            modal.remove();
        } else {
            modal.classList.add("is-closing");
            window.setTimeout(() => {
                modal.remove();
            }, CALENDAR_SHARE_CLOSE_MS);
        }
        state.ui.shareModalEl = null;
    }
    state.shares.editingId = null;
    state.shares.error = "";
}
function closeAllCalendarPopups() {
    closeCalendarContextMenu();
    closeRgbModal();
    closeSourceInfoModal();
    closeCalendarSourceCreateModal();
    closeCalendarShareModal();
    closeCalendarDropdown();
}
function shiftAnchorDate(delta) {
    const next = new Date(state.anchorDate);
    if (state.view === "month") {
        next.setMonth(next.getMonth() + delta);
    } else {
        next.setDate(next.getDate() + delta * 7);
    }
    return next;
}
/* ── Calendar Menu Rendering ─────────────────────────────────────────────── */
function buildCalendarMenuHtml() {
    const calendars = Object.entries(state.calendars).sort(([, a], [, b]) => getCalendarLabelFromData(a).localeCompare(getCalendarLabelFromData(b)));
    const showSimulated = state.courses.selectedSectionIds.size > 0;
    const notice = state.ui.preferenceNotice
        ? `<div class="calendar-source-notice" role="status">${escapeHtml(state.ui.preferenceNotice)}</div>`
        : "";
    const buildRows = (items) => items.map(([cal, data]) => {
        const checked = data.visible ? "checked" : "";
        const label = getCalendarLabel(cal);
        const eventCount = getCalendarEventCount(cal);
        const kindLabel = data.kind === "local" ? "Local" : (data.editable ? "Feed" : "");
        const meta = `${eventCount} event${eventCount === 1 ? "" : "s"}${kindLabel ? ` · ${kindLabel}` : ""}`;
        const moreButton = state.public.readOnly ? "" : `
                <button type="button"
                    class="js-calendar-more calendar-source-more"
                    data-calendar-name="${escapeHtml(cal)}"
                    aria-label="Calendar options">
                    <span class="material-symbols-outlined calendar-source-more-icon" style="font-variation-settings:'FILL' 1,'wght' 700,'GRAD' 0,'opsz' 24;">more_horiz</span>
                </button>
        `;
        return `
            <div class="calendar-source-row">
                <label class="calendar-source-label">
                    <input type="checkbox" ${checked}
                        class="js-calendar-checkbox calendar-source-checkbox"
                        data-calendar-name="${escapeHtml(cal)}"
                        style="background-color:${data.color};">
                    <span class="calendar-source-text">
                        <span class="calendar-source-name">${escapeHtml(label)}</span>
                        <span class="calendar-source-meta">${escapeHtml(meta)}</span>
                    </span>
                </label>
                ${moreButton}
            </div>
        `;
    }).join("");
    const nestCalendars = calendars.filter(([name]) => {
        if (name === CANVAS_SOURCE_ID || name === CANVAS_CALENDAR_NAME) return true;
        if (name === TASK_CALENDAR_ID || name === TASK_CALENDAR_NAME) return true;
        if (name === SIMULATED_CALENDAR_NAME) return showSimulated;
        return false;
    });
    const otherCalendars = calendars.filter(([name]) => {
        if (name === CANVAS_SOURCE_ID || name === CANVAS_CALENDAR_NAME) return false;
        if (name === TASK_CALENDAR_ID || name === TASK_CALENDAR_NAME) return false;
        if (name === SIMULATED_CALENDAR_NAME) return false;
        return true;
    });
    const nestSection = `
        <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.08em] text-on-surface-variant font-semibold">Nest</div>
        ${buildRows(nestCalendars)}
    `;
    const otherSection = `
        <div class="h-px bg-outline-variant/25 my-1"></div>
        <div class="calendar-source-section-head">
            <span>Other</span>
            ${state.public.readOnly ? "" : `<button type="button" class="js-calendar-add-source calendar-source-add" aria-label="Add other calendar">
                <span class="material-symbols-outlined calendar-source-add-icon">add</span>
            </button>`}
        </div>
        ${otherCalendars.length ? buildRows(otherCalendars) : '<div class="px-3 py-2 text-sm text-on-surface-variant">No other calendars</div>'}
    `;
    return `
        <div class="calendar-source-menu absolute top-full right-0 mt-2">
            ${notice}
            ${nestSection}
            ${otherSection}
        </div>
    `;
}
function getCalendarLabelFromData(data) {
    return data?.label || data?.defaultName || "";
}
function getCurrentViewCountRange() {
    if (state.view === "month") {
        const year = state.anchorDate.getFullYear();
        const month = state.anchorDate.getMonth();
        return {
            start: new Date(year, month, 1, 0, 0, 0, 0),
            end: new Date(year, month + 1, 1, 0, 0, 0, 0),
        };
    }
    const start = getStartOfWeek(state.anchorDate);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
}
function eventOverlapsCountRange(event, range) {
    const start = event.startDate;
    const end = event.endDate || event.startDate;
    if (!start || !end) return false;
    if (event.isAllDay) {
        const eventStartDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const eventEndDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        return eventStartDay < range.end && eventEndDay > range.start;
    }
    return start < range.end && end > range.start;
}
function getCountableEventsForCurrentView() {
    const range = getCurrentViewCountRange();
    const events = [...state.events];
    if (!state.public.readOnly && state.courses.selectedSectionIds.size > 0) {
        events.push(...buildSimulatedMeetingEvents(range.start, range.end));
    }
    return events.filter((event) => eventOverlapsCountRange(event, range));
}
function getCalendarEventCount(calendarName) {
    return getCountableEventsForCurrentView().filter((event) => getEventCalendarKey(event) === calendarName).length;
}
function openCalendarContextMenu(calendarName, anchorEl) {
    closeCalendarContextMenu();
    state.ui.contextCalendarName = calendarName;
    state.ui.contextAnchorEl = anchorEl;
    const currentColor = state.calendars[calendarName]?.color || "#6366f1";
    const eventCount = getCalendarEventCount(calendarName);
    const label = getCalendarLabel(calendarName);
    const menu = document.createElement("div");
    menu.className = "calendar-context-menu fixed";
    menu.innerHTML = `
        <div class="calendar-context-header">
            <div class="calendar-context-title">${escapeHtml(label)}</div>
            <div class="calendar-context-meta">${eventCount} event${eventCount === 1 ? "" : "s"}</div>
        </div>
        <div class="calendar-context-body">
            <button type="button" class="js-context-info calendar-context-action">
                <span class="material-symbols-outlined calendar-context-action-icon">info</span>
                <span>Get Info</span>
            </button>
            <div class="calendar-context-separator"></div>
            <div class="calendar-context-colors">
                <div class="calendar-context-section-label">Colors</div>
                <div class="calendar-context-color-grid">
                    ${state.calendarColors.map((color) => `
                        <button type="button"
                            class="js-context-preset calendar-context-preset"
                            data-color="${color}"
                            aria-label="Use ${escapeHtml(color)}"
                            style="background:${color}; border-color:${currentColor === color ? "var(--color-on-surface)" : "transparent"};">
                        </button>
                    `).join("")}
                </div>
            </div>
            <div class="calendar-context-separator"></div>
            <button type="button" class="js-context-custom calendar-context-action">
                <span class="material-symbols-outlined calendar-context-action-icon">palette</span>
                <span>Custom Color...</span>
            </button>
        </div>
    `;
    menu.addEventListener("click", async (event) => {
        const infoBtn = event.target.closest(".js-context-info");
        if (infoBtn) {
            openCalendarInfoModal(calendarName);
            closeCalendarContextMenu();
            return;
        }
        const presetBtn = event.target.closest(".js-context-preset");
        if (presetBtn) {
            const color = presetBtn.getAttribute("data-color");
            if (color) {
                setCalendarColor(calendarName, color);
                closeCalendarContextMenu();
            }
            return;
        }
        const customBtn = event.target.closest(".js-context-custom");
        if (customBtn) {
            openRgbModal(calendarName);
        }
    });
    document.body.appendChild(menu);
    state.ui.contextMenuEl = menu;
    positionCalendarContextMenu();
}
function positionCalendarContextMenu() {
    if (!state.ui.contextMenuEl || !state.ui.contextAnchorEl) return;
    const menu = state.ui.contextMenuEl;
    const anchorRect = state.ui.contextAnchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = anchorRect.right - menuRect.width;
    let top = anchorRect.bottom + 8;
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
    if (left < 8) left = 8;
    if (top + menuRect.height > window.innerHeight - 8) {
        top = anchorRect.top - menuRect.height - 8;
    }
    if (top < 8) top = 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}
function openCalendarInfoModal(calendarName) {
    closeSourceInfoModal();
    const calendar = state.calendars[calendarName];
    if (!calendar) return;
    const editable = Boolean(calendar.editable && calendar.sourceId);
    const isLocal = calendar.kind === "local" || isLocalCalendar(calendarName);
    const eventCount = getCalendarEventCount(calendarName);
    const label = getCalendarLabel(calendarName);
    const modal = document.createElement("div");
    modal.className = "calendar-info-modal";
    modal.innerHTML = `
        <div class="calendar-info-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-info-title">
            <div class="calendar-info-header">
                <div class="calendar-info-heading">
                    <h3 id="calendar-info-title" class="calendar-info-title">Calendar Info</h3>
                    <p class="calendar-info-subtitle">${escapeHtml(label)}</p>
                </div>
                <button type="button" class="js-source-info-close calendar-info-close" aria-label="Close calendar info">
                    <span class="material-symbols-outlined calendar-info-close-icon">close</span>
                </button>
            </div>
            <div class="calendar-info-body">
                <div class="calendar-info-stats">
                    <div class="calendar-info-stat">
                        <div class="calendar-info-stat-label">Events</div>
                        <div class="calendar-info-stat-value">${eventCount}</div>
                    </div>
                    <div class="calendar-info-stat">
                        <div class="calendar-info-stat-label">Type</div>
                        <div class="calendar-info-stat-value">${escapeHtml(calendar.kind || "local")}</div>
                    </div>
                </div>
                <label class="calendar-info-field">
                    <span class="calendar-info-label">Name</span>
                    <input class="js-source-info-name calendar-info-input" type="text" value="${escapeHtml(label)}" ${editable ? "" : "disabled"}>
                </label>
                ${isLocal ? "" : `<label class="calendar-info-field">
                    <span class="calendar-info-label">URL</span>
                    <input class="js-source-info-url calendar-info-input" type="url" inputmode="url" value="${escapeHtml(calendar.url || "")}" placeholder="https://calendar.example.com/feed.ics" ${editable ? "" : "disabled"}>
                </label>`}
                ${editable ? "" : '<p class="calendar-info-note">This calendar is generated inside Nest and does not have an editable feed URL.</p>'}
                <p class="js-source-info-error calendar-info-error hidden"></p>
            </div>
            <div class="calendar-info-footer">
                <button type="button" class="js-source-info-cancel calendar-info-button calendar-info-button-secondary">Close</button>
                ${editable ? '<button type="button" class="js-source-info-save calendar-info-button calendar-info-button-primary">Save</button>' : ""}
            </div>
        </div>
    `;
    modal.addEventListener("click", async (event) => {
        if (event.target === modal || event.target.closest(".js-source-info-close") || event.target.closest(".js-source-info-cancel")) {
            closeSourceInfoModal();
            return;
        }
        const saveButton = event.target.closest(".js-source-info-save");
        if (!saveButton || saveButton.disabled) return;
        await saveCalendarSourceInfo(calendarName, modal, saveButton);
    });
    document.body.appendChild(modal);
    state.ui.sourceInfoModalEl = modal;
    modal.querySelector(".js-source-info-name")?.focus();
}
async function saveCalendarSourceInfo(calendarName, modal, saveButton) {
    const calendar = state.calendars[calendarName];
    if (!calendar?.sourceId) return;
    const nameInput = modal.querySelector(".js-source-info-name");
    const urlInput = modal.querySelector(".js-source-info-url");
    const errorEl = modal.querySelector(".js-source-info-error");
    const payload = {
        source_id: calendar.sourceId,
        display_name: nameInput?.value?.trim() || "",
        url: urlInput?.value?.trim() || "",
    };
    const showError = (message) => {
        if (!errorEl) return;
        errorEl.textContent = message || "Unable to save calendar.";
        errorEl.classList.remove("hidden");
    };
    if (calendar.kind !== "local" && !payload.url) {
        showError("Calendar URL is required.");
        return;
    }
    saveButton.disabled = true;
    const previousLabel = saveButton.textContent;
    saveButton.textContent = "Saving...";
    try {
        const res = await trackCalendarMutation(fetch("/api/calendar/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }));
        const response = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(response.error || "Unable to save calendar.");
        }
        localStorage.removeItem(EVENTS_CACHE_KEY);
        invalidateCalendarPreferencesCache();
        closeSourceInfoModal();
        closeCalendarContextMenu();
        state.ui.calendarMenuOpen = true;
        if (response.refresh_required) {
            await runManualRefresh(getBufferedRange(getCurrentRenderRange()));
        } else {
            await loadCalendarData();
        }
    } catch (err) {
        showError(err.message || "Unable to save calendar.");
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = previousLabel;
    }
}
function closeCalendarSourceCreateModal() {
    if (state.ui.sourceCreateModalEl) {
        state.ui.sourceCreateModalEl.remove();
        state.ui.sourceCreateModalEl = null;
    }
}
function openCalendarSourceCreateModal() {
    closeCalendarSourceCreateModal();
    closeCalendarContextMenu();
    closeRgbModal();
    const modal = document.createElement("div");
    modal.className = "calendar-info-modal";
    const colors = state.calendarColors;
    let mode = "url";
    let selectedColor = colors[4] || "#0ea5e9";
    let draftName = "";
    let draftUrl = "";
    const renderBody = () => {
        modal.innerHTML = `
            <div class="calendar-info-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-source-create-title">
                <div class="calendar-info-header">
                    <div class="calendar-info-heading">
                        <h3 id="calendar-source-create-title" class="calendar-info-title">Add Calendar</h3>
                        <p class="calendar-info-subtitle">Create a local calendar or subscribe from a URL.</p>
                    </div>
                    <button type="button" class="js-source-create-close calendar-info-close" aria-label="Close add calendar">
                        <span class="material-symbols-outlined calendar-info-close-icon">close</span>
                    </button>
                </div>
                <div class="calendar-info-body">
                    <div class="calendar-source-mode-toggle" role="group" aria-label="Calendar source type">
                        <button type="button" class="js-source-create-mode calendar-source-mode ${mode === "url" ? "is-active" : ""}" data-mode="url">From URL</button>
                        <button type="button" class="js-source-create-mode calendar-source-mode ${mode === "local" ? "is-active" : ""}" data-mode="local">Create New Calendar</button>
                    </div>
                    <label class="calendar-info-field">
                        <span class="calendar-info-label">Name (optional)</span>
                        <input class="js-source-create-name calendar-info-input" type="text" value="${escapeHtml(draftName)}" placeholder="${mode === "url" ? "Subscribed Calendar" : "Personal"}">
                    </label>
                    ${mode === "url" ? `
                    <label class="calendar-info-field">
                        <span class="calendar-info-label">URL</span>
                        <input class="js-source-create-url calendar-info-input" type="url" inputmode="url" value="${escapeHtml(draftUrl)}" placeholder="https://calendar.example.com/feed.ics">
                    </label>
                    ` : ""}
                    <div class="calendar-info-field">
                        <span class="calendar-info-label">Color</span>
                        <div class="calendar-context-color-grid">
                            ${colors.map((color) => `
                                <button type="button"
                                    class="js-source-create-color calendar-context-preset"
                                    data-color="${color}"
                                    aria-label="Use ${escapeHtml(color)}"
                                    style="background:${color}; border-color:${selectedColor === color ? "var(--color-on-surface)" : "transparent"};">
                                </button>
                            `).join("")}
                        </div>
                    </div>
                    <p class="js-source-create-error calendar-info-error hidden"></p>
                </div>
                <div class="calendar-info-footer">
                    <button type="button" class="js-source-create-cancel calendar-info-button calendar-info-button-secondary">Cancel</button>
                    <button type="button" class="js-source-create-save calendar-info-button calendar-info-button-primary">Add</button>
                </div>
            </div>
        `;
        modal.querySelector(".js-source-create-name")?.focus();
    };
    renderBody();
    modal.addEventListener("click", async (event) => {
        if (event.target === modal || event.target.closest(".js-source-create-close") || event.target.closest(".js-source-create-cancel")) {
            closeCalendarSourceCreateModal();
            return;
        }
        const modeBtn = event.target.closest(".js-source-create-mode");
        if (modeBtn) {
            draftName = modal.querySelector(".js-source-create-name")?.value?.trim() || draftName;
            draftUrl = modal.querySelector(".js-source-create-url")?.value?.trim() || draftUrl;
            mode = modeBtn.getAttribute("data-mode") === "local" ? "local" : "url";
            renderBody();
            return;
        }
        const colorBtn = event.target.closest(".js-source-create-color");
        if (colorBtn) {
            draftName = modal.querySelector(".js-source-create-name")?.value?.trim() || draftName;
            draftUrl = modal.querySelector(".js-source-create-url")?.value?.trim() || draftUrl;
            selectedColor = colorBtn.getAttribute("data-color") || selectedColor;
            renderBody();
            return;
        }
        const saveButton = event.target.closest(".js-source-create-save");
        if (!saveButton || saveButton.disabled) return;
        const name = modal.querySelector(".js-source-create-name")?.value?.trim() || "";
        const calendarUrl = modal.querySelector(".js-source-create-url")?.value?.trim() || "";
        const errorEl = modal.querySelector(".js-source-create-error");
        const showError = (message) => {
            if (!errorEl) return;
            errorEl.textContent = message || "Unable to add calendar.";
            errorEl.classList.remove("hidden");
        };
        if (mode === "url" && !calendarUrl) {
            showError("Calendar URL is required.");
            return;
        }
        saveButton.disabled = true;
        saveButton.textContent = "Adding...";
        try {
            const res = await trackCalendarMutation(fetch(mode === "local" ? "/api/calendar/sources/local" : "/api/calendar/sources/url", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    display_name: name,
                    url: calendarUrl,
                    color_hex: selectedColor,
                }),
            }));
            const response = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(response.error || "Unable to add calendar.");
            }
            localStorage.removeItem(EVENTS_CACHE_KEY);
            invalidateCalendarPreferencesCache();
            closeCalendarSourceCreateModal();
            state.ui.calendarMenuOpen = true;
            await loadCalendarData();
        } catch (err) {
            showError(err.message || "Unable to add calendar.");
            saveButton.disabled = false;
            saveButton.textContent = "Add";
        }
    });
    document.body.appendChild(modal);
    state.ui.sourceCreateModalEl = modal;
    modal.querySelector(".js-source-create-name")?.focus();
}
function rgbToHex(r, g, b) {
    const toHex = (value) => Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function openRgbModal(calendarName) {
    closeRgbModal();
    const current = state.calendars[calendarName]?.color || "#6366f1";
    const match = /^#([0-9a-fA-F]{6})$/.exec(current);
    const hex = match ? match[1] : "6366f1";
    const initial = {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
    };
    const modal = document.createElement("div");
    modal.className = "fixed inset-0 z-[80] bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4";
    modal.innerHTML = `
        <div class="w-full max-w-[480px] rounded-2xl border border-outline-variant/40 bg-surface p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label="Custom calendar color">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-base font-semibold text-on-surface">Custom Color</h3>
                <button type="button" class="js-rgb-close p-1 rounded bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" aria-label="Close color picker">
                    <span class="material-symbols-outlined text-[18px]">close</span>
                </button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-4">
                <div class="space-y-3">
                    ${["r", "g", "b"].map((channel) => `
                        <div>
                            <div class="flex items-center justify-between text-xs text-on-surface-variant mb-1.5">
                                <span>${channel.toUpperCase()}</span>
                                <input type="number" min="0" max="255" value="${initial[channel]}" class="js-rgb-number w-16 rounded border border-outline-variant/50 bg-surface-container-low px-2 py-1 text-right text-sm text-on-surface" data-channel="${channel}">
                            </div>
                            <input type="range" min="0" max="255" value="${initial[channel]}" class="js-rgb-range w-full" data-channel="${channel}">
                        </div>
                    `).join("")}
                </div>
                <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-3 flex flex-col gap-2">
                    <div class="text-xs text-on-surface-variant">Preview</div>
                    <div class="h-16 rounded-lg border border-black/15 js-rgb-preview"></div>
                    <div class="text-xs text-on-surface-variant">Hex</div>
                    <div class="font-mono text-sm text-on-surface js-rgb-hex"></div>
                </div>
            </div>
            <div class="mt-5 flex justify-end gap-2">
                <button type="button" class="js-rgb-cancel px-3 py-1.5 rounded-md text-sm bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors">Cancel</button>
                <button type="button" class="js-rgb-save px-3 py-1.5 rounded-md bg-primary text-on-primary text-sm font-medium hover:bg-primary-container hover:text-on-primary-container disabled:opacity-60 disabled:cursor-not-allowed">Save</button>
            </div>
        </div>
    `;
    const readRgb = () => {
        const getValue = (channel) => {
            const num = modal.querySelector(`.js-rgb-number[data-channel='${channel}']`);
            return Math.max(0, Math.min(255, Number(num?.value || 0)));
        };
        return { r: getValue("r"), g: getValue("g"), b: getValue("b") };
    };
    const paintPreview = () => {
        const { r, g, b } = readRgb();
        const hexValue = rgbToHex(r, g, b);
        const preview = modal.querySelector(".js-rgb-preview");
        const hexText = modal.querySelector(".js-rgb-hex");
        if (preview) preview.style.background = hexValue;
        if (hexText) hexText.textContent = hexValue.toUpperCase();
    };
    modal.addEventListener("input", (event) => {
        const range = event.target.closest(".js-rgb-range");
        const number = event.target.closest(".js-rgb-number");
        if (range) {
            const channel = range.getAttribute("data-channel");
            const input = modal.querySelector(`.js-rgb-number[data-channel='${channel}']`);
            if (input) input.value = range.value;
            paintPreview();
            return;
        }
        if (number) {
            const channel = number.getAttribute("data-channel");
            const next = Math.max(0, Math.min(255, Number(number.value || 0)));
            number.value = String(next);
            const input = modal.querySelector(`.js-rgb-range[data-channel='${channel}']`);
            if (input) input.value = String(next);
            paintPreview();
        }
    });
    modal.addEventListener("click", async (event) => {
        if (event.target === modal || event.target.closest(".js-rgb-close") || event.target.closest(".js-rgb-cancel")) {
            closeRgbModal();
            return;
        }
        if (event.target.closest(".js-rgb-save")) {
            const saveButton = modal.querySelector(".js-rgb-save");
            if (saveButton?.disabled) return;
            const { r, g, b } = readRgb();
            const hexValue = rgbToHex(r, g, b);
            if (!/^#[0-9a-fA-F]{6}$/.test(hexValue)) return;
            if (saveButton) {
                saveButton.disabled = true;
                saveButton.innerHTML = `<span class="inline-flex flex-col items-center justify-center gap-1 leading-none"><span class="loader" style="width:16px; height:16px;" aria-hidden="true"></span><span class="text-[10px]">Saving...</span></span>`;
            }
            setCalendarColor(calendarName, hexValue);
            queueCalendarPreferenceSave(calendarName, 0);
            closeRgbModal();
            closeCalendarContextMenu();
            state.ui.calendarMenuOpen = true;
            renderCalendarMenu();
        }
    });
    document.body.appendChild(modal);
    state.ui.rgbModalEl = modal;
    paintPreview();
}
/* ── Calendar Sharing ─────────────────────────────────────────────────────── */
async function loadCalendarShares(force = false) {
    if (state.public.readOnly) return;
    if (state.shares.loading || (state.shares.loaded && !force)) return;
    state.shares.loading = true;
    state.shares.error = "";
    renderCalendarShareModal();
    try {
        const res = await fetch("/api/calendar/shares");
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || "Unable to load share links.");
        state.shares.items = Array.isArray(payload.shares) ? payload.shares : [];
        state.shares.loaded = true;
    } catch (err) {
        state.shares.error = err.message || "Unable to load share links.";
    } finally {
        state.shares.loading = false;
        renderCalendarShareModal();
    }
}
function openCalendarShareModal() {
    if (state.public.readOnly) return;
    closeCalendarShareModal(true);
    const modal = document.createElement("div");
    modal.className = "calendar-info-modal calendar-share-modal";
    modal.addEventListener("click", onCalendarShareModalClick);
    modal.addEventListener("change", onCalendarShareModalChange);
    modal.addEventListener("submit", onCalendarShareModalSubmit);
    document.body.appendChild(modal);
    state.ui.shareModalEl = modal;
    renderCalendarShareModal();
    void loadCalendarShares();
}
function renderCalendarShareModal() {
    const modal = state.ui.shareModalEl;
    if (!modal) return;
    const editingShare = state.shares.items.find((share) => share.id === state.shares.editingId) || null;
    const seed = editingShare || {
        includeAllCalendars: true,
        calendarIds: [],
        dateScope: "all",
        fixedStart: "",
        fixedEnd: "",
        rollingDays: 30,
    };
    const shareableCalendars = Object.entries(state.calendars)
        .filter(([name]) => name !== SIMULATED_CALENDAR_NAME)
        .sort(([, a], [, b]) => getCalendarLabelFromData(a).localeCompare(getCalendarLabelFromData(b)));
    const selectedIds = new Set(seed.calendarIds || []);
    const includeAll = seed.includeAllCalendars !== false;
    const editingCode = editingShare?.shareCode || "";
    const modalTitle = editingShare ? "Edit Shared Link" : "Share Calendar";
    const modalSubtitle = editingShare
        ? `Updating settings for share link ${editingCode || "selected link"}.`
        : "Create reusable read-only links for selected calendars and dates.";
    const editingBanner = editingShare ? `
        <div class="calendar-share-editing-banner" role="status">
            <span class="material-symbols-outlined calendar-share-editing-icon" aria-hidden="true">edit</span>
            <span>
                <strong>Editing shared link</strong>
                <span>${escapeHtml(editingCode || "Selected link")} · ${escapeHtml(editingShare.scopeLabel || "All shared dates")}</span>
            </span>
        </div>
    ` : "";
    const calendarChoices = shareableCalendars.length
        ? shareableCalendars.map(([calendarName, data]) => `
            <label class="calendar-share-calendar-choice">
                <input type="checkbox" name="calendar_ids" value="${escapeHtml(calendarName)}" ${includeAll || selectedIds.has(calendarName) ? "checked" : ""} ${includeAll ? "disabled" : ""}>
                <span class="calendar-share-calendar-dot" style="background:${data.color};"></span>
                <span>${escapeHtml(getCalendarLabel(calendarName))}</span>
            </label>
        `).join("")
        : '<p class="calendar-info-note">Load or add a calendar before limiting by calendar.</p>';
    const sharesList = state.shares.loading
        ? `<div class="calendar-share-empty">${window.APStudyLoader.html("Loading share links...", { sizePx: 30, textToneClass: "text-on-surface" })}</div>`
        : state.shares.items.length
            ? state.shares.items.map((share) => buildCalendarShareRowHtml(share, editingShare?.id)).join("")
            : '<div class="calendar-share-empty">No share links yet.</div>';
    modal.innerHTML = `
        <div class="calendar-info-dialog calendar-share-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-share-title">
            <div class="calendar-info-header">
                <div class="calendar-info-heading">
                    <h3 id="calendar-share-title" class="calendar-info-title">${escapeHtml(modalTitle)}</h3>
                    <p class="calendar-info-subtitle">${escapeHtml(modalSubtitle)}</p>
                </div>
                <button type="button" class="js-share-close calendar-info-close" aria-label="Close calendar sharing">
                    <span class="material-symbols-outlined calendar-info-close-icon">close</span>
                </button>
            </div>
            <form id="calendar-share-form">
                <div class="calendar-info-body">
                    ${editingBanner}
                    <div class="calendar-share-options">
                        <label class="calendar-share-radio">
                            <input type="radio" name="include_scope" value="all" ${includeAll ? "checked" : ""}>
                            <span>All calendars</span>
                        </label>
                        <label class="calendar-share-radio">
                            <input type="radio" name="include_scope" value="selected" ${includeAll ? "" : "checked"}>
                            <span>Selected calendars</span>
                        </label>
                    </div>
                    <div class="calendar-share-calendar-grid ${includeAll ? "is-disabled" : ""}" aria-disabled="${includeAll ? "true" : "false"}">
                        ${calendarChoices}
                    </div>
                    <label class="calendar-info-field">
                        <span class="calendar-info-label">Date range</span>
                        <select name="date_scope" class="calendar-info-input">
                            <option value="all" ${seed.dateScope === "all" ? "selected" : ""}>All shared dates</option>
                            <option value="fixed" ${seed.dateScope === "fixed" ? "selected" : ""}>Fixed date range</option>
                            <option value="rolling" ${seed.dateScope === "rolling" ? "selected" : ""}>Rolling window</option>
                        </select>
                    </label>
                    <div class="calendar-share-fixed-fields">
                        <label class="calendar-info-field">
                            <span class="calendar-info-label">Start</span>
                            <input name="fixed_start" type="date" class="calendar-info-input" value="${escapeHtml(seed.fixedStart || "")}">
                        </label>
                        <label class="calendar-info-field">
                            <span class="calendar-info-label">End</span>
                            <input name="fixed_end" type="date" class="calendar-info-input" value="${escapeHtml(seed.fixedEnd || "")}">
                        </label>
                    </div>
                    <label class="calendar-info-field calendar-share-rolling-field">
                        <span class="calendar-info-label">Rolling days</span>
                        <input name="rolling_days" type="number" min="1" max="366" step="1" class="calendar-info-input" value="${escapeHtml(seed.rollingDays || 30)}">
                    </label>
                    ${state.shares.error ? `<p class="calendar-info-error">${escapeHtml(state.shares.error)}</p>` : ""}
                    ${state.shares.notice ? `<p class="calendar-share-notice">${escapeHtml(state.shares.notice)}</p>` : ""}
                    <section class="calendar-share-list" aria-label="Calendar share links">
                        <div class="calendar-share-list-head">
                            <span>Links</span>
                            ${editingShare ? '<button type="button" class="js-share-new calendar-info-button calendar-info-button-secondary">New Link</button>' : ""}
                        </div>
                        ${sharesList}
                    </section>
                </div>
                <div class="calendar-info-footer">
                    <button type="submit" class="calendar-info-button calendar-info-button-primary" ${state.shares.saving ? "disabled" : ""}>
                        ${state.shares.saving ? "Saving..." : editingShare ? "Save Link" : "Create Link"}
                    </button>
                </div>
            </form>
        </div>
    `;
    syncCalendarShareModalFields();
}
function buildCalendarShareRowHtml(share, editingId = null) {
    const inactive = !share.isActive;
    const isEditing = share.id === editingId;
    const statusLabel = isEditing ? "Editing now" : inactive ? "Revoked link" : "Active link";
    return `
        <article class="calendar-share-row ${inactive ? "is-inactive" : ""} ${isEditing ? "is-editing" : ""}">
            <div class="calendar-share-row-main">
                <div class="calendar-share-row-title">
                    <span>${statusLabel}</span>
                    <span class="calendar-share-code">${escapeHtml(share.shareCode || "")}</span>
                </div>
                <div class="calendar-share-row-meta">${escapeHtml(share.scopeLabel || "All shared dates")}</div>
                <input class="calendar-info-input calendar-share-url" readonly value="${escapeHtml(share.shareUrl || "")}">
            </div>
            <div class="calendar-share-actions">
                <button type="button" class="js-share-copy calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${inactive ? "disabled" : ""}>Copy</button>
                <button type="button" class="js-share-edit calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${isEditing ? "disabled" : ""}>${isEditing ? "Editing" : "Edit"}</button>
                <button type="button" class="js-share-regenerate calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Regenerate</button>
                ${inactive
                    ? `<button type="button" class="js-share-activate calendar-info-button calendar-info-button-primary" data-share-id="${escapeHtml(share.id)}">Reactivate</button>`
                    : `<button type="button" class="js-share-revoke calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Revoke</button>`}
            </div>
        </article>
    `;
}
function syncCalendarShareModalFields() {
    const modal = state.ui.shareModalEl;
    if (!modal) return;
    const form = modal.querySelector("#calendar-share-form");
    if (!form) return;
    const includeAll = form.include_scope?.value !== "selected";
    form.querySelectorAll("input[name='calendar_ids']").forEach((input) => {
        input.disabled = includeAll;
        if (includeAll) input.checked = true;
    });
    const calendarGrid = modal.querySelector(".calendar-share-calendar-grid");
    if (calendarGrid) {
        calendarGrid.classList.toggle("is-disabled", includeAll);
        calendarGrid.setAttribute("aria-disabled", includeAll ? "true" : "false");
    }
    const scope = form.date_scope?.value || "all";
    const fixedFields = modal.querySelector(".calendar-share-fixed-fields");
    const rollingField = modal.querySelector(".calendar-share-rolling-field");
    if (fixedFields) fixedFields.hidden = scope !== "fixed";
    if (rollingField) rollingField.hidden = scope !== "rolling";
}
function calendarShareFormPayload(form) {
    const includeAll = form.include_scope?.value !== "selected";
    return {
        includeAllCalendars: includeAll,
        calendarIds: includeAll
            ? []
            : Array.from(form.querySelectorAll("input[name='calendar_ids']:checked")).map((input) => input.value),
        dateScope: form.date_scope?.value || "all",
        fixedStart: form.fixed_start?.value || null,
        fixedEnd: form.fixed_end?.value || null,
        rollingDays: form.rolling_days?.value ? Number(form.rolling_days.value) : null,
    };
}
async function saveCalendarSharePayload(payload) {
    state.shares.saving = true;
    state.shares.error = "";
    state.shares.notice = "";
    const editingId = state.shares.editingId;
    renderCalendarShareModal();
    try {
        const res = await trackCalendarMutation(fetch(editingId ? `/api/calendar/shares/${encodeURIComponent(editingId)}` : "/api/calendar/shares", {
            method: editingId ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }));
        const response = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(response.error || "Unable to save share link.");
        const share = response.share;
        if (share?.id) {
            const index = state.shares.items.findIndex((item) => item.id === share.id);
            if (index >= 0) state.shares.items.splice(index, 1, share);
            else state.shares.items.unshift(share);
        }
        state.shares.editingId = null;
        state.shares.notice = editingId ? "Share link updated." : "Share link created.";
    } catch (err) {
        state.shares.error = err.message || "Unable to save share link.";
    } finally {
        state.shares.saving = false;
        renderCalendarShareModal();
    }
}
async function updateCalendarShare(shareId, path, options = {}) {
    state.shares.error = "";
    state.shares.notice = "";
    renderCalendarShareModal();
    try {
        const res = await trackCalendarMutation(fetch(path, {
            method: options.method || "POST",
            headers: { "Content-Type": "application/json" },
            body: options.body ? JSON.stringify(options.body) : undefined,
        }));
        const response = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(response.error || "Unable to update share link.");
        const share = response.share;
        if (share?.id) {
            const index = state.shares.items.findIndex((item) => item.id === share.id);
            if (index >= 0) state.shares.items.splice(index, 1, share);
            else state.shares.items.unshift(share);
        }
        state.shares.notice = options.notice || "Share link updated.";
    } catch (err) {
        state.shares.error = err.message || "Unable to update share link.";
    } finally {
        renderCalendarShareModal();
    }
}
async function copyTextToClipboard(value) {
    if (!value) return false;
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
}
function onCalendarShareModalChange(event) {
    if (event.target?.name === "include_scope" || event.target?.name === "date_scope") {
        syncCalendarShareModalFields();
    }
}
async function onCalendarShareModalSubmit(event) {
    if (event.target?.id !== "calendar-share-form") return;
    event.preventDefault();
    await saveCalendarSharePayload(calendarShareFormPayload(event.target));
}
async function onCalendarShareModalClick(event) {
    if (event.target === state.ui.shareModalEl || event.target.closest(".js-share-close")) {
        closeCalendarShareModal();
        return;
    }
    const newBtn = event.target.closest(".js-share-new");
    if (newBtn) {
        state.shares.editingId = null;
        state.shares.error = "";
        state.shares.notice = "";
        renderCalendarShareModal();
        return;
    }
    const copyBtn = event.target.closest(".js-share-copy");
    if (copyBtn) {
        const share = state.shares.items.find((item) => item.id === copyBtn.getAttribute("data-share-id"));
        if (!share?.shareUrl) return;
        await copyTextToClipboard(share.shareUrl);
        state.shares.notice = "Share link copied.";
        renderCalendarShareModal();
        return;
    }
    const editBtn = event.target.closest(".js-share-edit");
    if (editBtn) {
        state.shares.editingId = editBtn.getAttribute("data-share-id");
        state.shares.error = "";
        state.shares.notice = "";
        renderCalendarShareModal();
        return;
    }
    const regenerateBtn = event.target.closest(".js-share-regenerate");
    if (regenerateBtn) {
        const shareId = regenerateBtn.getAttribute("data-share-id");
        await updateCalendarShare(shareId, `/api/calendar/shares/${encodeURIComponent(shareId)}/regenerate`, { notice: "Share link regenerated." });
        return;
    }
    const revokeBtn = event.target.closest(".js-share-revoke");
    if (revokeBtn) {
        const shareId = revokeBtn.getAttribute("data-share-id");
        await updateCalendarShare(shareId, `/api/calendar/shares/${encodeURIComponent(shareId)}`, { method: "DELETE", notice: "Share link revoked." });
        return;
    }
    const activateBtn = event.target.closest(".js-share-activate");
    if (activateBtn) {
        const shareId = activateBtn.getAttribute("data-share-id");
        const share = state.shares.items.find((item) => item.id === shareId);
        await updateCalendarShare(shareId, `/api/calendar/shares/${encodeURIComponent(shareId)}`, {
            method: "PATCH",
            body: { ...share, isActive: true },
            notice: "Share link reactivated.",
        });
    }
}
/* ── Top-Level Render ──────────────────────────────────────────────────────── */
function render() {
    updateHeader();
    updateViewToggleButtons();
    renderCalendarMenu();
    renderCalendarView();
    renderAssignments();
    if (!state.public.readOnly) {
        renderCoursesModal();
    }
}
function renderCalendarMenu() {
    const container = document.getElementById("calendar-menu");
    if (!container) return;
    if (!state.ui.calendarMenuOpen) {
        container.style.display = "none";
        container.innerHTML = "";
        return;
    }
    container.innerHTML = buildCalendarMenuHtml();
    container.style.display = "block";
}
function updateHeader() {
    const title = document.getElementById("calendar-title");
    const subtitle = document.getElementById("calendar-subtitle");
    if (!title || !subtitle) return;
    const monthLabel = state.anchorDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (state.public.readOnly) {
        const periodLabel = state.view === "month"
            ? monthLabel
            : (() => {
                const start = getStartOfWeek(state.anchorDate);
                const end = new Date(start);
                end.setDate(end.getDate() + 6);
                return `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
            })();
        title.textContent = state.public.title || "Shared Calendar";
        subtitle.textContent = `${periodLabel} · ${state.public.rangeLabel || "Shared dates"}`;
        return;
    }
    if (state.view === "month") {
        title.textContent = monthLabel;
        subtitle.textContent = state.feedConfigured
            ? "Monthly view from your saved iCal feed"
            : "Monthly view (no .ics feed connected yet)";
        return;
    }
    const start = getStartOfWeek(state.anchorDate);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    title.textContent = `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    subtitle.textContent = state.feedConfigured
        ? `Weekly view (${monthLabel}) from your saved iCal feed`
        : `Weekly view (${monthLabel}) with no .ics feed connected`;
}
function updateViewToggleButtons() {
    const weekBtn = document.getElementById("calendar-view-week");
    const monthBtn = document.getElementById("calendar-view-month");
    if (!weekBtn || !monthBtn) return;
    const active = "inline-flex h-8 min-w-[84px] items-center justify-center rounded-md px-3 text-sm font-medium text-on-primary shadow-sm transition-colors";
    const inactive = "inline-flex h-8 min-w-[84px] items-center justify-center rounded-md bg-transparent px-3 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface";
    weekBtn.className = state.view === "week" ? active : inactive;
    monthBtn.className = state.view === "month" ? active : inactive;
    // Apply gradient background to the active button via inline style
    if (state.view === "week") {
        weekBtn.style.background = "linear-gradient(135deg, var(--color-primary), var(--color-primary-container))";
        monthBtn.style.background = "";
    } else {
        monthBtn.style.background = "linear-gradient(135deg, var(--color-primary), var(--color-primary-container))";
        weekBtn.style.background = "";
    }
    if (state.view !== "week") {
        state.ui.weeklyAutoScrollKey = null;
    }
}
function renderCalendarView() {
    const root = document.getElementById("calendar-view-root");
    if (!root) return;
    hideCalendarHoverCard();
    if (state.loadingDashboard) {
        root.innerHTML = `
            <div class="rounded-2xl border border-calendar-rule bg-surface-container shadow-2xl shadow-black/10 p-10 min-h-[420px] flex items-center justify-center">
                ${window.APStudyLoader.html("Loading calendar...", { sizePx: 54, textToneClass: "text-on-surface" })}
            </div>
        `;
        return;
    }
    const compactCalendar = isCompactCalendarViewport();
    root.innerHTML = compactCalendar ? buildMobileCalendarAgendaHtml() : (state.view === "month" ? buildMonthViewHtml() : buildWeekViewHtml());
    if (state.view === "week" && !compactCalendar) {
        applyWeekAutoScroll();
    }
}
function isCompactCalendarViewport() {
    return COMPACT_CALENDAR_QUERY.matches;
}
function buildMobileCalendarAgendaHtml() {
    const allDays = getMobileAgendaDays();
    const days = state.view === "month"
        ? allDays.filter((day) => getEventsForDay(day).length > 0 || isToday(day))
        : allDays;
    const visibleDays = days.length ? days : allDays.slice(0, 1);
    return `
        <div class="calendar-mobile-agenda" data-calendar-mobile-view="${escapeHtml(state.view)}">
            ${visibleDays.map((day) => renderMobileAgendaDay(day)).join("")}
        </div>
    `;
}
function getMobileAgendaDays() {
    if (state.view === "month") {
        const year = state.anchorDate.getFullYear();
        const month = state.anchorDate.getMonth();
        const monthEnd = new Date(year, month + 1, 0);
        return Array.from({ length: monthEnd.getDate() }, (_, index) => new Date(year, month, index + 1));
    }
    const weekStart = getStartOfWeek(state.anchorDate);
    return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(weekStart);
        day.setDate(weekStart.getDate() + index);
        return day;
    });
}
function renderMobileAgendaDay(day) {
    const dayEvents = getEventsForDay(day)
        .slice()
        .sort((a, b) => {
            if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
            return a.startDate - b.startDate || (a.title || "").localeCompare(b.title || "");
        });
    const dateLabel = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const todayClass = isToday(day) ? " is-today" : "";
    return `
        <section class="calendar-mobile-day${todayClass}">
            <header class="calendar-mobile-day-header">
                <span>${escapeHtml(dateLabel)}</span>
                <strong>${dayEvents.length}</strong>
            </header>
            <div class="calendar-mobile-event-list">
                ${dayEvents.length ? dayEvents.map(renderMobileAgendaEvent).join("") : '<p class="calendar-mobile-empty">No events</p>'}
            </div>
        </section>
    `;
}
function renderMobileAgendaEvent(event) {
    const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
    const calendarLabel = getEventCalendarLabel(event);
    const calendarColor = getEventCalendarColor(event);
    const completedClass = isTaskEvent(event) && event.completed ? " is-completed" : "";
    return `
        <article ${getEventElementAttributes(event)} class="calendar-mobile-event calendar-event-shell${completedClass}">
            <span class="calendar-mobile-event-bar" style="background-color:${escapeHtml(calendarColor)}"></span>
            <div class="calendar-mobile-event-copy">
                <h3>${isTaskEvent(event) && event.completed ? "✓ " : ""}${escapeHtml(event.title || "Untitled")}</h3>
                <p>${escapeHtml(timeDisplay)}</p>
                <small>${escapeHtml(calendarLabel)}</small>
            </div>
        </article>
    `;
}
function getWeekKeyFromAnchor(anchorDate) {
    const weekStart = getStartOfWeek(anchorDate);
    return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
}
function applyWeekAutoScroll() {
    const scroller = document.getElementById("calendar-week-time-scroller");
    if (!scroller) return;
    // Measure scrollbar width and set CSS variable so sticky headers align with the grid
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
    const calendarContainer = scroller.closest(".rounded-2xl");
    if (calendarContainer) {
        calendarContainer.style.setProperty("--scrollbar-offset", `${scrollbarWidth}px`);
    }
    const weekKey = getWeekKeyFromAnchor(state.anchorDate);
    if (state.ui.weeklyAutoScrollKey === weekKey) return;
    const targetMinutes = (7 * 60) + 30;
    const targetScrollTop = Math.round((targetMinutes / 60) * HOUR_HEIGHT_PX);
    scroller.scrollTop = targetScrollTop;
    state.ui.weeklyAutoScrollKey = weekKey;
}
/* ── Month View ────────────────────────────────────────────────────────────── */
function buildMonthViewHtml() {
    const year = state.anchorDate.getFullYear();
    const month = state.anchorDate.getMonth();
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const weeks = [];
    for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
        const weekStart = new Date(gridStart);
        weekStart.setDate(gridStart.getDate() + weekIndex * 7);
        const days = Array.from({ length: 7 }, (_, dayIndex) => {
            const day = new Date(weekStart);
            day.setDate(weekStart.getDate() + dayIndex);
            return day;
        });
        const { events: allDayEvents, rowsCount } = getAllDayEventsForMonthWeek(days);
        const allDayRowCount = rowsCount || 0;
        const gridEndLine = allDayRowCount + 3;
        const occupiedAllDayRowsByDay = days.map((_, dayIndex) => {
            return allDayEvents.reduce((max, event) => {
                const start = event.gridColStart;
                const end = event.gridColStart + event.gridSpan - 1;
                if (dayIndex < start || dayIndex > end) return max;
                return Math.max(max, (event.rowIndex || 0) + 1);
            }, 0);
        });
        const rowTemplate = allDayRowCount > 0
            ? `2.75rem repeat(${allDayRowCount}, 1.65rem) minmax(3.25rem, 1fr)`
            : "2.75rem minmax(4.9rem, 1fr)";
        const rowMinHeight = Math.max(120, 96 + allDayRowCount * 26);
        const dayCells = days.map((day, dayIndex) => {
            const inMonth = day >= monthStart && day <= monthEnd;
            const bgClass = inMonth ? "bg-surface-container" : "opacity-70";
            const backgroundStyle = inMonth ? "" : "background:color-mix(in srgb, var(--color-surface-container) 40%, transparent);";
            return `
                <div
                    data-date="${formatDateKey(day)}"
                    class="calendar-month-day-cell ${dayIndex === 6 ? "calendar-month-day-cell-edge" : ""} ${bgClass} border-r border-b border-calendar-rule ${dayIndex === 6 ? "border-r-0" : ""}"
                    style="grid-column:${dayIndex + 1}; grid-row:1 / ${gridEndLine}; ${backgroundStyle}"
                ></div>
            `;
        }).join("");
        const dayNumbers = days.map((day, dayIndex) => {
            const isCurrentDay = isToday(day);
            const todayMarkerClass = isCurrentDay ? "calendar-today-marker calendar-today-marker-month" : "";
            const todayTextClass = isCurrentDay ? "text-red-500 font-bold" : "text-on-surface-variant";
            return `
                <div class="calendar-month-day-number-slot relative" style="grid-column:${dayIndex + 1}; grid-row:1; z-index:10;">
                    <div class="calendar-month-day-number inline-flex items-center justify-center text-xs font-semibold ${todayTextClass} ${todayMarkerClass}">
                        ${escapeHtml(formatMonthGridDayLabel(day))}
                    </div>
                </div>
            `;
        }).join("");
        const allDayBars = allDayEvents.map((event) => renderMonthAllDayEvent(event)).join("");
        const timedEventColumns = days.map((day, dayIndex) => {
            const dayEvents = getEventsForDay(day).filter((event) => !event.isAllDay);
            const dayTimedRowStart = (occupiedAllDayRowsByDay[dayIndex] || 0) + 2;
            return `
                <div class="relative px-1 pb-2.5 space-y-1" style="grid-column:${dayIndex + 1}; grid-row:${dayTimedRowStart} / ${gridEndLine}; z-index:10;">
                    ${dayEvents.slice(0, 3).map((e) => buildEventChip(e, { monthView: true })).join("")}
                    ${dayEvents.length > 3 ? `<div class="text-[10px] text-on-surface-variant">+${dayEvents.length - 3} more</div>` : ""}
                </div>
            `;
        }).join("");
        weeks.push(`
            <div class="grid relative" style="grid-template-columns:repeat(7, minmax(0, 1fr)); grid-template-rows:${rowTemplate}; min-height:${rowMinHeight}px;">
                ${dayCells}
                ${dayNumbers}
                ${allDayBars}
                ${timedEventColumns}
            </div>
        `);
    }
    return `
        <div class="calendar-month-header grid grid-cols-7 border-l border-t border-r border-calendar-rule bg-surface-container-low" style="border-top-left-radius:1rem; border-top-right-radius:1rem;">
            ${WEEKDAYS.map((d, index) => `<div class="calendar-month-header-cell ${index === 6 ? "calendar-month-header-cell-edge" : ""} text-[11px] uppercase tracking-[0.05em] text-center text-on-surface-variant font-semibold py-2 border-r border-b border-calendar-rule ${index === 6 ? "border-r-0" : ""}">${d}</div>`).join("")}
        </div>
        <div class="calendar-month-grid border-l border-r border-calendar-rule shadow-2xl shadow-black/10" style="border-bottom-left-radius:1rem; border-bottom-right-radius:1rem;">
            ${weeks.join("")}
        </div>
    `;
}
function getAllDayEventsForMonthWeek(days) {
    const weekStart = new Date(days[0].getFullYear(), days[0].getMonth(), days[0].getDate());
    const weekEndExclusive = new Date(days[6].getFullYear(), days[6].getMonth(), days[6].getDate() + 1);
    const seen = new Set();
    const candidates = [];
    for (const event of getVisibleEvents()) {
        if (!event.isAllDay) continue;
        const eStart = new Date(event.startDate.getFullYear(), event.startDate.getMonth(), event.startDate.getDate());
        const rawEnd = event.endDate && event.endDate > event.startDate
            ? new Date(event.endDate.getFullYear(), event.endDate.getMonth(), event.endDate.getDate())
            : new Date(event.startDate.getFullYear(), event.startDate.getMonth(), event.startDate.getDate() + 1);
        const eEnd = rawEnd > eStart ? rawEnd : new Date(eStart.getFullYear(), eStart.getMonth(), eStart.getDate() + 1);
        if (eStart >= weekEndExclusive || eEnd <= weekStart) continue;
        const key = event.uid || `${event.title}|${event.startDate.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const lastVisibleDay = new Date(eEnd);
        lastVisibleDay.setDate(lastVisibleDay.getDate() - 1);
        const clampedStart = Math.max(0, dateToDayIndex(eStart, days));
        const clampedEnd = Math.min(6, dateToDayIndex(lastVisibleDay, days));
        const span = clampedEnd - clampedStart + 1;
        if (span <= 0) continue;
        candidates.push({
            ...event,
            gridColStart: clampedStart,
            gridSpan: span,
            continuesFromPreviousWeek: eStart < weekStart,
            continuesToNextWeek: eEnd > weekEndExclusive,
        });
    }
    packAllDayEvents(candidates);
    const rowsCount = candidates.reduce((max, event) => Math.max(max, (event.rowIndex || 0) + 1), 0);
    return {
        events: candidates.sort((a, b) => (a.rowIndex - b.rowIndex) || (a.gridColStart - b.gridColStart)),
        rowsCount,
    };
}
function packAllDayEvents(events) {
    events.sort((a, b) => a.gridColStart - b.gridColStart || b.gridSpan - a.gridSpan || (a.title || "").localeCompare(b.title || ""));
    const occupancy = [];
    for (const event of events) {
        let placed = false;
        for (let row = 0; row < occupancy.length; row++) {
            let canFit = true;
            for (let col = event.gridColStart; col < event.gridColStart + event.gridSpan; col++) {
                if (occupancy[row][col]) {
                    canFit = false;
                    break;
                }
            }
            if (!canFit) continue;
            for (let col = event.gridColStart; col < event.gridColStart + event.gridSpan; col++) occupancy[row][col] = true;
            event.rowIndex = row;
            placed = true;
            break;
        }
        if (placed) continue;
        const newRow = Array(7).fill(false);
        for (let col = event.gridColStart; col < event.gridColStart + event.gridSpan; col++) newRow[col] = true;
        occupancy.push(newRow);
        event.rowIndex = occupancy.length - 1;
    }
}
function getEventElementAttributes(event) {
    const dataId = event.id || event.uid || "";
    const eventRef = getCalendarEventRef(event) || dataId;
    const sourceType = event.source_type || event.source || (event.id ? "user" : "feed");
    const taskId = event.task_id ? ` data-task-id="${escapeHtml(event.task_id)}"` : "";
    return `data-event-id="${escapeHtml(dataId)}" data-event-ref="${escapeHtml(eventRef)}" data-event-source="${escapeHtml(sourceType)}"${taskId} tabindex="0"`;
}
function renderMonthAllDayEvent(event) {
    const badgeStyle = getEventBadgeStyle(event);
    const colStart = event.gridColStart + 1;
    const colEnd = colStart + event.gridSpan;
    const row = (event.rowIndex || 0) + 2;
    const radiusStyle = `border-top-left-radius:${event.continuesFromPreviousWeek ? "0" : "0.375rem"}; border-bottom-left-radius:${event.continuesFromPreviousWeek ? "0" : "0.375rem"}; border-top-right-radius:${event.continuesToNextWeek ? "0" : "0.375rem"}; border-bottom-right-radius:${event.continuesToNextWeek ? "0" : "0.375rem"};`;
    const padLeft = event.continuesFromPreviousWeek ? "0" : "0.25rem";
    const padRight = event.continuesToNextWeek ? "0" : "0.25rem";
    return `
        <div ${getEventElementAttributes(event)} class="calendar-event-shell relative" style="grid-column:${colStart} / ${colEnd}; grid-row:${row}; z-index:20; padding-left:${padLeft}; padding-right:${padRight};">
            <div class="text-[11px] px-2 py-1 border truncate leading-none" style="${badgeStyle}; ${radiusStyle}">
                ${escapeHtml(event.title || "Untitled")}
            </div>
        </div>
    `;
}
/* ── Week View ─────────────────────────────────────────────────────────────── */
function buildWeekViewHtml() {
    const weekStart = getStartOfWeek(state.anchorDate);
    const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + i);
        return d;
    });
    const weekEnd = new Date(days[6]);
    weekEnd.setHours(23, 59, 59, 999);
    const { events: allDayEvents, rowsCount: allDayRowsCount } = getAllDayEventsForWeek(days, weekStart, weekEnd);
    const hasAllDayEvents = allDayEvents.length > 0;
    const timedByDay = days.map((d) => getEventsForDay(d).filter((e) => !e.isAllDay));
    const totalHours = 24;
    const timeGridHeight = totalHours * HOUR_HEIGHT_PX;
    const dayColTemplate = `minmax(${WEEK_MINIMUM_DAY_WIDTH_PX}px, 1fr)`;
    const gridCols = `4.75rem repeat(7, ${dayColTemplate})`;
    const dayHeaders = days.map((day, i) => {
        const dateLabel = `${day.getMonth() + 1}/${day.getDate()}`;
        const isCurrentDay = isToday(day);
        const todayMarkerClass = isCurrentDay ? "calendar-today-marker calendar-today-marker-week" : "";
        const dayNameClass = isCurrentDay ? "text-red-500" : "text-on-surface-variant";
        const dateNumClass = isCurrentDay ? "text-red-500 font-bold" : "text-on-surface";
        return `
            <div class="px-3 py-3 text-center border-r border-calendar-rule last:border-r-0 flex items-center justify-center">
                <div class="inline-flex flex-col items-center justify-center gap-0.5 ${todayMarkerClass}">
                    <div class="text-[11px] uppercase tracking-[0.05em] font-semibold ${dayNameClass}">${WEEKDAYS[i]}</div>
                    <div class="inline-flex h-7 w-7 items-center justify-center text-sm font-semibold ${dateNumClass}">
                        ${dateLabel}
                    </div>
                </div>
            </div>
        `;
    }).join("");
    const allDayRowCount = Math.max(1, allDayRowsCount || 0);
    const allDayRowHeight = Math.max(ALL_DAY_MIN_HEIGHT_PX, allDayRowCount * 28 + 16);
    const allDayChips = allDayEvents.map((ev) => {
        const badgeStyle = getEventBadgeStyle(ev);
        const colStart = ev.gridColStart + 2;
        const colEnd = colStart + ev.gridSpan;
        const row = typeof ev.rowIndex === "number" ? ev.rowIndex + 1 : 1;
        return `
            <div ${getEventElementAttributes(ev)} class="calendar-event-shell relative" style="grid-column: ${colStart} / ${colEnd}; grid-row: ${row};">
                <div class="text-[10px] px-2 py-1 rounded-md border truncate" style="${badgeStyle}">
                    ${escapeHtml(ev.title || "Untitled")}
                </div>
            </div>
        `;
    }).join("");
    const timeAxisCells = [];
    for (let h = 0; h < 24; h++) {
        timeAxisCells.push(`
            <div class="border-b border-calendar-rule relative" style="height:${HOUR_HEIGHT_PX}px;">
                <span class="absolute right-2 top-0 -translate-y-1/2 text-[11px] text-on-surface-variant font-medium leading-none whitespace-nowrap">${formatHourLabel(h)}</span>
            </div>
        `);
    }
    const dayColumns = days.map((day, idx) => {
        const positioned = layoutTimedEvents(timedByDay[idx]);
        const todayBg = isToday(day) ? "bg-primary/[0.03]" : "";
        const gridLines = [];
        for (let h = 0; h < 24; h++) {
            const timeLabel = `${String(h).padStart(2, "0")}:00`;
            gridLines.push(`<div data-time="${timeLabel}" class="border-b border-calendar-rule" style="height:${HOUR_HEIGHT_PX}px;"></div>`);
        }
        const eventChips = positioned.map((e) => renderTimedEvent(e)).join("");
        return `
            <div data-date="${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}" class="relative border-r border-calendar-rule last:border-r-0 ${todayBg} overflow-visible">
                <div class="absolute inset-0 pointer-events-none">
                    ${gridLines.join("")}
                </div>
                <div class="relative" style="height:${timeGridHeight}px;">
                    ${eventChips}
                </div>
            </div>
        `;
    }).join("");
    return `
        <div class="rounded-2xl border border-calendar-rule bg-transparent shadow-2xl shadow-black/10 overflow-hidden">
            <div class="grid border-b border-calendar-rule bg-surface-container-low sticky top-0 z-30" style="grid-template-columns: ${gridCols}; column-gap: 0.1rem; padding-right: var(--scrollbar-offset, 0px);">
                <div class="px-3 py-3 border-r border-calendar-rule"></div>
                ${dayHeaders}
            </div>
            ${hasAllDayEvents ? `
            <div class="grid border-b border-calendar-rule bg-surface-container-low sticky top-[3.75rem] z-20 items-start gap-y-1 px-1 py-0.5" style="grid-template-columns: ${gridCols}; column-gap: 0.1rem; padding-right: var(--scrollbar-offset, 0px);">
                <div class="px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-on-surface-variant font-semibold border-r border-calendar-rule flex items-start justify-end" style="grid-row: 1 / span ${allDayRowCount};">All day</div>
                ${allDayChips}
            </div>
            ` : ""}
            <div id="calendar-week-time-scroller" class="overflow-y-scroll overflow-x-auto" style="max-height:760px;">
                <div class="grid" style="grid-template-columns: ${gridCols}; column-gap: 0.1rem; min-width: calc(4.75rem + 7 * ${WEEK_MINIMUM_DAY_WIDTH_PX}px);">
                    <div class="border-r border-calendar-rule bg-surface-container-low overflow-visible pt-[0.35rem] pb-[0.35rem]">
                        ${timeAxisCells.join("")}
                    </div>
                    ${dayColumns}
                </div>
            </div>
        </div>
    `;
}
/* ── All-Day Event Collection for Week View ────────────────────────────────── */
function getAllDayEventsForWeek(days, weekStart, weekEnd) {
    const seen = new Set();
    const candidates = [];
    for (const event of getVisibleEvents()) {
        if (!event.isAllDay) continue;
        const eStart = event.startDate;
        const eEnd = event.endDate || event.startDate;
        if (eStart > weekEnd || eEnd < weekStart) continue;
        const key = event.uid || `${event.title}|${eStart.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Use local date methods since all-day dates are stored as local midnight
        const eventStartDay = dateToDayIndex(eStart, days);
        // iCal DTEND for all-day is exclusive, so subtract 1 day for the last visible day
        const lastVisibleDay = new Date(eEnd);
        lastVisibleDay.setDate(lastVisibleDay.getDate() - 1);
        const eventEndDay = dateToDayIndex(lastVisibleDay, days);
        const clampedStart = Math.max(0, eventStartDay);
        const clampedEnd = Math.min(6, eventEndDay);
        const span = clampedEnd - clampedStart + 1;
        if (span <= 0) continue;
        candidates.push({
            ...event,
            gridColStart: clampedStart,
            gridSpan: span,
        });
    }

    // Pack events into the earliest row that can fit them to avoid leaving holes.
    // Sort by start column asc, span desc to prefer left-aligned placement.
    candidates.sort((a, b) => a.gridColStart - b.gridColStart || b.gridSpan - a.gridSpan || (a.title || "").localeCompare(b.title || ""));

    const occupancy = []; // array of rows, each row is an array[7] booleans
    for (const ev of candidates) {
        let placed = false;
        for (let r = 0; r < occupancy.length; r++) {
            let ok = true;
            for (let c = ev.gridColStart; c < ev.gridColStart + ev.gridSpan; c++) {
                if (occupancy[r][c]) { ok = false; break; }
            }
            if (ok) {
                for (let c = ev.gridColStart; c < ev.gridColStart + ev.gridSpan; c++) occupancy[r][c] = true;
                ev.rowIndex = r;
                placed = true;
                break;
            }
        }
        if (!placed) {
            const newRow = Array(7).fill(false);
            for (let c = ev.gridColStart; c < ev.gridColStart + ev.gridSpan; c++) newRow[c] = true;
            occupancy.push(newRow);
            ev.rowIndex = occupancy.length - 1;
        }
    }

    const results = candidates.sort((a, b) => (a.rowIndex - b.rowIndex) || (a.gridColStart - b.gridColStart));
    const rowsCount = occupancy.length || 0;
    return { events: results, rowsCount };
}
/**
* Returns the 0-6 day-column index for a date relative to the week.
* Uses local date components since all-day events are parsed as local midnight
* and timed events are already converted to local by the Date constructor.
*/
/* ── Timed Event Rendering (week view) ─────────────────────────────────────── */
function renderTimedEvent(event) {
    const topPx = (event.layoutStartMinutes / 60) * HOUR_HEIGHT_PX;
    const heightPx = Math.max((event.layoutDurationMinutes / 60) * HOUR_HEIGHT_PX, 22);
    const leftPct = (event.layoutLane / event.layoutLaneCount) * 100;
    const widthPct = 100 / event.layoutLaneCount;
    const badgeStyle = getEventBadgeStyle(event);
    const isTask = isTaskEvent(event);
    const taskClasses = isTask ? ` ${event.completed ? "opacity-65" : ""}` : "";
    const priorityLabel = isTask && event.priority && event.priority !== "none" ? event.priority : "";
    return `
        <div ${getEventElementAttributes(event)} class="calendar-event-shell absolute px-0.5${taskClasses}" style="top:${topPx}px; left:${leftPct}%; width:calc(${widthPct}% - 0.25rem); height:${heightPx}px; z-index: 10;">
            <div class="h-full rounded-lg border overflow-hidden shadow-lg shadow-black/10" style="${badgeStyle}">
                <div class="h-full px-2 py-1.5 flex flex-col gap-0.5 text-left">
                    <div class="text-[11px] font-semibold leading-tight line-clamp-2">${isTask && event.completed ? "✓ " : ""}${escapeHtml(event.title || "Untitled")}</div>
                    <div class="text-[10px]">${priorityLabel ? `${escapeHtml(priorityLabel)} · ` : ""}${escapeHtml(formatTimeOnly(event.startDate))}</div>
                </div>
            </div>
        </div>
    `;
}
/* ── Event Chip (month + all-day row) ──────────────────────────────────────── */
function buildEventChip(event, options = {}) {
    const sizeClass = options.compact ? "text-[10px] px-2 py-1" : "text-[11px] px-2 py-1";
    const badgeStyle = getEventBadgeStyle(event);
    const badgeColors = getEventBadgeColors(event);
    const calendarColor = getEventCalendarColor(event);
    const isMonthTimedChip = Boolean(options.monthView) && !event.isAllDay;
    if (isMonthTimedChip) {
        const taskLabel = isTaskEvent(event) && event.priority && event.priority !== "none" ? event.priority.slice(0, 1).toUpperCase() : "";
        const completedClass = isTaskEvent(event) && event.completed ? " opacity-65" : "";
        return `
            <div ${getEventElementAttributes(event)} class="calendar-event-shell relative${completedClass}">
                <div class="${sizeClass} rounded-md border bg-surface-container-high/50 truncate flex items-center gap-2" style="border-color: ${badgeColors.border};">
                    <span class="inline-block h-4 w-1 rounded-full shrink-0" style="background-color: ${calendarColor};"></span>
                    ${taskLabel ? `<span class="text-[9px] font-bold uppercase" style="color:${badgeColors.text};">${escapeHtml(taskLabel)}</span>` : ""}
                    <span class="truncate text-on-surface font-medium">${isTaskEvent(event) && event.completed ? "✓ " : ""}${escapeHtml(event.title || "Untitled")}</span>
                </div>
            </div>
        `;
    }
    return `
        <div ${getEventElementAttributes(event)} class="calendar-event-shell relative">
            <div class="${sizeClass} rounded-md border truncate" style="${badgeStyle}">
                ${escapeHtml(event.title || "Untitled")}
            </div>
        </div>
    `;
}
/* ── Upcoming Events Section ───────────────────────────────────────────────── */
function renderAssignments() {
    const root = document.getElementById("assignments-root");
    if (!root) return;
    if (state.loadingDashboard) {
        root.innerHTML = `
            <div class="md:col-span-2 lg:col-span-3 rounded-xl border border-outline-variant/20 bg-surface-container p-10 text-center">
                ${window.APStudyLoader.html("Loading upcoming events...", { sizePx: 46, textToneClass: "text-on-surface" })}
            </div>
        `;
        return;
    }
    const now = new Date();
    const upcoming = getVisibleEvents()
        .filter((e) => e.source !== "simulated")
        .filter((e) => e.endDate >= now || e.startDate >= now)
        .slice(0, 12);
    if (!upcoming.length) {
        root.innerHTML = `
            <div class="md:col-span-2 lg:col-span-3 rounded-xl border border-outline-variant/20 bg-surface-container p-6 text-sm text-on-surface-variant">
                No upcoming events found yet. Your calendar is still available above.
            </div>
        `;
        return;
    }
    root.innerHTML = upcoming.map((event, index) => {
        const eventRef = getUpcomingEventRef(event);
        const urgency = event.isAllDay ? getUrgencyLabelAllDay(event) : getUrgencyLabel(event.startDate);
        const accent = getAccent(event.type, event.startDate);
        const calendarColor = getEventCalendarColor(event);
        const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
        const calendarLabel = getEventCalendarLabel(event);
        const description = String(event.description || "").trim();
        const isExpanded = state.ui.expandedUpcomingRefs.has(eventRef);
        const descriptionId = `upcoming-event-description-${index}`;
        const canExpand = description.length > 140 || description.split(/\r\n|\r|\n/).length > 2;
        const descriptionClampClass = canExpand && !isExpanded ? "line-clamp-3" : "";
        const descriptionHtml = description
            ? `
                <div id="${descriptionId}" class="text-sm text-on-surface-variant leading-relaxed break-words ${descriptionClampClass}">
                    ${formatMultilineText(description)}
                </div>
                ${canExpand ? `
                    <button type="button" class="js-upcoming-toggle calendar-upcoming-toggle" data-event-ref="${escapeHtml(eventRef)}" aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="${descriptionId}">
                        ${isExpanded ? "Show less" : "Show more"}
                    </button>
                ` : ""}
            `
            : "";
        return `
            <article class="bg-surface-container hover:bg-surface-container-high transition-all duration-300 rounded-xl p-5 sm:p-6 relative overflow-hidden flex flex-col gap-4">
                <div class="absolute left-0 top-0 bottom-0 w-1 ${accent.bar}"></div>
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <span class="text-[11px] uppercase tracking-[0.05em] font-bold px-2.5 py-1 rounded-md ${accent.tag}">${escapeHtml(urgency)}</span>
                    <span class="text-sm text-on-surface-variant text-right">${escapeHtml(timeDisplay)}</span>
                </div>
                <div class="space-y-2">
                    <h3 class="text-lg font-headline font-semibold text-on-surface leading-snug">${escapeHtml(event.title || "Untitled")}</h3>
                    <div class="flex items-center gap-2 text-sm text-on-surface-variant">
                        <span class="h-2.5 w-2.5 rounded-full shrink-0" style="background-color:${calendarColor};"></span>
                        <span class="truncate">${escapeHtml(calendarLabel)}</span>
                    </div>
                </div>
                ${descriptionHtml}
            </article>
        `;
    }).join("");
}
function getUpcomingEventRef(event) {
    return getCalendarEventRef(event) || event.id || event.uid || `${event.title || "event"}|${event.startDate?.getTime?.() || ""}`;
}
/* ── Event Query Helpers ───────────────────────────────────────────────────── */
function getEventsForDay(date) {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return getVisibleEvents().filter((e) => {
        const eStart = e.startDate;
        const eEnd = e.endDate || e.startDate;
        if (e.isAllDay) {
            // All-day events: DTEND is exclusive.
            // An event on Apr 24 has start=Apr 24 00:00, end=Apr 25 00:00.
            // It should appear on Apr 24 only, not Apr 25.
            // Use date-only comparison: event overlaps day if
            // eventStart < dayEnd (exclusive) AND eventEnd > dayStart (exclusive)
            const eventStartDay = new Date(eStart.getFullYear(), eStart.getMonth(), eStart.getDate());
            const eventEndDay = new Date(eEnd.getFullYear(), eEnd.getMonth(), eEnd.getDate());
            const thisDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const nextDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
            // Event occupies [eventStartDay, eventEndDay) since DTEND is exclusive
            return eventStartDay < nextDayStart && eventEndDay > thisDayStart;
        }
        // Timed events: inclusive overlap check
        return eStart <= dayEnd && eEnd >= dayStart;
    });
}
function getEventBadgeStyle(event) {
    const colors = getEventBadgeColors(event);
    return `background-color: ${colors.background}; color: ${colors.text}; border: 1px solid ${colors.border};`;
}
function getEventBadgeColors(event) {
    if (isTaskEvent(event)) {
        if (event.completed) {
            const muted = document.documentElement.classList.contains("dark") ? "#94a3b8" : "#64748b";
            return {
                background: hexToRgba(muted, document.documentElement.classList.contains("dark") ? 0.18 : 0.12),
                text: muted,
                border: hexToRgba(muted, 0.34),
            };
        }
        const priorityColor = getTaskPriorityColor(event.priority);
        const isDarkTask = document.documentElement.classList.contains("dark");
        return {
            background: hexToRgba(priorityColor, isDarkTask ? 0.24 : 0.13),
            text: adjustHexLuminance(priorityColor, isDarkTask ? 0.28 : -0.22),
            border: hexToRgba(priorityColor, isDarkTask ? 0.5 : 0.36),
        };
    }
    const color = getEventCalendarColor(event);
    const isDark = document.documentElement.classList.contains("dark");
    const textColor = adjustHexLuminance(color, isDark ? 0.34 : -0.30);
    const bgAlpha = isDark ? 0.24 : 0.13;
    const borderAlpha = isDark ? 0.48 : 0.34;
    return {
        background: hexToRgba(color, bgAlpha),
        text: textColor,
        border: hexToRgba(color, borderAlpha),
    };
}
