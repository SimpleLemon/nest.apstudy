import { expect, test } from "playwright/test";

const spotifyUrl = "https://open.spotify.com/playlist/abc123";
const replacementSpotifyUrl = "https://open.spotify.com/playlist/xyz789";

async function installSpotifyEmbedFixture(page) {
    await page.route("https://open.spotify.com/**", (route) => {
        if (route.request().url().includes("/embed/iframe-api/v1")) {
            return route.fulfill({
                contentType: "application/javascript",
                body: `window.__spotifyFixture = { calls: [] };
                    window.onSpotifyIframeApiReady?.({ createController(element, options, callback) {
                        const iframe = document.createElement('iframe');
                        iframe.dataset.spotifyFixture = 'player';
                        element.replaceChildren(iframe);
                        callback({
                            destroy() { window.__spotifyFixture.calls.push('destroy'); iframe.remove(); },
                            loadEntity(url) { window.__spotifyFixture.calls.push('load:' + url); },
                            pause() { window.__spotifyFixture.calls.push('pause'); },
                            resume() { window.__spotifyFixture.calls.push('resume'); },
                        });
                    } });`,
            });
        }
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Spotify fixture</title>" });
    });
}

function focusFixture() {
    const nest = `<div class="focus-nest">${Array.from({ length: 8 }, (_, index) => `<span class="focus-nest-branch focus-nest-branch-${index + 1}"></span>`).join("")}</div>`;
    const egg = (live = false) => `<div class="focus-egg ${live ? "focus-egg-live" : "focus-egg-preview"}" ${live ? 'data-focus-egg data-egg-state="closed" data-crack-level="0" data-nest-stage="0"' : ""}><div class="focus-egg-aura"></div>${nest}<div class="focus-egg-figure"><div class="focus-egg-shell"></div></div>${live ? '<div class="focus-egg-book"><strong data-focus-egg-result></strong></div>' : ""}</div>`;
    return `<!doctype html><html data-theme="obsidian-dark"><head>
        <link rel="stylesheet" href="/static/css/themes.css">
        <link rel="stylesheet" href="/static/css/global.css">
        <link rel="stylesheet" href="/static/css/layout.css">
        <link rel="stylesheet" href="/static/css/focus.css">
    </head><body class="focus-body with-sidebar">
        <header class="navbar-container">Nest navigation</header>
        <nav class="sidebar-container"><button id="sidebar-toggle-handle">Toggle sidebar</button></nav>
        <main class="focus-main" aria-labelledby="focus-setup-title">
            <section data-focus-loading></section>
            <form class="focus-routine-form" data-focus-form>
                <section class="focus-setup" data-focus-setup hidden>
                    <header class="focus-setup-header"><div><h1 id="focus-setup-title">Set a focus timer</h1><p>Choose a length and begin.</p></div>
                        <button type="button" class="focus-button focus-button-secondary" data-focus-options-open aria-expanded="false">Session settings</button></header>
                    <label class="focus-routine-picker focus-field" data-focus-routine-picker hidden><span>Saved routine</span>
                        <select id="focus-routine-select" name="routine_id"><option value="">Custom timer</option></select></label>
                    <div class="focus-form-main"><div class="focus-setup-timer-shell"><svg class="focus-progress focus-setup-progress" viewBox="0 0 360 360"><circle class="focus-progress-track" cx="180" cy="180" r="158"></circle></svg><div class="focus-time-content focus-setup-time-content"><span class="focus-phase-label">Focus duration</span><label class="focus-duration-control"><input id="focus-minutes" name="focus_minutes" value="25"><span>min</span></label>${egg()}</div></div>
                        <div class="focus-preset-row"><button type="button" class="focus-choice" data-focus-preset data-focus="25" data-break="5" data-cycles="1">25 min</button><button type="button" class="focus-choice" data-focus-preset data-focus="50" data-break="10" data-cycles="1">50 min</button></div>
                        <p data-focus-form-status></p><button type="submit" class="focus-button focus-button-primary">Start focus</button></div>
                    <div data-focus-recent-selections hidden><div data-focus-recent-list></div></div>
                </section>
                <dialog class="focus-options-dialog" data-focus-options>
                    <header class="focus-options-header"><div><h2>Session settings</h2><p data-focus-options-description></p></div><button type="button" data-focus-options-close>Close</button></header>
                    <div class="focus-options-scroll">
                        <section data-focus-active-summary hidden><h3>Current session</h3><p data-focus-active-summary-copy></p></section>
                        <div data-focus-inactive-settings>
                            <section class="focus-options-group"><h3>Timer rhythm</h3><div class="focus-duration-row">
                                <label class="focus-field"><span>Cycles</span><input id="focus-cycles" name="cycles" value="1"></label>
                                <label class="focus-field" data-focus-break-field hidden><span>Break</span><input id="focus-break-minutes" name="break_minutes" value="0"></label>
                                <label class="focus-field" data-focus-long-break-field hidden><span>Long break</span><input id="focus-long-break-minutes" name="long_break_minutes" value="0"></label>
                            </div><div data-focus-suggestion-block hidden><div data-focus-break-suggestions></div></div>
                            <label data-focus-auto-start-row hidden><input id="focus-auto-start" name="auto_start_next" type="checkbox">Auto start</label></section>
                            <section class="focus-options-group"><label class="focus-field"><span>Routine name</span><input id="focus-routine-name" name="name"></label>
                                <button type="button" class="focus-button focus-button-primary" data-focus-save-routine>Save routine</button><button type="button" class="focus-button focus-button-danger" data-focus-delete-routine hidden>Delete routine</button><p data-focus-settings-status></p></section>
                        </div>
                        <section class="focus-options-group"><fieldset class="focus-layout-choices">
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="below" checked><span>Below</span></label>
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="beside"><span>Beside</span></label>
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="floating"><span>Floating</span></label>
                        </fieldset></section>
                    </div>
                </dialog>
                <section class="focus-session" data-focus-session hidden><header class="focus-session-toolbar"><button type="button" class="focus-button focus-button-secondary focus-exit-button" data-focus-end><span data-focus-exit-label>Exit</span></button><div data-focus-cycle-status><span data-focus-cycle-label></span><span data-focus-cycle-dots></span></div><button type="button" class="focus-icon-button" data-focus-session-options aria-expanded="false" aria-label="Session settings"><span class="material-symbols-outlined">tune</span></button></header>
                    <div class="focus-session-stage"><div class="focus-timer-shell"><svg class="focus-progress" viewBox="0 0 360 360"><circle class="focus-progress-track" cx="180" cy="180" r="158"></circle><circle class="focus-progress-value" data-focus-progress cx="180" cy="180" r="158"></circle></svg><div class="focus-time-content"><span class="focus-phase-label" data-focus-phase-label></span><time class="focus-time" data-focus-time></time><div class="focus-countdown" data-focus-countdown hidden></div>${egg(true)}</div></div>
                        <div class="focus-timer-actions"><button type="button" class="focus-button focus-button-primary" data-focus-toggle><span data-focus-toggle-label>Pause</span></button><button type="button" class="focus-button focus-button-secondary" data-focus-complete-phase><span data-focus-complete-phase-label>Finish focus</span></button></div><p class="focus-next-phase" data-focus-next-phase></p></div>
                </section>
                <section class="focus-soundtrack" data-focus-utilities hidden><div class="focus-region-heading"><div><h2>Playlist</h2><button type="button" data-focus-playlist-toggle aria-expanded="false">Add playlist</button></div><a data-focus-open-spotify hidden>Open in Spotify</a></div>
                    <div class="focus-playlist-form" data-focus-playlist-editor hidden><label class="focus-field"><span>Spotify playlist</span><input id="focus-spotify-url" name="spotify_url"></label><div class="focus-playlist-actions"><button type="button" class="focus-icon-button" data-focus-playlist-apply disabled><span data-focus-playlist-action>Add playlist</span></button><button type="button" class="focus-icon-button" data-focus-playlist-remove hidden>Remove</button></div></div>
                    <p data-focus-playlist-status></p><div class="focus-spotify-embed" data-focus-spotify-embed hidden></div></section>
            </form>
            <details data-focus-history-region hidden><summary>Recent sessions</summary><ol data-focus-history></ol></details>
            <div data-focus-announcer></div>
        </main>
    </body></html>`;
}

async function installFocusApi(page) {
    await page.evaluate(({ initialSpotifyUrl }) => {
        window.__focusTest = { calls: [], routines: [], history: [], recent: [], session: null, toasts: [] };
        window.APStudyToast = { show(options) { window.__focusTest.toasts.push(options); } };
        window.APStudyConfirm = { request: async () => true };
        window.APStudyProfileStatus = { setFocusMode() {} };
        window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = () => {};
        window.APSTUDY_SET_SIDEBAR_COLLAPSED = (collapsed) => {
            document.querySelector(".sidebar-container").classList.toggle("collapsed", collapsed);
            document.dispatchEvent(new CustomEvent("apstudy-sidebar-state-change", { detail: { collapsed } }));
        };
        const response = (payload) => ({ ok: true, json: async () => payload });
        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            const body = options.body ? JSON.parse(options.body) : {};
            window.__focusTest.calls.push({ url, method, body });
            if (url === "/api/focus" && method === "GET") return response({
                routines: window.__focusTest.routines,
                history: window.__focusTest.history,
                recent_selections: window.__focusTest.recent,
                active_session: window.__focusTest.session,
            });
            if (url === "/api/focus/routines" && method === "POST") {
                const routine = { id: "routine-1", ...body, spotify_url: body.spotify_url || null, spotify_embed_url: null };
                window.__focusTest.routines = [routine];
                return response({ routine });
            }
            if (url === "/api/focus/routines/routine-1" && method === "PATCH") {
                const routine = { id: "routine-1", ...body, spotify_url: body.spotify_url || null, spotify_embed_url: null };
                window.__focusTest.routines = [routine];
                return response({ routine });
            }
            if (url === "/api/focus/routines/routine-1" && method === "DELETE") {
                window.__focusTest.routines = [];
                return response({ deleted: true });
            }
            if (url === "/api/focus/sessions" && method === "POST") {
                window.__focusTest.session = {
                    id: "session-1", routine_name: body.name || "Custom focus",
                    focus_seconds: Number(body.focus_minutes) * 60, break_seconds: Number(body.break_minutes) * 60,
                    long_break_seconds: Number(body.long_break_minutes) * 60, total_cycles: Number(body.cycles),
                    completed_focus_cycles: 0, cycle_number: 1, phase: "focus", state: "running",
                    auto_start_next: false, remaining_seconds: Number(body.focus_minutes) * 60,
                    phase_duration_seconds: Number(body.focus_minutes) * 60,
                    spotify_url: body.spotify_url || initialSpotifyUrl || null,
                    spotify_embed_url: body.spotify_url ? `https://open.spotify.com/embed/playlist/${body.spotify_url.split("/").at(-1)}` : null,
                };
                return response({ session: window.__focusTest.session });
            }
            if (url === "/api/focus/sessions/session-1" && method === "PATCH") {
                if (body.action === "set_playlist") {
                    window.__focusTest.session.spotify_url = body.spotify_url || null;
                    window.__focusTest.session.spotify_embed_url = body.spotify_url
                        ? `https://open.spotify.com/embed/playlist/${body.spotify_url.split("/").at(-1)}` : null;
                    return response({ active: true, session: window.__focusTest.session });
                }
                if (body.action === "pause") window.__focusTest.session.state = "paused";
                if (body.action === "resume") window.__focusTest.session.state = "running";
                if (body.action === "complete_phase") {
                    window.__focusTest.history = [{ phase: "focus", duration_seconds: 1500, cycle_number: 1, completed_at: new Date().toISOString() }];
                    if (Number(window.__focusTest.session.total_cycles) === 1) {
                        const completed = { ...window.__focusTest.session, state: "completed", remaining_seconds: 0 };
                        window.__focusTest.session = null;
                        return response({ active: false, session: completed });
                    }
                    window.__focusTest.session = { ...window.__focusTest.session, phase: "break", state: "paused", completed_focus_cycles: 1, cycle_number: 2, remaining_seconds: 300, phase_duration_seconds: 300 };
                }
                if (body.action === "exit") {
                    window.__focusTest.session = null;
                    return response({ active: false, session: { state: "cancelled" } });
                }
                return response({ active: true, session: window.__focusTest.session });
            }
            throw new Error(`Unexpected request: ${method} ${url}`);
        };
    }, { initialSpotifyUrl: spotifyUrl });
}

test("focus setup stays stable, uses one playlist editor, and enters a clear active session", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?focus=${Date.now()}`));

    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-spotify-layout", "beside");
    await expect(page.locator("[data-focus-routine-picker]")).toBeHidden();
    await expect(page.locator("[data-focus-history-region]")).toBeHidden();
    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();

    const before = await page.locator("[data-focus-setup]").boundingBox();
    await page.getByRole("button", { name: "Session settings" }).first().click();
    await expect(page.locator("[data-focus-options]")).toBeVisible();
    const whileOpen = await page.locator("[data-focus-setup]").boundingBox();
    expect(whileOpen).toEqual(before);

    await page.locator("#focus-routine-name").fill("Reading");
    await page.getByRole("button", { name: "Save routine" }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("[data-focus-routine-picker]")).toBeVisible();
    await expect(page.locator("#focus-routine-select")).toHaveValue("routine-1");

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill("not-a-playlist");
    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();
    await expect(page.locator("#focus-spotify-url")).toHaveAttribute("aria-invalid", "true");
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await expect(page.locator("[data-focus-playlist-apply]")).toBeEnabled();
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-focus-playlist-action]")).toHaveText("Update playlist");
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.duration)).toBe(1000);

    await page.getByRole("button", { name: "Session settings" }).first().click();
    await page.locator("#focus-cycles").fill("2");
    await page.locator("#focus-break-minutes").fill("5");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-focus-session]")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/focus-session-active/);
    await expect(page.getByRole("button", { name: "Finish focus" })).toBeVisible();
    await expect(page.locator(".sidebar-container")).toHaveAttribute("inert", "");
    await expect.poll(() => page.evaluate(() => window.__spotifyFixture.calls.includes("resume"))).toBe(true);

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(replacementSpotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.at(-1)?.body.action)).toBe("set_playlist");

    await page.getByRole("button", { name: "Session settings" }).click();
    await expect(page.locator("[data-focus-active-summary]")).toBeVisible();
    await expect(page.locator("[data-focus-inactive-settings]")).toBeHidden();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Finish focus" }).click();
    await expect(page.locator("[data-focus-egg]")).toHaveAttribute("data-egg-state", "open");
    await expect(page.locator("[data-focus-egg]")).toHaveAttribute("data-nest-stage", "8");
    await expect(page.getByRole("button", { name: "Start break" })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: "Exit" }).click();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.locator("[data-focus-history-region]")).toBeVisible();
});

test("playlist removal is explicit and never treats an empty Add click as removal", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?playlist=${Date.now()}`));

    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await page.locator("[data-focus-playlist-toggle]").click();
    await expect(page.locator("[data-focus-playlist-remove]")).toBeVisible();
    await page.locator("[data-focus-playlist-remove]").click();
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();
});

test("a completed single timer stays in focus until the user exits and keeps its playlist", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?complete=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-focus-cycle-status]")).toBeHidden();
    await page.getByRole("button", { name: "Finish focus" }).click();

    await expect(page.locator("[data-focus-session]")).toBeVisible();
    await expect(page.locator("[data-focus-setup]")).toBeHidden();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__spotifyFixture.calls.at(-1))).toBe("pause");
    await expect(page.getByRole("button", { name: "Exit focus" })).toBeVisible();
    await expect(page.locator("[data-focus-toggle]")).toBeHidden();
    await page.getByRole("button", { name: "Exit focus" }).click();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
});

test("settings drawer and all player placements stay inside mobile, tablet, and laptop viewports", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/css/focus.css`);
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/static/css/focus.css"></head>
        <body class="focus-body focus-session-active" data-spotify-layout="beside"><main class="focus-main"><form class="focus-routine-form"><section class="focus-session"><div class="focus-session-stage"><div class="focus-timer-shell"></div></div></section><section class="focus-soundtrack"><div class="focus-playlist-form"><label class="focus-field"><span>Spotify playlist</span><input></label><button>Add playlist</button></div><iframe class="focus-spotify-embed"></iframe></section>
        <dialog class="focus-options-dialog" open><header class="focus-options-header"><h2>Session settings</h2></header><div class="focus-options-scroll"><div style="height:900px">Settings</div></div></dialog></form></main></body></html>`);

    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const drawer = await page.locator(".focus-options-dialog").boundingBox();
        expect(drawer).not.toBeNull();
        expect(drawer.x).toBeGreaterThanOrEqual(-1);
        expect(drawer.x + drawer.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(drawer.y + drawer.height).toBeLessThanOrEqual(viewport.height + 1);
    }
});
