import { createCalendarAgenda } from "./agenda.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarMonthView } from "./month-view.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarWeekView } from "./week-view.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

export function createCalendarViews({
    pageRoot, state, WEEKDAYS, ALL_DAY_MIN_HEIGHT_PX, HOUR_HEIGHT_PX, WEEK_MINIMUM_DAY_WIDTH_PX, getEventCalendarColor, getEventCalendarLabel, getCalendarEventRef, getEventBadgeColors, getEventBadgeStyle, getEventElementAttributes, getEventsForDay, getVisibleEvents, buildEventChip, escapeHtml, formatAllDayRange, formatMultilineText, formatTimedEventRange, getAccent, getStartOfWeek, getUrgencyLabel, getUrgencyLabelAllDay, isTaskEvent, isToday, dateToDayIndex, formatDateKey, formatMonthGridDayLabel, formatHourLabel, formatTimeOnly, layoutTimedEvents
}) {
const calendarAgenda = createCalendarAgenda({
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
const calendarMonthView = createCalendarMonthView({
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
const calendarWeekView = createCalendarWeekView({
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
    return { buildMobileCalendarAgendaHtml, buildUpcomingAgendaHtml, renderAssignments, buildMonthViewHtml, buildWeekViewHtml };
}
