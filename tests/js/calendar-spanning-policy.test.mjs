import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calendarScript } from "./helpers/calendar-script.mjs";

globalThis.window = { APStudyUIPrimitives: { escapeHtml: String } };
globalThis.document = { documentElement: {} };
for (const [file, namespace] of [
    ["utils.js", "APStudyCalendarUtils"],
    ["views/month-view.js", "APStudyCalendarMonthView"],
    ["views/week-view.js", "APStudyCalendarWeekView"],
]) {
    const source = await readFile(new URL(`../../static/js/calendar/${file}`, import.meta.url), "utf8");
    await import(`data:text/javascript;base64,${Buffer.from(calendarScript(source, namespace)).toString("base64")}#spanning-${file}`);
}

const utils = globalThis.window.APStudyCalendarUtils;
const { getEventEndDayExclusive, isTimedMultiDayEvent, packSpanningEvents, selectSpanningEventsForWeek } = utils;
const day = (date, hour = 0, minute = 0, ms = 0) => new Date(2026, 6, date, hour, minute, 0, ms);
const weekDays = Array.from({ length: 7 }, (_, index) => day(19 + index));
const event = (properties = {}) => ({ title: "Study", startDate: day(20, 22), endDate: day(22, 8), ...properties });

test("timed spans use the last occupied millisecond and exclude all-day events", () => {
    const midnightEnd = event({ endDate: day(21) });
    assert.equal(isTimedMultiDayEvent(midnightEnd), false);
    assert.equal(getEventEndDayExclusive(midnightEnd).getTime(), day(21).getTime());
    const afterMidnight = event({ endDate: day(21, 0, 0, 1) });
    assert.equal(isTimedMultiDayEvent(afterMidnight), true);
    assert.equal(getEventEndDayExclusive(afterMidnight).getTime(), day(22).getTime());
    assert.equal(isTimedMultiDayEvent(event()), true);
    assert.equal(isTimedMultiDayEvent(event({ isAllDay: true })), false);
    for (const endDate of [null, new Date(NaN), day(20, 22), day(20, 21)]) {
        const invalidEnd = event({ endDate });
        assert.equal(isTimedMultiDayEvent(invalidEnd), false);
        assert.equal(getEventEndDayExclusive(invalidEnd).getTime(), day(21).getTime());
    }
});

test("all-day end dates are exclusive with a one-day fallback", () => {
    const allDay = event({ isAllDay: true, startDate: day(20), endDate: day(22) });
    assert.equal(getEventEndDayExclusive(allDay).getTime(), day(22).getTime());
    assert.deepEqual(selectSpanningEventsForWeek([allDay], weekDays).map(({ gridColStart, gridSpan }) => [gridColStart, gridSpan]), [[1, 2]]);
    assert.equal(getEventEndDayExclusive({ ...allDay, endDate: day(20, 8) }).getTime(), day(21).getTime());
    assert.equal(getEventEndDayExclusive({ ...allDay, endDate: null }).getTime(), day(21).getTime());
});

test("selection clamps spans to the week and excludes touching boundaries", () => {
    const events = [
        event({ id: "crossing", startDate: day(17, 22), endDate: day(28, 8) }),
        event({ id: "before", startDate: day(17), endDate: day(19), isAllDay: true }),
        event({ id: "after", startDate: day(26), endDate: day(27), isAllDay: true }),
        event({ id: "single", startDate: day(20, 8), endDate: day(20, 9) }),
    ];
    const selected = selectSpanningEventsForWeek(events, weekDays);
    assert.deepEqual(selected.map(({ id, gridColStart, gridSpan }) => [id, gridColStart, gridSpan]), [["crossing", 0, 7]]);
    assert.equal(events[0].gridColStart, undefined);
    assert.notEqual(selected[0], events[0]);
});

test("seven-column packing sorts deterministically and reuses rows for adjacent spans", () => {
    const packed = packSpanningEvents([
        { id: "adjacent", title: "Next", gridColStart: 3, gridSpan: 4 },
        { id: "short-z", title: "Z", gridColStart: 0, gridSpan: 1 },
        { id: "long", title: "Long", gridColStart: 0, gridSpan: 3 },
        { id: "short-a", title: "A", gridColStart: 0, gridSpan: 1 },
    ]);
    assert.equal(packed.rowsCount, 3);
    assert.deepEqual(packed.events.map(({ id, rowIndex }) => [id, rowIndex]), [
        ["long", 0], ["adjacent", 0], ["short-a", 1], ["short-z", 2],
    ]);
    assert.deepEqual(packSpanningEvents([]), { events: [], rowsCount: 0 });
});

function renderViews(events) {
    const renderEvents = { month: [], week: [] };
    const options = (view) => ({
        state: { anchorDate: day(20) },
        constants: { weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], allDayMinHeightPx: 28, hourHeightPx: 60, weekMinimumDayWidthPx: 80 },
        callbacks: {
            getVisibleEvents: () => events,
            getEventsForDay: () => events,
            buildEventChip: () => { throw new Error("Spanning events must not render as single-day chips"); },
            getEventBadgeColors: () => ({ background: "#fff", text: "#000", border: "#000", indicator: "#000" }),
            getEventBadgeStyle: () => "color:#000",
            getEventElementAttributes: (entry) => {
                renderEvents[view].push(entry);
                return `data-marker="${entry.marker}"`;
            },
        },
        formatters: utils,
    });
    const month = globalThis.window.APStudyCalendarMonthView.createCalendarMonthView(options("month")).buildMonthViewHtml();
    const week = globalThis.window.APStudyCalendarWeekView.createCalendarWeekView(options("week")).buildWeekViewHtml();
    return { month, week, renderEvents };
}

test("month and week share duplicate identity while retaining distinct id-less start times", () => {
    const first = event({ marker: "first", endDate: day(21, 8) });
    const events = [
        first,
        { ...first, marker: "duplicate" },
        { ...first, startDate: day(20, 23), marker: "later" },
        event({ uid: "provider-uid", marker: "uid" }),
        event({ uid: "provider-uid", title: "Changed title", marker: "uid-duplicate" }),
        event({ id: "provider-id", marker: "id" }),
        event({ id: "provider-id", marker: "id-duplicate" }),
        event({ startDate: day(20), endDate: day(22), isAllDay: true, marker: "all-day" }),
        event({ startDate: day(20), endDate: day(22), isAllDay: true, marker: "all-day-duplicate" }),
    ];
    const { renderEvents, month, week } = renderViews(events);
    const layout = (entries) => entries.map(({ marker, gridColStart, gridSpan, rowIndex }) => [marker, gridColStart, gridSpan, rowIndex]);
    assert.equal(renderEvents.month.length, 5);
    assert.deepEqual(layout(renderEvents.month), layout(renderEvents.week));
    assert.deepEqual(new Set(renderEvents.month.map(({ marker }) => marker)), new Set(["first", "later", "uid", "id", "all-day"]));
    assert.match(month, /calendar-month-spanning-event/);
    assert.match(week, /All day/);
});

test("month keeps continuation flags local when a spanning bar crosses weeks", () => {
    const crossing = event({ startDate: day(18, 22), endDate: day(27, 8), marker: "crossing" });
    const { renderEvents } = renderViews([crossing]);
    assert.deepEqual(renderEvents.month.map(({ gridSpan, continuesFromPreviousWeek, continuesToNextWeek }) => [gridSpan, continuesFromPreviousWeek, continuesToNextWeek]), [
        [1, false, true], [7, true, true], [2, true, false],
    ]);
    assert.equal(renderEvents.week[0].gridSpan, 7);
    assert.equal(renderEvents.week[0].continuesFromPreviousWeek, undefined);
    assert.equal(crossing.rowIndex, undefined);
});
