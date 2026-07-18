import { expect, test } from "playwright/test";

test("week rendering gives isolated groups full width and overlapping groups deterministic lanes", async ({ page, baseURL }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/static/js/calendar/utils.js`);
    await page.setContent(`<!doctype html><html><body><div id="calendar"></div></body></html>`);
    await page.evaluate(async () => {
        await import("/static/js/calendar/utils.js");
        await import("/static/js/calendar/views/week-view.js");
        const day = new Date(2026, 6, 19);
        const at = (hour, minute = 0) => new Date(2026, 6, 19, hour, minute);
        const events = [
            { id: "before", title: "Before", startDate: at(8), endDate: at(9) },
            { id: "pair-a", title: "Pair A", startDate: at(10), endDate: at(11) },
            { id: "pair-b", title: "Pair B", startDate: at(10, 30), endDate: at(11, 30) },
            { id: "after", title: "After", startDate: at(12), endDate: at(13) },
            { id: "triple-a", title: "Triple A", startDate: at(14), endDate: at(16) },
            { id: "triple-b", title: "Triple B", startDate: at(14), endDate: at(15, 30) },
            { id: "triple-c", title: "Triple C", startDate: at(14), endDate: at(15) },
        ];
        const view = window.APStudyCalendarWeekView.createCalendarWeekView({
            state: { anchorDate: day },
            constants: { allDayMinHeightPx: 44, hourHeightPx: 60, weekMinimumDayWidthPx: 148, weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
            callbacks: {
                getEventBadgeStyle: () => "background:#fff;color:#000;border-color:#000;",
                getEventElementAttributes: (event) => `data-event-id="${event.id}"`,
                getEventsForDay: (date) => date.getDate() === day.getDate() ? events : [],
                getVisibleEvents: () => events,
            },
            formatters: {
                ...window.APStudyCalendarUtils,
                escapeHtml: String,
                formatHourLabel: (hour) => String(hour),
                isTaskEvent: () => false,
                isToday: () => false,
            },
        });
        document.getElementById("calendar").innerHTML = view.buildWeekViewHtml();
    });

    const widths = await page.locator("[data-event-id]").evaluateAll((elements) => Object.fromEntries(
        elements.map((element) => [element.dataset.eventId, element.getBoundingClientRect().width]),
    ));
    expect(widths.before).toBeGreaterThan(widths["pair-a"] * 1.8);
    expect(widths.after).toBeGreaterThan(widths["pair-b"] * 1.8);
    expect(Math.abs(widths["pair-a"] - widths["pair-b"])).toBeLessThan(1);
    expect(widths["pair-a"]).toBeGreaterThan(widths["triple-a"] * 1.4);
    expect(Math.max(widths["triple-a"], widths["triple-b"], widths["triple-c"])
        - Math.min(widths["triple-a"], widths["triple-b"], widths["triple-c"])).toBeLessThan(1);
    expect(errors).toEqual([]);
});
