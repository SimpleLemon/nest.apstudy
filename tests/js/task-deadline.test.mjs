import assert from "node:assert/strict";
import test from "node:test";
import { loadTaskModule } from "./helpers/tasks-app.mjs";

globalThis.window = {
    APStudyDate: {
        isoToLocalInput(value) {
            if (!value) return "";
            const date = new Date(value);
            const pad = (part) => String(part).padStart(2, "0");
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
        },
        localInputToIso(value) {
            if (!value) return null;
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? null : date.toISOString();
        },
    },
};

const controls = await loadTaskModule("task-form-controls.js");
const deadline = await loadTaskModule("task-deadline.js");

test("custom calendar always builds a six-week grid and moves across month edges", () => {
    const cells = controls.calendarCells("2026-02-01");
    assert.equal(cells.length, 42);
    assert.equal(cells[0].value, "2026-02-01");
    assert.equal(controls.moveDate("2026-02-28", 1), "2026-03-01");
});

test("deadline time parsing accepts valid twelve-hour values", () => {
    assert.equal(deadline.parseDisplayTime("9:05", "AM"), "09:05");
    assert.equal(deadline.parseDisplayTime("12:30", "AM"), "00:30");
    assert.equal(deadline.parseDisplayTime("12:30", "PM"), "12:30");
    assert.equal(deadline.parseDisplayTime("13:00", "PM"), null);
    assert.equal(deadline.parseDisplayTime("9:7", "AM"), null);
});

test("deadline payloads distinguish date-only and timed tasks", () => {
    const dateOnly = deadline.deadlinePayload({ date: "2026-07-20", hasTime: false, reminderMinutes: -540 }, "America/Phoenix");
    assert.equal(dateOnly.deadline_time, null);
    assert.equal(dateOnly.reminder_minutes, -540);
    assert.ok(dateOnly.deadline_at);

    const timed = deadline.deadlinePayload({ date: "2026-07-20", hasTime: true, timeText: "11:59", period: "PM", reminderMinutes: 10 }, "America/Phoenix");
    assert.equal(timed.deadline_time, "23:59");
    assert.equal(timed.reminder_minutes, 10);
    assert.equal(deadline.deadlinePayload({ date: "2026-07-20", hasTime: true, timeText: "", period: "PM", reminderMinutes: 10 }), null);
});

test("deadline drafts preserve saved reminder kind", () => {
    const draft = deadline.deadlineDraft({ deadline_at: "2026-07-20T06:59:00Z", deadline_time: "23:59", reminder_minutes: 30 });
    assert.equal(draft.hasTime, true);
    assert.equal(draft.timeText, "11:59");
    assert.equal(draft.period, "PM");
    assert.equal(draft.reminderMinutes, 30);
});
