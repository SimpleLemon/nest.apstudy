import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadDashboardUtils(source) {
    const document = {
        getElementById() {
            return null;
        },
        addEventListener() {},
        createElement() {
            return {
                textContent: "",
                get innerHTML() {
                    return String(this.textContent)
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
                },
            };
        },
        body: {
            appendChild() {},
        },
        querySelector() {
            return null;
        },
    };
    const context = {
        document,
        window: {
            setTimeout() {},
        },
        Date,
        fetch() {
            throw new Error("fetch should not run while loading utils");
        },
    };
    context.window.document = document;
    vm.runInNewContext(source, context);
    return context.window.APStudyDashboardUtils;
}

test("dashboard utilities group events and format bytes", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    const grouped = utils.groupEventsByDate([
        { title: "A", date: "2026-05-01" },
        { title: "B", start: "2026-05-01T12:00:00Z" },
        { title: "C", date: "2026-05-02" },
    ]);

    assert.equal(grouped.get("2026-05-01").length, 2);
    assert.equal(grouped.get("2026-05-02").length, 1);
    assert.equal(utils.formatBytes(1536), "1.5 KB");
});

test("dashboard utility applies saved tile order while appending missing tiles", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    assert.deepEqual(
        Array.from(utils.normalizeTileOrder(["messages", "calendar", "messages"], ["calendar", "tasks", "messages"])),
        ["messages", "calendar", "tasks"],
    );
});

test("dashboard utility normalizes v1 and v2 tile layouts", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    assert.deepEqual(
        plain(utils.normalizeTileLayout(["messages", "calendar"], ["calendar", "tasks", "messages"])),
        [
            { id: "messages", size: "standard" },
            { id: "calendar", size: "standard", view: "month" },
            { id: "tasks", size: "standard" },
        ],
    );

    assert.deepEqual(
        plain(utils.normalizeTileLayout(
            { version: 2, tiles: [{ id: "calendar", size: "wide" }, { id: "tasks", size: "compact" }] },
            ["calendar", "tasks"],
        )),
        [
            { id: "calendar", size: "wide", view: "month" },
            { id: "tasks", size: "standard" },
        ],
    );

    assert.deepEqual(
        plain(utils.normalizeTileLayout(
            { version: 3, tiles: [{ id: "calendar", size: "tall", view: "week" }] },
            ["calendar", "tasks"],
        )),
        [
            { id: "calendar", size: "tall", view: "week" },
        ],
    );
});

test("dashboard utility applies new size and calendar view rules", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    assert.equal(utils.normalizeTileSize("calendar", "medium"), "standard");
    assert.equal(utils.normalizeTileSize("tasks", "large"), "wide");
    assert.equal(utils.normalizeTileSize("courses", "tall"), "wide");
    assert.equal(utils.normalizeCalendarView("calendar", "upcoming"), "upcoming");
    assert.equal(utils.normalizeCalendarView("calendar", "agenda"), "month");
    assert.equal(utils.nearestTileSize("tasks", 0, 140, "standard"), "tall");
    assert.equal(utils.nearestTileSize("tasks", 140, 140, "standard"), "wide");
    assert.equal(utils.nearestTileSize("courses", 0, 140, "standard"), "wide");
});

test("dashboard summary tile layout arrays preserve v3 hidden tiles", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    const summaryLayout = utils.summaryLayoutSource({
        tile_layout_version: 3,
        tile_layout: [{ id: "calendar", size: "standard", view: "month" }],
        tile_order: ["calendar"],
    });

    assert.deepEqual(
        plain(utils.normalizeTileLayout(summaryLayout, ["calendar", "tasks"])),
        [{ id: "calendar", size: "standard", view: "month" }],
    );
});
