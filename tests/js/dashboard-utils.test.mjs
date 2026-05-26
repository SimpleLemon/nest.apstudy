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
            { id: "messages", size: "medium" },
            { id: "calendar", size: "medium" },
            { id: "tasks", size: "medium" },
        ],
    );

    assert.deepEqual(
        plain(utils.normalizeTileLayout(
            { version: 2, tiles: [{ id: "calendar", size: "large" }, { id: "tasks", size: "large" }] },
            ["calendar", "tasks"],
        )),
        [
            { id: "calendar", size: "large" },
            { id: "tasks", size: "medium" },
        ],
    );
});

test("dashboard utility snaps resize to allowed presets", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/dashboard.js"), "utf8");
    const utils = loadDashboardUtils(source);

    assert.equal(utils.nearestTileSize("calendar", 120, 20, "medium"), "wide");
    assert.equal(utils.nearestTileSize("calendar", 220, 20, "medium"), "large");
    assert.equal(utils.nearestTileSize("tasks", -120, 0, "medium"), "compact");
    assert.equal(utils.normalizeTileSize("courses", "compact"), "wide");
});
