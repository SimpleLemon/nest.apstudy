import { createCalendarHoverCard } from "./events/hover-card.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCourseControls } from "./integrations/course-controls.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarHost } from "./host.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarViews } from "./views/index.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarState } from "./state.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarCore } from "./core.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarMenu } from "./menu.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarPreferences } from "./preferences.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarControls } from "./controls.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarCourses } from "./integrations/courses.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarData } from "./integrations/data.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarShare } from "./integrations/share.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarSources } from "./integrations/sources.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarEventRender } from "./views/event-render.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarRenderShell } from "./views/render-shell.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarUiActions } from "./events/ui-actions.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import * as calendarUtils from "./utils.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarEventForm } from "./events/event-form.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarEventMenu } from "./events/context-menu.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarMirrors } from "./events/mirrors.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarBootstrap } from "./bootstrap.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarExtensionUi } from "./extension-ui.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

export function mountCalendar(root, dataAdapter, capabilities = {}) {
    if (!root || root.nodeType !== 1) return () => {};

    if (!root.ownerDocument) return () => {};
    const { doc, runtimeWindow, pageRoot, body, extensionMount, calendarCapabilities, lifecycle, adapter } = createCalendarHost(root, dataAdapter, capabilities);
    const window = runtimeWindow;
    let disposed = false;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
const PUBLIC_SHARE_CODE = body?.dataset.publicShareCode || "";
const PUBLIC_CALENDAR_TITLE = body?.dataset.publicCalendarTitle || "Shared Calendar";
const PUBLIC_CALENDAR_RANGE_LABEL = body?.dataset.publicCalendarRangeLabel || "Shared dates";
const CALENDAR_SHARE_CLOSE_MS = 140;
const PREFERENCE_SAVE_DELAY_MS = 1000;
const PREFERENCE_SAVE_TIMEOUT_MS = 5000;
const PREFERENCE_SAVE_RETRY_DELAYS_MS = [1000, 3000];
const PREFERENCE_SAVE_WARNING_COOLDOWN_MS = 60000;
const PREFERENCE_BATCH_LIMIT = 50;
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
    escapeHtml,
    formatMultilineText,
} = calendarUtils;
const state = createCalendarState({
    defaultDashboardView: DEFAULT_DASHBOARD_VIEW,
    publicCalendarRangeLabel: PUBLIC_CALENDAR_RANGE_LABEL,
    publicCalendarTitle: PUBLIC_CALENDAR_TITLE,
    publicShareCode: PUBLIC_SHARE_CODE,
    readOnly: calendarCapabilities.readOnly,
});
state.nativeEditable = !extensionMount || capabilities.nestMutation === true;
const canCreateEvent = () => !state.public.readOnly
    && calendarCapabilities.supported
    && calendarCapabilities.canMutateNative
    && state.nativeEditable === true;
const canMutateEvent = (event) => event?.source_type === "external"
    ? !state.public.readOnly && calendarCapabilities.supported
        && calendarCapabilities.canMutateNative && event.editable === true
    : canCreateEvent();
if (extensionMount) {
    state.public.title = "Calendar";
    state.public.rangeLabel = "Read-only";
}
const calendarCore = createCalendarCore({
    authenticatedReadOnly: extensionMount,
    state,
    constants: {
        defaultLocalCalendarId: DEFAULT_LOCAL_CALENDAR_ID,
        defaultLocalCalendarName: DEFAULT_LOCAL_CALENDAR_NAME,
        localSourcePrefix: LOCAL_SOURCE_PREFIX,
        simulatedCalendarName: SIMULATED_CALENDAR_NAME,
    },
    callbacks: {
        buildSimulatedMeetingEvents: (start, end) => buildSimulatedMeetingEvents(start, end),
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
const calendarMenu = createCalendarMenu({
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
        buildSimulatedMeetingEvents: (start, end) => buildSimulatedMeetingEvents(start, end),
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
const calendarRenderShell = createCalendarRenderShell({
    runtimeWindow,
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
        retryCalendarLoad: () => retryCalendarLoad(),
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
const render = () => {
    renderCalendarShell();
    calendarExtensionUi.render();
};
const calendarPreferences = createCalendarPreferences({
    runtimeWindow,
    strictLoad: extensionMount,
    authenticatedReadOnly: extensionMount,
    lifecycle,
    dataAdapter: adapter,
    state,
    constants: {
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
const calendarCourses = createCalendarCourses({
    runtimeWindow,
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
    renderCoursesModal,
    ensureSimulatedCalendarPreference,
    buildSimulatedMeetingEvents,
} = calendarCourses;
const calendarData = createCalendarData({
    runtimeWindow,
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
    runManualRefresh,
    retryCalendarLoad,
    setCalendarColor,
    toggleCalendarVisibility,
    ensureEventsForRange,
} = calendarData;
const calendarEventRender = createCalendarEventRender({
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
        getCssColorVariable: (name, fallback) => calendarUtils.getCssColorVariable(name, fallback, pageRoot, runtimeWindow),
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
const calendarShare = createCalendarShare({
    runtimeWindow,
    root: pageRoot,
    overlayRoot: extensionMount ? pageRoot : doc.body,
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
const calendarUiActions = createCalendarUiActions({
    runtimeWindow,
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
        openCalendarInfoModal: (calendarName) => openCalendarInfoModal(calendarName),
        openCalendarSubscriptionModal,
        openRgbModal: (calendarName) => openRgbModal(calendarName),
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
const {
    buildMobileCalendarAgendaHtml, buildUpcomingAgendaHtml, renderAssignments,
    buildMonthViewHtml, buildWeekViewHtml,
} = createCalendarViews({
    pageRoot, state, WEEKDAYS, ALL_DAY_MIN_HEIGHT_PX, HOUR_HEIGHT_PX, WEEK_MINIMUM_DAY_WIDTH_PX, getEventCalendarColor, getEventCalendarLabel, getCalendarEventRef, getEventBadgeColors, getEventBadgeStyle, getEventElementAttributes, getEventsForDay, getVisibleEvents, buildEventChip, escapeHtml, formatAllDayRange, formatMultilineText, formatTimedEventRange, getAccent, getStartOfWeek, getUrgencyLabel, getUrgencyLabelAllDay, isTaskEvent, isToday, dateToDayIndex, formatDateKey, formatMonthGridDayLabel, formatHourLabel, formatTimeOnly, layoutTimedEvents
});
const calendarSources = createCalendarSources({
    runtimeWindow,
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
const hoverCard = createCalendarHoverCard({
    root: pageRoot, runtimeWindow, lifecycle, state, getCalendarEventByRef, getEventCalendarLabel,
    formatters: {
        escapeHtml,
        formatAllDayRange,
        formatMultilineText,
        formatTimedEventRange,
    },
});
const hideCalendarHoverCard = hoverCard.hide;
const calendarControls = createCalendarControls({
    runtimeWindow,
    root: pageRoot,
    lifecycle,
    state,
    hoverCard,
    wireCourseControls: createCourseControls({ root: pageRoot, runtimeWindow, lifecycle, state, courses: calendarCourses }),
    callbacks: {
        closeCalendarContextMenu,
        closeCalendarShareModal,
        closeCalendarSourceCreateModal,
        closeRgbModal,
        closeSourceInfoModal,
        ensureCalendarPreferencesLoaded,
        ensureEventsForRange,
        getBufferedRange,
        getCurrentRenderRange,
        isCompactCalendarViewport,
        openCalendarContextMenu,
        openCalendarShareModal,
        openCalendarSourceCreateModal,
        positionCalendarContextMenu,
        render,
        renderAssignments,
        renderCalendarMenu,
        renderCalendarView,
        runManualRefresh,
        scheduleCalendarPreferenceFlush,
        toggleCalendarVisibility,
    },

});
const {
    wireControls,
} = calendarControls;
const eventForm = createCalendarEventForm({
    document: doc, view: runtimeWindow, lifecycle, adapter,
    canCreate: canCreateEvent,
    canMutateEvent,
    calendars: {
        getCalendarOptions: getCalendarOptionsForEventForm,
        getDefaultCalendarId: getDefaultCalendarIdForEventForm,
        getCalendarColor: (id) => state.calendars[id]?.color || state.calendarColors[4] || "#0ea5e9",
        getStandardColors: () => [...state.calendarColors],
    },
    reload: loadCalendarData,
});
const mirrors = createCalendarMirrors({ document: doc, view: runtimeWindow, adapter, reload: loadCalendarData, lifecycle });
const eventMenu = createCalendarEventMenu({
    root, document: doc, view: runtimeWindow, lifecycle, adapter, state, mirrors,
    canCreate: canCreateEvent,
    canMutateEvent,
    getCalendarEventByRef, openEventForm: eventForm.open,
    goToToday: () => {
        state.anchorDate = new Date();
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    },
    reload: loadCalendarData,
});
const bootstrap = createCalendarBootstrap({
    document: doc, view: runtimeWindow, lifecycle, state,
    applyCoursesFiltersFromUrl, initializeCourseSelectionsFromStorage,
    hydrateSavedCourses, loadCalendarData, wireControls,
    getCalendarEventByRef, activateEvent: eventMenu.activateEvent,
    registerEventInteractions: eventMenu.register,
});
let ready = Promise.resolve();
if (extensionMount) {
    wireControls();
    eventMenu.register();
    lifecycle.addEventListener(root.querySelector("#calendar-today"), "click", () => {
        state.anchorDate = new Date();
        render();
        void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
    });
    const createButton = root.querySelector("#calendar-new-event");
    createButton.hidden = !canCreateEvent();
    lifecycle.addEventListener(createButton, "click", () => {
        if (canCreateEvent()) eventForm.open({ mode: "create" });
    });
    render();
    ready = hydrateSavedCourses().then(() => loadCalendarData()).then(() => {
        if (!disposed) { root.setAttribute("data-apstudycanvas-calendar-ready", "1"); root.querySelector("#calendar-view-root").setAttribute("data-apstudycanvas-calendar-content", "1"); }
    });
} else {
    bootstrap.register();
}

const dispose = () => {
    if (disposed) return;
    disposed = true;
    calendarExtensionUi.dispose();
    lifecycle.dispose();

};
dispose.ready = ready;
return dispose;
}
