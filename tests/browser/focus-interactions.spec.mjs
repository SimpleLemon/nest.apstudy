import { expect, test } from "playwright/test";

const spotifyUrl = "https://open.spotify.com/playlist/abc123";
const spotifyEmbedUrl = "https://open.spotify.com/embed/playlist/abc123?utm_source=generator&theme=0";

test("focus controls enter a distraction-free session and complete their API actions", async ({ page, baseURL }) => {
    await page.route("https://open.spotify.com/**", (route) => route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Spotify embed fixture</title>",
    }));
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(`<!doctype html><html><head>
        <link rel="stylesheet" href="/static/css/themes.css">
        <link rel="stylesheet" href="/static/css/global.css">
        <link rel="stylesheet" href="/static/css/layout.css">
        <link rel="stylesheet" href="/static/css/focus.css">
    </head><body class="focus-body with-sidebar">
        <header class="navbar-container">Nest navigation</header>
        <nav class="sidebar-container"><button id="sidebar-toggle-handle">Toggle sidebar</button></nav>
        <main class="focus-main">
            <header class="focus-page-header"><h1>Focus Mode</h1></header>
            <section data-focus-loading></section>
            <section data-focus-setup hidden>
                <form data-focus-form>
                    <input id="focus-minutes" name="focus_minutes" value="25">
                    <button type="button" data-focus-preset data-focus="25" data-break="5" data-cycles="1">25</button>
                    <button type="button" data-focus-preset data-focus="50" data-break="10" data-cycles="1">50</button>
                    <button type="submit">Start focus</button>
                    <p data-focus-form-status></p>
                    <details class="focus-options"><summary>Session options</summary>
                        <select id="focus-routine-select" name="routine_id"><option value="">Custom routine</option></select>
                        <input id="focus-routine-name" name="name">
                        <input id="focus-break-minutes" name="break_minutes" value="0">
                        <input id="focus-long-break-minutes" name="long_break_minutes" value="0">
                        <input id="focus-cycles" name="cycles" value="1">
                        <input id="focus-spotify-url" name="spotify_url">
                        <input id="focus-auto-start" name="auto_start_next" type="checkbox">
                        <div data-focus-break-suggestions></div>
                        <div data-focus-recent-selections hidden><div data-focus-recent-list></div></div>
                        <button type="button" data-focus-save-routine>Save routine</button>
                        <button type="button" data-focus-delete-routine hidden>Delete routine</button>
                    </details>
                </form>
            </section>
            <section data-focus-session hidden>
                <span data-focus-cycle-label></span><span data-focus-cycle-dots></span>
                <div class="focus-timer-shell">
                    <svg><circle data-focus-progress></circle></svg>
                    <time data-focus-time></time><span data-focus-phase-label></span>
                </div>
                <p data-focus-next-phase></p>
                <button type="button" data-focus-toggle><span data-focus-toggle-label>Pause</span></button>
                <button type="button" data-focus-complete-phase>Complete phase</button>
                <button type="button" data-focus-end>End session</button>
            </section>
            <section class="focus-utility-rail" data-focus-utilities hidden>
                <div class="focus-spotify-region">
                    <p data-focus-spotify-label></p><a data-focus-open-spotify hidden>Open Spotify</a>
                    <div data-focus-spotify-empty></div>
                    <iframe class="focus-spotify-embed" data-focus-spotify-embed hidden></iframe>
                </div>
                <details class="focus-history-region"><summary>Recent sessions</summary>
                    <ol data-focus-history></ol><div data-focus-history-empty></div>
                </details>
            </section>
            <div data-focus-announcer></div>
        </main>
    </body></html>`);

    await page.evaluate(({ spotifyUrlValue, spotifyEmbedUrlValue }) => {
        window.__focusTest = { calls: [], toasts: [], started: false, ended: false, phase: "focus", paused: false };
        window.APStudyToast = { show(options) { window.__focusTest.toasts.push(options); } };
        window.APStudyConfirm = { request: async () => true };
        window.APStudyProfileStatus = { setFocusMode(active) { document.body.classList.toggle("focus-mode-active", active); } };
        window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = () => {};
        window.APSTUDY_SET_SIDEBAR_COLLAPSED = (collapsed) => {
            document.querySelector(".sidebar-container").classList.toggle("collapsed", collapsed);
            document.dispatchEvent(new CustomEvent("apstudy-sidebar-state-change", { detail: { collapsed } }));
        };
        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            const body = options.body ? JSON.parse(options.body) : {};
            window.__focusTest.calls.push({ url, method, body });
            const ok = (payload) => ({ ok: true, json: async () => payload });
            if (url === "/api/focus" && method === "GET") {
                return ok({
                    routines: [],
                    history: [{ phase: "focus", duration_seconds: 1500, cycle_number: 1, completed_at: new Date().toISOString() }],
                    recent_selections: [{ focus_minutes: 30, break_minutes: 5, cycles: 1 }],
                    active_session: window.__focusTest.started && !window.__focusTest.ended
                        ? {
                            ...window.__focusSession,
                            phase: window.__focusTest.phase,
                            state: window.__focusTest.paused ? "paused" : "running",
                        }
                        : null,
                });
            }
            if (url === "/api/focus/routines" && method === "POST") {
                return ok({ routine: { id: "routine-1", name: body.name, ...body, spotify_url: null, spotify_embed_url: null } });
            }
            if (url === "/api/focus/routines/routine-1" && method === "DELETE") return ok({});
            if (url === "/api/focus/sessions" && method === "POST") {
                window.__focusTest.started = true;
                window.__focusSession = {
                    id: "session-1", routine_name: "Custom focus", focus_seconds: 1500,
                    break_seconds: 300, long_break_seconds: 300, total_cycles: 2,
                    completed_focus_cycles: 0, cycle_number: 1, phase: "focus", state: "running",
                    auto_start_next: false, remaining_seconds: 1500, phase_duration_seconds: 1500,
                    spotify_url: spotifyUrlValue, spotify_embed_url: spotifyEmbedUrlValue,
                };
                return ok({ session: window.__focusSession });
            }
            if (url === "/api/focus/sessions/session-1" && method === "PATCH") {
                if (body.action === "exit") {
                    window.__focusTest.ended = true;
                    return ok({ active: false });
                }
                if (body.action === "pause") window.__focusTest.paused = true;
                if (body.action === "resume") window.__focusTest.paused = false;
                if (body.action === "complete_phase") {
                    window.__focusTest.phase = "break";
                    window.__focusTest.paused = true;
                }
                const next = {
                    ...window.__focusSession,
                    phase: window.__focusTest.phase,
                    state: window.__focusTest.paused ? "paused" : "running",
                    remaining_seconds: window.__focusTest.phase === "break" ? 300 : 1500,
                    phase_duration_seconds: window.__focusTest.phase === "break" ? 300 : 1500,
                };
                return ok({ active: true, session: next });
            }
            throw new Error(`Unexpected request: ${method} ${url}`);
        };
    }, { spotifyUrlValue: spotifyUrl, spotifyEmbedUrlValue: spotifyEmbedUrl });

    await page.evaluate(() => import(`/static/js/focus/index.js?test=${Date.now()}`));
    await expect(page.locator("[data-focus-setup]")).toBeVisible();

    await page.getByRole("button", { name: "50" }).click();
    await expect(page.locator("#focus-minutes")).toHaveValue("50");
    await page.getByText("Session options").click();
    await page.locator("[data-focus-recent-list] button").click();
    await expect(page.locator("#focus-minutes")).toHaveValue("30");
    await page.getByRole("button", { name: "25" }).click();
    const suggestions = page.locator("[data-focus-break-suggestions] button");
    await expect(suggestions).toHaveCount(1);
    await suggestions.click();
    await expect(page.locator("#focus-break-minutes")).toHaveValue("5");

    await page.locator("#focus-routine-name").fill("Reading");
    await page.getByRole("button", { name: "Save routine" }).click();
    await expect(page.locator("#focus-routine-select")).toHaveValue("routine-1");
    await page.getByRole("button", { name: "Delete routine" }).click();
    await expect(page.locator("#focus-routine-select")).toHaveValue("");

    await page.locator("#focus-cycles").fill("2");
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-focus-session]")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/focus-session-active/);
    await expect(page.locator(".sidebar-container")).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".sidebar-container")).toHaveAttribute("inert", "");
    await expect(page.locator(".navbar-container")).toBeHidden();
    await expect(page.locator(".focus-page-header")).toBeHidden();
    await expect(page.locator(".focus-spotify-embed")).toBeVisible();
    await expect(page.locator(".focus-spotify-embed")).toHaveCSS("height", "352px");
    await expect(page.locator(".focus-history-region")).toBeHidden();

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.message)).toBe("Timer paused.");
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.getByRole("button", { name: "Complete phase" }).click();
    await expect(page.getByRole("button", { name: "Start break" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.message)).toBe("Focus complete. Your break is ready.");

    await page.getByRole("button", { name: "End session" }).click();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/focus-session-active/);
    await expect(page.locator(".sidebar-container")).not.toHaveAttribute("inert", "");
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.message)).toBe("Session ended. Completed phases remain in your history.");

    const actions = await page.evaluate(() => window.__focusTest.calls
        .filter((call) => call.url.includes("/api/focus/sessions/session-1"))
        .map((call) => call.body.action));
    expect(actions).toEqual(["pause", "resume", "complete_phase", "exit"]);
});

test("timer expiry announces focus completion, break completion, and routine completion", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(`<!doctype html><html><head>
        <link rel="stylesheet" href="/static/css/themes.css">
        <link rel="stylesheet" href="/static/css/focus.css">
    </head><body class="focus-body">
        <main class="focus-main">
            <section data-focus-loading></section>
            <section data-focus-setup hidden>
                <form data-focus-form>
                    <input id="focus-minutes" name="focus_minutes" value="1">
                    <button type="submit">Start focus</button>
                    <p data-focus-form-status></p>
                    <details class="focus-options"><summary>Session options</summary>
                        <select id="focus-routine-select" name="routine_id"><option value="">Custom routine</option></select>
                        <input id="focus-routine-name" name="name">
                        <input id="focus-break-minutes" name="break_minutes" value="1">
                        <input id="focus-long-break-minutes" name="long_break_minutes" value="1">
                        <input id="focus-cycles" name="cycles" value="2">
                        <input id="focus-spotify-url" name="spotify_url">
                        <input id="focus-auto-start" name="auto_start_next" type="checkbox" checked>
                        <div data-focus-break-suggestions></div>
                        <div data-focus-recent-selections hidden><div data-focus-recent-list></div></div>
                        <button type="button" data-focus-save-routine>Save routine</button>
                        <button type="button" data-focus-delete-routine hidden>Delete routine</button>
                    </details>
                </form>
            </section>
            <section data-focus-session hidden>
                <span data-focus-cycle-label></span><span data-focus-cycle-dots></span>
                <div class="focus-timer-shell"><svg><circle data-focus-progress></circle></svg><time data-focus-time></time><span data-focus-phase-label></span></div>
                <p data-focus-next-phase></p>
                <button type="button" data-focus-toggle><span data-focus-toggle-label>Pause</span></button>
                <button type="button" data-focus-complete-phase>Complete phase</button>
                <button type="button" data-focus-end>End session</button>
            </section>
            <section class="focus-utility-rail" data-focus-utilities hidden>
                <div class="focus-spotify-region"><p data-focus-spotify-label></p><a data-focus-open-spotify hidden>Open Spotify</a><div data-focus-spotify-empty></div><iframe data-focus-spotify-embed hidden></iframe></div>
                <details class="focus-history-region"><summary>Recent sessions</summary><ol data-focus-history></ol><div data-focus-history-empty></div></details>
            </section>
            <div data-focus-announcer></div>
        </main>
    </body></html>`);

    await page.evaluate(() => {
        window.__expiryTest = { calls: [], toasts: [], started: false, ended: false, expired: false, phase: "focus", completedCycles: 0 };
        window.APStudyToast = { show(options) { window.__expiryTest.toasts.push(options); } };
        window.APStudyProfileStatus = { setFocusMode() {} };
        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            const body = options.body ? JSON.parse(options.body) : {};
            window.__expiryTest.calls.push({ url, method, body });
            const ok = (payload) => ({ ok: true, json: async () => payload });
            if (url === "/api/focus" && method === "GET") {
                return ok({
                    routines: [], history: [], recent_selections: [],
                    active_session: window.__expiryTest.started && !window.__expiryTest.ended ? {
                        id: "expiry-session", phase: window.__expiryTest.phase,
                        state: "running", focus_seconds: 60, break_seconds: 60, long_break_seconds: 60,
                        total_cycles: 2, completed_focus_cycles: window.__expiryTest.completedCycles,
                        cycle_number: window.__expiryTest.completedCycles + 1,
                        auto_start_next: true,
                        remaining_seconds: window.__expiryTest.expired ? 0 : 60,
                        phase_duration_seconds: 60,
                    } : null,
                });
            }
            if (url === "/api/focus/sessions" && method === "POST") {
                window.__expiryTest.started = true;
                window.__expiryTest.expired = false;
                return ok({ session: {
                    id: "expiry-session", phase: "focus", state: "running", focus_seconds: 60,
                    break_seconds: 60, long_break_seconds: 60, total_cycles: 2, completed_focus_cycles: 0,
                    cycle_number: 1, auto_start_next: true, remaining_seconds: 60, phase_duration_seconds: 60,
                } });
            }
            if (url === "/api/focus/sessions/expiry-session" && method === "PATCH" && body.action === "advance") {
                if (window.__expiryTest.phase === "focus") {
                    if (window.__expiryTest.completedCycles >= 1) {
                        window.__expiryTest.ended = true;
                        return ok({ active: false });
                    }
                    window.__expiryTest.phase = "break";
                    window.__expiryTest.completedCycles = 1;
                } else {
                    window.__expiryTest.phase = "focus";
                }
                window.__expiryTest.expired = false;
                return ok({ active: true, session: {
                    id: "expiry-session", phase: window.__expiryTest.phase, state: "running",
                    focus_seconds: 60, break_seconds: 60, long_break_seconds: 60, total_cycles: 2,
                    completed_focus_cycles: window.__expiryTest.completedCycles,
                    cycle_number: window.__expiryTest.completedCycles + 1, auto_start_next: true,
                    remaining_seconds: 60, phase_duration_seconds: 60,
                } });
            }
            throw new Error(`Unexpected request: ${method} ${url}`);
        };
    });

    await page.evaluate(() => import(`/static/js/focus/index.js?expiry=${Date.now()}`));
    await expect(page.getByRole("button", { name: "Start focus", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start focus", exact: true }).click();
    await expect(page.locator("[data-focus-phase-label]")).toHaveText("Focus session");

    await page.evaluate(() => {
        window.__expiryTest.expired = true;
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("[data-focus-phase-label]")).toHaveText("Break");
    await expect.poll(() => page.evaluate(() => window.__expiryTest.toasts.at(-1)?.message)).toBe("Focus complete. Break started.");

    await page.evaluate(() => {
        window.__expiryTest.expired = true;
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("[data-focus-phase-label]")).toHaveText("Focus session");
    await expect.poll(() => page.evaluate(() => window.__expiryTest.toasts.at(-1)?.message)).toBe("Break complete. Focus started.");

    await page.evaluate(() => {
        window.__expiryTest.expired = true;
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__expiryTest.toasts.at(-1)?.message)).toBe("Focus routine complete.");
});

test("a running focus without Spotify removes all secondary content", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/css/focus.css`);
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="/static/css/focus.css"></head>
        <body class="focus-body focus-session-active"><main><section class="focus-session">Timer</section>
        <section class="focus-utility-rail" hidden></section></main></body></html>`);
    await expect(page.locator(".focus-session")).toBeVisible();
    await expect(page.locator(".focus-utility-rail")).toBeHidden();
});
