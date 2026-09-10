/* ──────────────────────────────────────────────────────────────────────────────
   Dashboard Calendar & Assignments
   ──────────────────────────────────────────────────────────────────────────── */
/* ── Constants ─────────────────────────────────────────────────────────────── */
import { createCalendarLifecycle } from "./lifecycle.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import { normalizeCalendarCapabilities } from "./capabilities.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import { createCalendarExtensionUi } from "./extension-ui.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";

export function mountCalendar(root, dataAdapter, capabilities = {}) {
    if (!root || root.nodeType !== 1) return () => {};

    const doc = root.ownerDocument;
    if (!doc) return () => {};
    const view = capabilities.view || doc.defaultView || globalThis;
    const runtimeWindow = capabilities.window || view;
    const window = runtimeWindow;
    const pageRoot = capabilities.pageRoot?.nodeType === 1 ? capabilities.pageRoot : root;
    const body = doc.body;
    const extensionMount = capabilities.mode === "overlay" || capabilities.mode === "replace";
    if (extensionMount) {
        root.classList.add("apstudy-calendar-host");
        root.innerHTML = `<header class="apstudy-calendar-toolbar">
            <div><h2 id="calendar-title">Calendar</h2><p id="calendar-subtitle"></p></div>
            <nav aria-label="Calendar view"><button id="calendar-view-month" type="button">Month</button><button id="calendar-view-week" type="button">Week</button><button id="calendar-view-upcoming" type="button">Agenda</button></nav>
            <div id="calendar-period-controls"><button id="calendar-prev" type="button" aria-label="Previous period">Previous</button><button id="calendar-today" type="button">Today</button><button id="calendar-next" type="button" aria-label="Next period">Next</button></div>
            <button id="calendar-toggle-menu" type="button" aria-expanded="false">Calendars</button><button id="calendar-refresh" type="button">Refresh</button><button id="calendar-new-event" type="button">New event</button>
        </header><div id="calendar-menu" class="hidden"></div><div id="calendar-view-root" aria-live="polite"></div><div id="calendar-popover-root"></div>`;
    }
    const canvasPageReadOnly = body?.dataset.calendarReadonly === "true";
    const calendarCapabilities = normalizeCalendarCapabilities({
        ...capabilities,
        readOnly: canvasPageReadOnly || capabilities.readOnly === true,
        shareMode: canvasPageReadOnly || capabilities.shareMode === true,
    });
    const lifecycle = capabilities.lifecycle
        || createCalendarLifecycle({ view });
    const adapter = dataAdapter || capabilities.dataAdapter || {};
    let disposed = false;
    const previousCalendarDataAdapter = window.APStudyCalendarDataAdapter;
    window.APStudyCalendarDataAdapter = adapter;

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
const DEFAULT_DASHBOARD_VIEW = body?.dataset.defaultDashboardView === "month" ? "month" : "week";
const EVENTS_CACHE_KEY = "calendarEventsCache";
const DEFAULT_CALENDAR_BUFFER_DAYS = 7;
const CALENDAR_BUFFER_DAYS = Number.isFinite(
    Number.parseInt(body?.dataset.calendarBufferDays, 10)
)
    ? Number.parseInt(body?.dataset.calendarBufferDays, 10)
    : DEFAULT_CALENDAR_BUFFER_DAYS;
const CALENDAR_READ_ONLY = canvasPageReadOnly;
const PUBLIC_SHARE_CODE = body?.dataset.publicShareCode || "";
const PUBLIC_CALENDAR_TITLE = body?.dataset.publicCalendarTitle || "Shared Calendar";
const PUBLIC_CALENDAR_RANGE_LABEL = body?.dataset.publicCalendarRangeLabel || "Shared dates";
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
    createAccessibleEventPalette,
    getCssColorVariable,
    escapeHtml,
    formatMultilineText,
} = window.APStudyCalendarUtils;
const state = window.APStudyCalendarState.createCalendarState({
    defaultDashboardView: DEFAULT_DASHBOARD_VIEW,
    publicCalendarRangeLabel: PUBLIC_CALENDAR_RANGE_LABEL,
    publicCalendarTitle: PUBLIC_CALENDAR_TITLE,
    publicShareCode: PUBLIC_SHARE_CODE,
    readOnly: calendarCapabilities.readOnly,
});
if (extensionMount) {
    state.public.title = "Calendar";
    state.public.rangeLabel = "Read-only";
    if (window.APStudyDate?.toCalendarDate) state.anchorDate = window.APStudyDate.toCalendarDate(new Date());
}
const calendarCore = window.APStudyCalendarCore.createCalendarCore({
    authenticatedReadOnly: extensionMount,
    state,
    constants: {
        defaultLocalCalendarId: DEFAULT_LOCAL_CALENDAR_ID,
        defaultLocalCalendarName: DEFAULT_LOCAL_CALENDAR_NAME,
        localSourcePrefix: LOCAL_SOURCE_PREFIX,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
    },
    callbacks: {
        buildSimulatedMeetingEvents: (...args) => buildSimulatedMeetingEvents(...args),
        getCurrentViewCountRange: () => getCurrentViewCountRange(),
    },
});
const {
    getCalendarEventByRef,
    getCalendarEventRef,
    getCalendarLabel,
    getCalendarOptionsForEventForm,
    getDefaultCalendarIdForEventForm,
    getEventCalendarKey,
    getEventCalendarLabel,
    getSavedCalendarInfo,
    initCalendarState,
    isLocalCalendar,
} = calendarCore;
const calendarMenu = window.APStudyCalendarMenu.createCalendarMenu({
    authenticatedReadOnly: extensionMount,
    root: pageRoot,
    state,
    constants: {
        canvasCalendarName: CANVAS_CALENDAR_NAME,
        canvasSourceId: CANVAS_SOURCE_ID,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
        taskCalendarId: TASK_CALENDAR_ID,
        taskCalendarName: TASK_CALENDAR_NAME,
    },
    callbacks: {
        buildSimulatedMeetingEvents: (...args) => buildSimulatedMeetingEvents(...args),
        getCalendarLabel,
        getEventCalendarKey,
        getStartOfWeek,
    },
    escapeHtml,
});
const {
    getCalendarEventCount,
    getCalendarLabelFromData,
    getCurrentViewCountRange,
    renderCalendarMenu,
} = calendarMenu;
const calendarRenderShell = window.APStudyCalendarRenderShell.createCalendarRenderShell({
    root: pageRoot,
    state,
    constants: {
        compactCalendarQuery: COMPACT_CALENDAR_QUERY,
        hourHeightPx: HOUR_HEIGHT_PX,
    },
    callbacks: {
        buildMobileCalendarAgendaHtml: () => buildMobileCalendarAgendaHtml(),
        buildUpcomingAgendaHtml: () => buildUpcomingAgendaHtml(),
        buildMonthViewHtml: () => buildMonthViewHtml(),
        buildWeekViewHtml: () => buildWeekViewHtml(),
        getStartOfWeek,
        hideCalendarHoverCard: () => hideCalendarHoverCard(),
        renderAssignments: () => renderAssignments(),
        renderCalendarMenu,
        renderCoursesModal: () => renderCoursesModal(),
    },
});
const {
    isCompactCalendarViewport,
    render: renderCalendarShell,
    renderCalendarView,
} = calendarRenderShell;
const calendarExtensionUi = createCalendarExtensionUi({
    root: pageRoot,
    state,
    adapter,
    capabilities: calendarCapabilities,
    lifecycle,
});
const render = (...args) => {
    renderCalendarShell(...args);
    calendarExtensionUi.render();
};
const calendarPreferences = window.APStudyCalendarPreferences.createCalendarPreferences({
    strictLoad: extensionMount,
    authenticatedReadOnly: extensionMount,
    lifecycle,
    dataAdapter: adapter,
    state,
    constants: {
        batchEndpoint: PREFERENCE_BATCH_ENDPOINT,
        batchLimit: PREFERENCE_BATCH_LIMIT,
        loadRetryCooldownMs: PREFERENCE_LOAD_RETRY_COOLDOWN_MS,
        preferenceSaveDelayMs: PREFERENCE_SAVE_DELAY_MS,
        preferenceSaveRetryDelaysMs: PREFERENCE_SAVE_RETRY_DELAYS_MS,
        preferenceSaveTimeoutMs: PREFERENCE_SAVE_TIMEOUT_MS,
        preferenceSaveWarningCooldownMs: PREFERENCE_SAVE_WARNING_COOLDOWN_MS,
    },
    getSavedCalendarInfo,
    renderCalendarMenu,
});
const {
    ensureCalendarPreferencesLoaded,
    invalidateCalendarPreferencesCache,
    loadCalendarState,
    queueCalendarPreferenceSave,
    saveCalendarState,
    scheduleCalendarPreferenceFlush,
    trackCalendarMutation,
    writeCalendarStateToStorage,
} = calendarPreferences;
const calendarCourses = window.APStudyCalendarCourses.createCalendarCourses({
    root: pageRoot,
    lifecycle,
    dataAdapter: adapter,
    state,
    strictLoad: extensionMount,
    authenticatedReadOnly: extensionMount,
    serverSelections: extensionMount,
    remoteResults: extensionMount,
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
    hydrateSavedCourses,
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
    strictLoad: extensionMount,
    authenticatedReadOnly: extensionMount,
    lifecycle,
    dataAdapter: adapter,
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
const calendarEventRender = window.APStudyCalendarEventRender.createCalendarEventRender({
    state,
    callbacks: {
        getCalendarEventColor: getEventCalendarColor,
        getCalendarEventRef,
        getEventCalendarLabel,
        getVisibleEvents,
    },
    formatters: {
        createAccessibleEventPalette,
        escapeHtml,
        formatAllDayRange,
        formatTimedEventRange,
        getCssColorVariable,
        getTaskPriorityColor,
        isTaskEvent,
    },
});
const {
    getEventBadgeColors,
    getEventBadgeStyle,
    getEventElementAttributes,
    getEventsForDay,
} = calendarEventRender;
const calendarShare = window.APStudyCalendarShare.createCalendarShare({
    root: pageRoot,
    lifecycle,
    dataAdapter: adapter,
    state,
    constants: {
        calendarShareCloseMs: CALENDAR_SHARE_CLOSE_MS,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
    },
    escapeHtml,
    getCalendarLabel,
    getCalendarLabelFromData,
    trackCalendarMutation,
});
const {
    canCreateCalendarSubscription,
    closeCalendarShareModal,
    openCalendarShareModal,
    openCalendarSubscriptionModal,
} = calendarShare;
const calendarUiActions = window.APStudyCalendarUiActions.createCalendarUiActions({
    root: pageRoot,
    lifecycle,
    state,
    callbacks: {
        getCalendarEventColor: getEventCalendarColor,
        getCalendarEventCount,
        getCalendarLabel,
        getEventBadgeColors,
        getEventBadgeStyle,
        getEventElementAttributes,
        canCreateCalendarSubscription,
        openCalendarInfoModal: (...args) => openCalendarInfoModal(...args),
        openCalendarSubscriptionModal: (...args) => openCalendarSubscriptionModal(...args),
        openRgbModal: (...args) => openRgbModal(...args),
        setCalendarColor,
    },
    formatters: {
        escapeHtml,
        isTaskEvent,
    },
});
const {
    buildEventChip,
    closeCalendarContextMenu,
    openCalendarContextMenu,
    positionCalendarContextMenu,
} = calendarUiActions;
const calendarAgenda = window.APStudyCalendarAgenda.createCalendarAgenda({
    root: pageRoot,
    state,
    callbacks: {
        getCalendarEventColor: getEventCalendarColor,
        getCalendarEventLabel: getEventCalendarLabel,
        getCalendarEventRef,
        getEventBadgeColors,
        getEventElementAttributes,
        getEventsForDay,
        getVisibleEvents,
    },
    formatters: {
        escapeHtml,
        formatAllDayRange,
        formatMultilineText,
        formatTimedEventRange,
        getAccent,
        getStartOfWeek,
        getUrgencyLabel,
        getUrgencyLabelAllDay,
        isTaskEvent,
        isToday,
    },
});
const {
    buildMobileCalendarAgendaHtml,
    buildUpcomingAgendaHtml,
    renderAssignments,
} = calendarAgenda;
const calendarMonthView = window.APStudyCalendarMonthView.createCalendarMonthView({
    state,
    constants: {
        weekdays: WEEKDAYS,
    },
    callbacks: {
        buildEventChip,
        getEventBadgeColors,
        getEventBadgeStyle,
        getEventElementAttributes,
        getEventsForDay,
        getVisibleEvents,
    },
    formatters: {
        dateToDayIndex,
        escapeHtml,
        formatDateKey,
        formatMonthGridDayLabel,
        isToday,
    },
});
const {
    buildMonthViewHtml,
} = calendarMonthView;
const calendarWeekView = window.APStudyCalendarWeekView.createCalendarWeekView({
    state,
    constants: {
        allDayMinHeightPx: ALL_DAY_MIN_HEIGHT_PX,
        hourHeightPx: HOUR_HEIGHT_PX,
        weekMinimumDayWidthPx: WEEK_MINIMUM_DAY_WIDTH_PX,
        weekdays: WEEKDAYS,
    },
    callbacks: {
        getEventBadgeStyle,
        getEventElementAttributes,
        getEventsForDay,
        getVisibleEvents,
    },
    formatters: {
        dateToDayIndex,
        escapeHtml,
        formatHourLabel,
        formatTimeOnly,
        getStartOfWeek,
        isTaskEvent,
        isToday,
        layoutTimedEvents,
    },
});
const {
    buildWeekViewHtml,
} = calendarWeekView;
const calendarSources = window.APStudyCalendarSources.createCalendarSources({
    root: pageRoot,
    lifecycle,
    dataAdapter: adapter,
    state,
    constants: {
        eventsCacheKey: EVENTS_CACHE_KEY,
    },
    closeCalendarContextMenu,
    escapeHtml,
    getBufferedRange,
    getCalendarEventCount,
    getCalendarLabel,
    getCurrentRenderRange,
    invalidateCalendarPreferencesCache,
    isLocalCalendar,
    loadCalendarData,
    queueCalendarPreferenceSave,
    renderCalendarMenu,
    runManualRefresh,
    setCalendarColor,
    trackCalendarMutation,
});
const {
    closeCalendarSourceCreateModal,
    closeRgbModal,
    closeSourceInfoModal,
    openCalendarInfoModal,
    openCalendarSourceCreateModal,
    openRgbModal,
} = calendarSources;
const calendarControls = window.APStudyCalendarControls.createCalendarControls({
    root: pageRoot,
    lifecycle,
    state,
    callbacks: {
        applyCourseFilters,
        applyCoursesFiltersFromUrl,
        closeCalendarContextMenu,
        closeCalendarShareModal,
        closeCalendarSourceCreateModal,
        closeCoursesModal,
        closeRgbModal,
        closeSourceInfoModal,
        ensureCalendarPreferencesLoaded,
        ensureEventsForRange,
        getBufferedRange,
        getCalendarEventByRef,
        getCurrentRenderRange,
        getEventCalendarLabel,
        isCompactCalendarViewport,
        openCalendarContextMenu,
        openCalendarShareModal,
        openCalendarSourceCreateModal,
        openCoursesModal,
        positionCalendarContextMenu,
        render,
        renderAssignments,
        renderCalendarMenu,
        renderCalendarView,
        renderCoursesModal,
        runManualRefresh,
        scheduleCalendarPreferenceFlush,
        submitCoursesSearch,
        toggleCalendarVisibility,
        toggleCourseSectionSelection,
        writeCourseFiltersToUrl,
    },
    formatters: {
        escapeHtml,
        formatAllDayRange,
        formatMultilineText,
        formatTimedEventRange,
    },
});
const {
    hideCalendarHoverCard,
    wireControls,
} = calendarControls;
const compatibilityKeys = [
    "state",
    "render",
    "loadCalendarData",
    "refreshCalendarFeed",
    "ensureEventsForRange",
    "runManualRefresh",
    "getBufferedRangeForView",
    "getCalendarEventByRef",
    "getCalendarOptionsForEventForm",
    "getDefaultCalendarIdForEventForm",
    "getCalendarColorForEventForm",
    "getStandardCalendarColors",
];
const previousCompatibility = new Map(compatibilityKeys.map((key) => [key, window[key]]));
const bootstrap = window.APStudyCalendarBootstrap.createCalendarBootstrap({
    state,
    callbacks: {
        applyCoursesFiltersFromUrl,
        ensureEventsForRange,
        getBufferedRange,
        getCalendarEventByRef,
        getCalendarOptionsForEventForm,
        getCurrentRenderRange,
        getDefaultCalendarIdForEventForm,
        initializeCourseSelectionsFromStorage,
        hydrateSavedCourses,
        loadCalendarData,
        refreshCalendarFeed,
        render,
        runManualRefresh,
        wireControls,
    },
});
const originalDocumentAddEventListener = doc.addEventListener;
if (typeof originalDocumentAddEventListener === "function") {
    doc.addEventListener = function (type, listener, options) {
        if (type === "DOMContentLoaded" && typeof listener === "function") {
            originalDocumentAddEventListener.call(this, type, listener, options);
            lifecycle.addCleanup(() => doc.removeEventListener(type, listener, options));
            return undefined;
        }
        return originalDocumentAddEventListener.call(this, type, listener, options);
    };
}
try {
    if (extensionMount) {
        // Register compatibility exports without waiting for a page-load event
        // that has already fired in the content-script lifecycle.
        doc.addEventListener = function(type, listener, options) {
            if (type !== "DOMContentLoaded") originalDocumentAddEventListener.call(this, type, listener, options);
        };
    }
    bootstrap.register();
} finally {
    if (typeof originalDocumentAddEventListener === "function") {
        doc.addEventListener = originalDocumentAddEventListener;
    }
}
let ready = Promise.resolve();
if (extensionMount) {
    wireControls();
    lifecycle.addEventListener(root.querySelector("#calendar-today"), "click", () => {
        state.anchorDate = window.APStudyDate?.toCalendarDate?.(new Date()) || new Date();
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    const createButton = root.querySelector("#calendar-new-event");
    createButton.hidden = calendarCapabilities.readOnly;
    lifecycle.addEventListener(createButton, "click", () => window.openCalendarEventForm?.({ mode: "create" }));
    render();
    ready = hydrateSavedCourses().then(() => loadCalendarData()).then(() => {
        if (!disposed) { root.setAttribute("data-apstudycanvas-calendar-ready", "1"); root.querySelector("#calendar-view-root").setAttribute("data-apstudycanvas-calendar-content", "1"); }
    });
}
const mountedCompatibility = new Map(compatibilityKeys.map((key) => [key, window[key]]));

const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (extensionMount) window.closeCalendarEventForm?.();
    calendarExtensionUi.dispose();
    lifecycle.dispose();
    if (window.APStudyCalendarDataAdapter === adapter) {
        if (previousCalendarDataAdapter === undefined) delete window.APStudyCalendarDataAdapter;
        else window.APStudyCalendarDataAdapter = previousCalendarDataAdapter;
    }
    for (const key of compatibilityKeys) {
        if (window[key] === mountedCompatibility.get(key)) {
            const previous = previousCompatibility.get(key);
            if (previous === undefined) delete window[key];
            else window[key] = previous;
        }
    }
};
dispose.ready = ready;
return dispose;
}
/* ── Controls ──────────────────────────────────────────────────────────────── */
