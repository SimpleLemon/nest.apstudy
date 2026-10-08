import { expect, test } from "playwright/test";
import { createNotesCollaborationFixture, installNotesLifecycleObservation } from '../js/helpers/notes-editor-lifecycle.mjs';

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

test('compiled editor retains local content across pause/resume and releases subscriptions on final disposal', async ({ page, baseURL }) => {
    const peer = await createNotesCollaborationFixture({ blocks: JSON.parse(notePayload.content), title: notePayload.title });
    const errors = [];
    let admissions = 0;
    let commentLoads = 0;
    let remoteBody = 'Original comment';
    let heldCommentRequest = null;
    let holdCommentLoad = false;
    let heldReplyRequest = null;
    const access = { role: 'owner', can_view: true, can_edit: true, can_review: true, can_manage_reviews: true };
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.context().grantPermissions(['local-network-access'], { origin: baseURL });
        await page.addInitScript(({ websocketUrl }) => {
            const NativeWebSocket = window.WebSocket;
            window.WebSocket = class extends NativeWebSocket {
                constructor(url, protocols) {
                    super(new URL(url).pathname === '/ws/notes' ? websocketUrl : url, protocols);
                }
            };
        }, { websocketUrl: peer.url });
        await page.route('**/notes-lifecycle-harness', (route) => route.fulfill({ contentType: 'text/html', body: editorHarness() }));
        await page.route('**/api/notes/audit-note', (route) => route.fulfill({
            json: { ...notePayload, collaboration_enabled: true, access },
            headers: { 'X-Nest-Document-Generation': 'initial' },
        }));
        await page.route('**/api/notes/audit-note/collaboration-token', (route) => {
            admissions++;
            return route.fulfill({ json: {
                token: `ticket-${admissions}`, document_generation: 'initial', access,
                user: { id: 'fixture-user', name: 'Fixture editor' }, awareness_allowed: true,
            } });
        });
        const commentsPayload = () => ({ threads: [{ id: 'thread', body: remoteBody, status: 'open', replies: [] }] });
        await page.route('**/api/notes/audit-note/comments', (route) => {
            commentLoads++;
            if (commentLoads === 2 || holdCommentLoad) { heldCommentRequest = route; return; }
            return route.fulfill({ json: commentsPayload() });
        });
        await page.route('**/api/notes/audit-note/comments/thread/replies', (route) => { heldReplyRequest = route; });
        await page.goto(`${baseURL}/notes-lifecycle-harness`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(installNotesLifecycleObservation);
        await page.evaluate((access) => {
            window.APStudyLoader = { html: (label) => `<span>${label}</span>` };
            window.APSTUDY_NOTE_CONTEXT = { noteId: 'audit-note', access };
        }, access);
        await page.addScriptTag({ type: 'module', url: `${baseURL}/static/js/notes/dist/notes-editor-v17.js` });
        await expect(page.locator('.bn-editor')).toBeVisible();
        await expect(page.locator('#note-title-input')).toBeEditable();
        await expect.poll(() => peer.connections()).toBe(1);
        expect(admissions).toBe(1);
        await page.locator('#note-title-input').fill('Retained local title');
        await page.locator('.bn-editor').press('ControlOrMeta+End');
        await page.locator('.bn-editor').press('End');
        await page.locator('.bn-editor').pressSequentially(' retained body');
        await expect(page.locator('.bn-editor')).toContainText('retained body');
        await page.evaluate(() => { window.retainedEditor = document.querySelector('.bn-editor'); window.notesLifecycle.pause(); });
        await expect.poll(() => peer.connections()).toBe(0);
        await expect(page.locator('#note-title-input')).toHaveValue('Retained local title');
        await expect(page.locator('.bn-editor')).toContainText('retained body');
        expect(await page.evaluate(() => document.querySelector('.bn-editor') === window.retainedEditor)).toBe(true);
        await expect(page.locator('#note-title-input')).not.toBeEditable();
        await page.evaluate(() => window.notesLifecycle.resume());
        await expect.poll(() => admissions).toBe(2);
        await expect(page.locator('#note-title-input')).toBeEditable();
        await expect.poll(() => peer.connections()).toBe(1);
        expect(await page.evaluate(() => document.querySelector('.bn-editor') === window.retainedEditor)).toBe(true);
        await expect(page.locator('.bn-editor')).toContainText('retained body');

        await page.locator('#notes-review-button').click();
        await expect(page.locator('[data-comment-id="thread"]')).toContainText('Original comment');
        const reply = page.locator('[data-comment-reply="thread"] input');
        await reply.fill('Unsent reply survives remote activity');
        await reply.evaluate((input) => input.setSelectionRange(3, 8));
        peer.broadcast({ type: 'review.comment.created' });
        await expect.poll(() => commentLoads).toBe(2);
        for (let index = 0; index < 10; index++) peer.broadcast({ type: 'review.comment.replied' });
        // A browser task ensures the provider consumes the entire event burst.
        await page.waitForTimeout(100);
        expect(commentLoads).toBe(2);
        remoteBody = 'Updated by a collaborator';
        await heldCommentRequest.fulfill({ json: commentsPayload() });
        await expect.poll(() => commentLoads).toBe(3);
        await expect(page.locator('[data-comment-id="thread"]')).toContainText(remoteBody);
        await expect(reply).toHaveValue('Unsent reply survives remote activity');
        expect(await reply.evaluate((input) => [document.activeElement === input, input.selectionStart, input.selectionEnd])).toEqual([true, 3, 8]);

        await page.locator('[data-comment-reply="thread"] button').click();
        await expect.poll(() => heldReplyRequest !== null).toBe(true);
        peer.broadcast({ type: 'review.comment.replied' });
        await expect.poll(() => commentLoads).toBe(4);
        await expect(reply).toHaveValue('Unsent reply survives remote activity');
        await heldReplyRequest.fulfill({ json: {} });
        await expect.poll(() => commentLoads).toBe(5);
        await expect(reply).toHaveValue('');

        heldReplyRequest = null;
        await reply.fill('Submitted reply');
        await page.locator('[data-comment-reply="thread"] button').click();
        await expect.poll(() => heldReplyRequest !== null).toBe(true);
        await reply.fill('Next draft typed while sending');
        await heldReplyRequest.fulfill({ json: {} });
        await expect.poll(() => commentLoads).toBe(6);
        await expect(reply).toHaveValue('Next draft typed while sending');

        holdCommentLoad = true;
        peer.broadcast({ type: 'review.comment.updated' });
        await expect.poll(() => commentLoads).toBe(7);

        const before = await page.evaluate(() => window.notesSubscriptions());
        expect(before['note-title-input:input']).toBeGreaterThan(0);
        expect(before['window:resize']).toBeGreaterThan(0);
        await page.evaluate(() => { window.notesLifecycle.dispose(); window.notesLifecycle.dispose(); window.notesLifecycle.resume(); });
        await heldCommentRequest.fulfill({ json: commentsPayload() });
        await expect(page.locator('.bn-editor')).toHaveCount(0);
        await expect.poll(() => peer.connections()).toBe(0);
        const after = await page.evaluate(() => window.notesSubscriptions());
        expect(after['note-title-input:input']).toBe(0);
        for (const count of Object.values(after)) expect(count).toBe(0);
        expect(admissions).toBe(2);
        peer.broadcast({ type: 'review.comment.created' });
        await page.locator('#notes-review-button').click();
        expect(commentLoads).toBe(7);
        await expect(page.locator('#notes-review-panel')).toBeHidden();
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        await peer.dispose();
    }
});
