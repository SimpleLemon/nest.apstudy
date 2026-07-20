import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../static/js/core/command-palette-search.js", import.meta.url), "utf8");
const {
    COMMAND_SEARCH_DEBOUNCE_MS,
    COMMAND_SEARCH_MIN_LENGTH,
    WORKSPACE_SEARCH_GROUPS,
    fetchWorkspaceSearch,
    formatSearchTimestamp,
    normalizeWorkspaceSearch,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("global search keeps the agreed debounce and category order", () => {
    assert.equal(COMMAND_SEARCH_MIN_LENGTH, 2);
    assert.equal(COMMAND_SEARCH_DEBOUNCE_MS, 180);
    assert.deepEqual(
        WORKSPACE_SEARCH_GROUPS.map((group) => group.key),
        ["files", "notes", "events", "messages", "courses"],
    );
});

test("search payload normalization fills missing groups and preserves eligibility", () => {
    const payload = normalizeWorkspaceSearch({
        query: "bio",
        total: 1,
        courses_enabled: true,
        unavailable_categories: ["events"],
        groups: { notes: [{ id: "note-1" }] },
    });

    assert.equal(payload.coursesEnabled, true);
    assert.deepEqual(payload.unavailableCategories, ["events"]);
    assert.deepEqual(payload.groups.files, []);
    assert.deepEqual(payload.groups.notes, [{ id: "note-1" }]);
});

test("workspace search encodes the query and forwards cancellation", async () => {
    const controller = new AbortController();
    let requestUrl = "";
    let requestSignal = null;
    const payload = await fetchWorkspaceSearch("bio & chem", {
        signal: controller.signal,
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestSignal = options.signal;
            return {
                ok: true,
                async json() {
                    return { query: "bio & chem", groups: {} };
                },
            };
        },
    });

    assert.equal(requestUrl, "/api/search?q=bio%20%26%20chem");
    assert.equal(requestSignal, controller.signal);
    assert.equal(payload.query, "bio & chem");
});

test("event metadata includes date and time while all-day events omit time", () => {
    const now = new Date("2026-07-20T10:00:00Z");
    const timed = formatSearchTimestamp({
        category: "events",
        timestamp: "2026-07-21T16:30:00Z",
        is_all_day: false,
    }, now);
    const allDay = formatSearchTimestamp({
        category: "events",
        timestamp: "2026-07-21T00:00:00Z",
        is_all_day: true,
    }, now);

    assert.match(timed, /Jul 21/);
    assert.doesNotMatch(allDay, /:/);
});
