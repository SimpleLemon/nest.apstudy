import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function sourceFor(path) {
    return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("command palette search opens resource hrefs and retains grouped keyboard results", async () => {
    const source = await sourceFor("static/js/core/command-palette.js");
    const workspaceSource = await sourceFor("static/js/core/command-palette-workspace.js");
    assert.match(source, /fetchWorkspaceSearch\(query/);
    assert.match(workspaceSource, /WORKSPACE_SEARCH_GROUPS/);
    assert.match(source, /navigateTo\(result\.href\)/);
    assert.match(workspaceSource, /Command\.Item/);
    assert.match(source, /Search anything in Nest/);
});

test("file search links reveal and focus the requested file", async () => {
    const source = await sourceFor("static/js/files/index.js");
    assert.match(source, /initialParams\.get\("folder"\)/);
    assert.match(source, /initialParams\.get\("file"\)/);
    assert.match(source, /row\.scrollIntoView/);
    assert.match(source, /row\.focus/);
    assert.match(source, /is-search-target/);
});

test("calendar search links load the event date before opening the event", async () => {
    const bootstrap = await sourceFor("static/js/calendar/bootstrap.js");
    const eventMenu = await sourceFor("static/js/calendar/events/context-menu.js");
    assert.match(bootstrap, /params\.get\("event"\)/);
    assert.match(bootstrap, /params\.get\("date"\)/);
    assert.match(bootstrap, /await loadCalendarData\(\)/);
    assert.match(bootstrap, /activateEvent/);
    assert.match(eventMenu, /function activateEvent\(/);
});
