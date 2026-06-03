(function () {
    function createCalendarBootstrap({
        state,
        callbacks,
    }) {
        const {
            applyCoursesFiltersFromUrl,
            ensureEventsForRange,
            getBufferedRange,
            getCalendarEventByRef,
            getCalendarOptionsForEventForm,
            getCurrentRenderRange,
            getDefaultCalendarIdForEventForm,
            initializeCourseSelectionsFromStorage,
            loadCalendarData,
            refreshCalendarFeed,
            render,
            runManualRefresh,
            wireControls,
        } = callbacks;

        function register() {
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
        }

        return { register };
    }

    window.APStudyCalendarBootstrap = { createCalendarBootstrap };
})();
