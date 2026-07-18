import { expect, test } from "playwright/test";

const notePayload = {
    title: "Payload audit",
    content: JSON.stringify([
        { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "Editable text", styles: {} }], children: [] },
        { id: "c1", type: "callout", props: { type: "info" }, content: [{ type: "text", text: "Advanced callout", styles: {} }], children: [] },
    ]),
    updated_at: "2026-07-18T12:00:00Z",
    collaboration_enabled: false,
    page_setup: {},
    global_page_setup: {},
    access: { can_edit: true, can_review: true, can_manage_reviews: true },
};

function editorHarness() {
    return `<!doctype html><html><body data-note-read-only="false">
        <input id="note-title-input">
        <span id="save-status"></span><button id="save-retry"></button>
        <main id="editor-page"><div id="blocknote-root"></div></main>
        <button id="notes-review-button">Review</button>
        <button id="notes-history-button">History</button>
        <button data-note-print disabled>Print</button>
        <div id="notes-active-collaborators" hidden></div>
        <aside id="notes-review-panel" hidden>
            <h2 data-review-panel-title></h2>
            <button data-review-panel-close>Close</button>
            <div data-review-panel-body></div>
        </aside>
    </body></html>`;
}

test("notes editor defers optional chunks while edit, autosave, advanced blocks, review, and print remain usable", async ({ page, baseURL }) => {
    const loadedChunks = [];
    const patches = [];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
        const match = request.url().match(/notes-editor-(collaboration|review-panel|print)\.js/);
        if (match) loadedChunks.push(match[1]);
    });
    await page.route("**/notes-payload-harness", (route) => route.fulfill({
        contentType: "text/html",
        body: editorHarness(),
    }));
    await page.route("**/api/notes/audit-note", async (route) => {
        if (route.request().method() === "PATCH") {
            patches.push(route.request().postDataJSON());
            await route.fulfill({ json: { ok: true } });
            return;
        }
        await route.fulfill({ json: notePayload });
    });
    await page.route("**/api/notes/audit-note/suggestions", (route) => route.fulfill({ json: { suggestions: [] } }));
    await page.route("**/api/notes/audit-note/comments", (route) => route.fulfill({ json: { threads: [] } }));
    await page.goto(`${baseURL}/notes-payload-harness`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
        window.APStudyLoader = { html: (label) => `<span>${label}</span>` };
        window.APSTUDY_NOTE_CONTEXT = {
            noteId: "audit-note",
            access: { can_edit: true, can_review: true },
        };
        window.print = () => window.dispatchEvent(new Event("afterprint"));
    });
    await page.addScriptTag({ type: "module", url: `${baseURL}/static/js/notes/dist/notes-editor-v17.js` });

    await page.waitForTimeout(500);
    expect(pageErrors).toEqual([]);
    await expect(page.locator(".bn-editor")).toBeVisible();
    await expect(page.getByText("Advanced callout")).toBeVisible();
    expect(loadedChunks).toEqual([]);

    await page.locator("#note-title-input").fill("Payload audit edited");
    await expect.poll(() => patches.length, { timeout: 4_000 }).toBeGreaterThan(0);
    expect(patches.at(-1).title).toBe("Payload audit edited");

    await page.locator("#notes-review-button").click();
    await expect(page.locator("#notes-review-panel")).toBeVisible();
    await expect.poll(() => loadedChunks).toContain("review-panel");

    await page.locator("[data-note-print]").click();
    await expect.poll(() => loadedChunks).toContain("print");
    expect(loadedChunks).not.toContain("collaboration");
});

test("collaboration runtime loads only for collaborative notes", async ({ page, baseURL }) => {
    const loadedChunks = [];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
        if (/notes-editor-collaboration\.js/.test(request.url())) loadedChunks.push("collaboration");
    });
    await page.route("**/notes-payload-harness", (route) => route.fulfill({
        contentType: "text/html",
        body: editorHarness(),
    }));
    await page.route("**/api/notes/audit-note", (route) => route.fulfill({
        json: { ...notePayload, collaboration_enabled: true },
    }));
    await page.route("**/api/notes/audit-note/collaboration-token", (route) => route.fulfill({
        status: 503,
        json: { error: "Intentional payload-test stop" },
    }));
    await page.goto(`${baseURL}/notes-payload-harness`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
        window.APStudyLoader = { html: (label) => `<span>${label}</span>` };
        window.APSTUDY_NOTE_CONTEXT = { noteId: "audit-note", access: { can_edit: true } };
    });
    await page.addScriptTag({ type: "module", url: `${baseURL}/static/js/notes/dist/notes-editor-v17.js` });

    await page.waitForTimeout(500);
    expect(pageErrors).toEqual([]);
    await expect.poll(() => loadedChunks).toContain("collaboration");
});
