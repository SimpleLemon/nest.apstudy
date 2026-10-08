import { createCalendarDataAdapter } from "./adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarLifecycle } from "./lifecycle.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { normalizeCalendarCapabilities } from "./capabilities.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

export function createCalendarHost(root, dataAdapter, capabilities) {
    const doc = root.ownerDocument;
    const view = capabilities.view || doc.defaultView || globalThis;
    const runtimeWindow = capabilities.window || view;
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
            <a href="https://nest.apstudy.org/calendar/connections" target="_blank" rel="noopener noreferrer">Manage connections</a>
        </header><div id="calendar-menu" class="hidden"></div><div id="calendar-view-root" aria-live="polite"></div><div id="calendar-popover-root"></div>`;
    }
    const canvasPageReadOnly = body?.dataset.calendarReadonly === "true";
    const nativePageDefault = !extensionMount
        && !Object.prototype.hasOwnProperty.call(capabilities, "readOnly")
        && !Object.prototype.hasOwnProperty.call(capabilities, "read_only");
    const calendarCapabilities = normalizeCalendarCapabilities({
        ...capabilities,
        ...(nativePageDefault ? { readOnly: false } : {}),
        ...(canvasPageReadOnly ? { readOnly: true, shareMode: true } : {}),
    });
    const lifecycle = capabilities.lifecycle
        || createCalendarLifecycle({ view: runtimeWindow });
    const adapter = createCalendarDataAdapter(dataAdapter || capabilities.dataAdapter || {}, { window: runtimeWindow });

    return { doc, view, runtimeWindow, pageRoot, body, extensionMount, canvasPageReadOnly, calendarCapabilities, lifecycle, adapter };
}
