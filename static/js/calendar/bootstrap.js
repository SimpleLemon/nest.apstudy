// Page startup and event deep links belong to the mounted calendar lifecycle.
export function createCalendarBootstrap({
    document: doc, view, lifecycle, state,
    applyCoursesFiltersFromUrl, initializeCourseSelectionsFromStorage,
    hydrateSavedCourses, loadCalendarData, wireControls,
    getCalendarEventByRef, activateEvent, registerEventInteractions,
}) {
    function readEventDeepLink() {
        if (state.public.readOnly) return null;
        const params = new URLSearchParams(view.location.search);
        const eventRef = params.get("event");
        if (!eventRef) return null;
        const dateMatch = String(params.get("date") || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dateMatch) {
            const candidate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
            if (!Number.isNaN(candidate.getTime())) state.anchorDate = candidate;
        }
        return eventRef;
    }

    async function start() {
        const eventRef = readEventDeepLink();
        if (!state.public.readOnly) {
            applyCoursesFiltersFromUrl();
            initializeCourseSelectionsFromStorage();
            await hydrateSavedCourses();
        }
        if (lifecycle.isDisposed()) return;
        wireControls();
        registerEventInteractions();
        await loadCalendarData();
        if (!eventRef || lifecycle.isDisposed()) return;
        const url = new URL(view.location.href);
        url.searchParams.delete("event");
        url.searchParams.delete("date");
        view.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        const calendarEvent = getCalendarEventByRef(eventRef);
        if (calendarEvent && activateEvent(calendarEvent)) return;
        view.APStudyToast?.show?.({ title: "Event not found", message: "That calendar event is no longer available.", type: "error" });
    }

    function register() {
        if (doc.readyState === "loading") lifecycle.addEventListener(doc, "DOMContentLoaded", start, { once: true });
        else void start();
    }
    return { register };
}
