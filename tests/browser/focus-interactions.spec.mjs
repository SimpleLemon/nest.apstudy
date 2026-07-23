import { expect, test } from "playwright/test";

const spotifyUrl = "https://open.spotify.com/playlist/abc123";
const replacementSpotifyUrl = "https://open.spotify.com/playlist/xyz789";
const thirdSpotifyUrl = "https://open.spotify.com/playlist/def456";

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
        <main class="focus-main" aria-label="Focus Mode">
            <section data-focus-loading></section>
            <form class="focus-routine-form" data-focus-form>
                <section class="focus-setup" data-focus-setup hidden>
                    <header class="focus-setup-header focus-setup-header-actions"><h1 id="focus-setup-title" class="sr-only">Focus Mode</h1>
                        <button type="button" class="focus-icon-button focus-settings-trigger" data-focus-options-open aria-expanded="false" aria-label="Focus Settings"><span class="material-symbols-outlined" aria-hidden="true">tune</span></button></header>
                    <div class="focus-form-main"><div class="focus-setup-timer-shell"><svg class="focus-progress focus-setup-progress" viewBox="0 0 360 360"><circle class="focus-progress-track" cx="180" cy="180" r="158"></circle></svg><div class="focus-time-content focus-setup-time-content"><span class="focus-phase-label">Focus duration</span><label class="focus-duration-control"><input id="focus-minutes" name="focus_minutes" value="25"><span>min</span></label>${egg()}</div></div>
                        <div class="focus-preset-row" data-focus-recent-list></div>
                        <button type="submit" class="focus-button focus-button-primary">Start focus</button></div>
                </section>
                <dialog class="focus-options-dialog" data-focus-options>
                    <header class="focus-options-header"><div><h2>Focus Settings</h2></div><button type="button" data-focus-options-close>Close</button></header>
                    <div class="focus-options-scroll">
                        <section data-focus-active-summary hidden><h3>Current session</h3><p data-focus-active-summary-copy></p></section>
                        <div data-focus-inactive-settings>
                            <section class="focus-options-group focus-routine-editor" data-focus-routine-picker><h3>Focus setup</h3>
                                <div class="focus-field focus-routine-setup-field">
                                    <span class="focus-field-label">Saved setup</span>
                                    <div class="focus-combobox" data-focus-routine-combobox>
                                        <input type="hidden" id="focus-routine-select" name="routine_id" value="" />
                                        <button type="button" class="focus-combobox-trigger" data-focus-combobox-trigger role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-controls="focus-routine-listbox">
                                            <span data-focus-combobox-label class="focus-combobox-placeholder">Select setup</span>
                                            <svg class="focus-combobox-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg>
                                        </button>
                                        <div id="focus-routine-listbox" class="focus-combobox-menu" data-focus-combobox-menu role="listbox" hidden>
                                            <div class="focus-combobox-list" data-focus-combobox-list></div>
                                        </div>
                                    </div>
                                </div>
                                <div class="focus-routine-create" data-focus-routine-create hidden>
                                    <label class="focus-field focus-routine-name-field" for="focus-routine-name">
                                        <span>Setup name</span>
                                        <div class="focus-routine-name-row">
                                            <input id="focus-routine-name" name="name" value="Default">
                                            <button type="button" class="focus-button focus-button-primary focus-routine-save" data-focus-save-routine><span data-focus-save-routine-label>Save setup</span></button>
                                        </div>
                                    </label>
                                </div>
                                <div class="focus-routine-existing-actions" data-focus-routine-existing-actions hidden>
                                    <button type="button" class="focus-button focus-button-primary focus-routine-save" data-focus-save-routine><span data-focus-save-routine-label>Save changes</span></button>
                                    <button type="button" class="focus-button focus-button-danger focus-routine-delete" data-focus-delete-routine>Delete setup</button>
                                </div>
                                <p data-focus-settings-status></p></section>
                            <section class="focus-options-group"><h3>Timer rhythm</h3><div class="focus-duration-row">
                                <label class="focus-field"><span>Cycles</span><input id="focus-cycles" name="cycles" value="1"></label>
                                <label class="focus-field" data-focus-break-field hidden><span>Break</span><input id="focus-break-minutes" name="break_minutes" value="0"></label>
                                <label class="focus-field" data-focus-long-break-field hidden><span>Long break</span><input id="focus-long-break-minutes" name="long_break_minutes" value="0"></label>
                            </div><div data-focus-suggestion-block hidden><div data-focus-break-suggestions></div></div>
                            <label data-focus-auto-start-row hidden><input id="focus-auto-start" name="auto_start_next" type="checkbox">Auto start</label></section>
                        </div>
                        <section class="focus-options-group"><fieldset class="focus-layout-choices">
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="below" checked><span>Below</span></label>
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="beside"><span>Beside</span></label>
                            <label class="focus-layout-choice"><input type="radio" name="spotify_layout" value="floating"><span>Floating</span></label>
                        </fieldset></section>
                    </div>
                </dialog>
                <section class="focus-session" data-focus-session hidden><header class="focus-session-toolbar"><button type="button" class="focus-button focus-button-secondary focus-exit-button" data-focus-end><span data-focus-exit-label>Exit</span></button></header>
                    <div class="focus-session-stage"><div class="focus-session-controls"><div data-focus-cycle-status><span data-focus-cycle-label></span><span data-focus-cycle-dots></span></div><button type="button" class="focus-icon-button focus-session-settings-trigger" data-focus-session-options aria-expanded="false" aria-label="Focus Settings"><span class="material-symbols-outlined">tune</span></button></div><div class="focus-timer-shell"><svg class="focus-progress" viewBox="0 0 360 360"><circle class="focus-progress-track" cx="180" cy="180" r="158"></circle><circle class="focus-progress-value" data-focus-progress cx="180" cy="180" r="158"></circle></svg><div class="focus-time-content"><span class="focus-phase-label" data-focus-phase-label></span><time class="focus-time" data-focus-time></time><div class="focus-countdown" data-focus-countdown hidden></div>${egg(true)}</div></div>
                        <div class="focus-timer-actions"><button type="button" class="focus-button focus-button-primary" data-focus-toggle><span data-focus-toggle-label>Pause</span></button><button type="button" class="focus-button focus-button-secondary" data-focus-complete-phase><span data-focus-complete-phase-label>Finish focus</span></button></div><p class="focus-next-phase" data-focus-next-phase></p></div>
                </section>
                <section class="focus-soundtrack" data-focus-utilities hidden><div class="focus-region-heading"><div><h2>Music</h2></div><div class="focus-floating-controls" data-focus-floating-controls><button type="button" data-focus-floating-handle aria-label="Move playlist player">Move</button><button type="button" data-focus-floating-size aria-label="Expand playlist player"><svg class="focus-expand-icon"></svg><svg class="focus-collapse-icon"></svg></button></div></div>
                    <div class="focus-player-frame" data-focus-player-frame><div class="focus-spotify-embed" data-focus-spotify-embed hidden></div><button type="button" class="focus-player-remove" data-focus-playlist-remove hidden aria-label="Remove active playlist">Remove</button></div><ul class="focus-playlist-list" data-focus-playlist-list></ul>
                    <div class="focus-playlist-composer" data-focus-playlist-composer><button type="button" class="focus-playlist-toggle" data-focus-playlist-toggle aria-expanded="false" aria-label="Add playlist"><span class="focus-provider-mark is-spotify"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M7 9.2c3.7-1 7.5-.7 10.6.9"></path></svg></span><svg class="focus-playlist-add-icon" viewBox="0 0 24 24"><path class="focus-playlist-add-vertical" d="M12 5v14"></path><path d="M5 12h14"></path></svg><span class="focus-provider-mark is-youtube"><svg viewBox="0 0 24 24"><path d="M21 8.1a3 3 0 0 0-2.1-2.1C17 5.5 12 5.5 12 5.5S7 5.5 5.1 6A3 3 0 0 0 3 8.1v7.8A3 3 0 0 0 5.1 18h13.8a3 3 0 0 0 2.1-2.1Z"></path><path d="m10 9 5 3-5 3V9Z"></path></svg></span></button>
                    <div class="focus-playlist-editor" data-focus-playlist-editor hidden><label><span>Playlist URL</span><input id="focus-spotify-url" placeholder="Paste a Spotify, YouTube, or YouTube Music playlist"></label><button type="button" class="focus-playlist-apply" data-focus-playlist-apply hidden disabled><span class="focus-playlist-submit-logo" data-focus-playlist-submit-logo data-provider="" aria-hidden="true"></span><svg class="focus-inline-icon focus-playlist-submit-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4L19 7"></path></svg><span data-focus-playlist-action>Add playlist</span></button></div></div>
                    <input type="hidden" name="spotify_url" value="" data-focus-active-playlist-url><input type="hidden" name="spotify_playlists" value="[]" data-focus-playlist-data><p data-focus-playlist-status></p><button type="button" class="focus-panel-resize-handle" data-focus-panel-resize aria-label="Resize music panel"><svg viewBox="0 0 24 24"><path d="M19 9 9 19M19 14l-5 5M19 4 4 19"></path></svg></button></section>
            </form>
            <details data-focus-history-region hidden><summary>Recent sessions</summary><ol data-focus-history></ol></details>
            <div data-focus-announcer></div>
        </main>
    </body></html>`;
}

async function installFocusApi(page) {
    await page.evaluate(({ initialSpotifyUrl }) => {
        const playlistFixtureMeta = (url) => {
            const id = url.includes("list=") ? url.split("list=").pop() : url.split("/").at(-1);
            const isAbc = url.includes("abc123");
            const isXyz = url.includes("xyz789");
            const title = isAbc ? "Deep Focus" : isXyz ? "Reading Flow" : "Study Mix";
            const creator = isAbc ? "Nest listener" : isXyz ? "Study Club" : "Focus Lab";
            const provider = url.includes("music.youtube") ? "youtube_music" : url.includes("youtube") ? "youtube" : "spotify";
            const embedUrl = provider === "spotify"
                ? `https://open.spotify.com/embed/playlist/${id}`
                : `https://www.youtube-nocookie.com/embed/videoseries?list=${id}`;
            return {
                spotify_url: url,
                spotify_embed_url: embedUrl,
                embed_url: embedUrl,
                title,
                creator,
                thumbnail_url: `https://i.scdn.co/image/${id}`,
                provider,
            };
        };
        const libraryFixtureResponse = (test) => {
            const activeUrl = test.activePlaylistUrl || test.userPlaylists[0]?.spotify_url || null;
            const playlists = test.userPlaylists.map((playlist) => ({
                ...playlist,
                active: playlist.spotify_url === activeUrl,
            }));
            return {
                spotify_url: activeUrl,
                playlists,
                playlist_entitlements: {
                    limit: test.playlistLimit,
                    usage: test.userPlaylists.length,
                },
            };
        };
        window.__focusTest = {
            calls: [],
            routines: [],
            history: [],
            recent: [],
            session: null,
            toasts: [],
            userPlaylists: [],
            activePlaylistUrl: null,
            playlistLimit: null,
            playerPreferences: { layout: "beside", floating_size: "compact", floating_x: 1, floating_y: 1, panel_width: 0, panel_height: 0 },
        };
        window.__focusTestHelpers = { playlistFixtureMeta, libraryFixtureResponse };
        window.APStudyToast = { show(options) { window.__focusTest.toasts.push(options); } };
        window.APStudyConfirm = { request: async () => true };
        window.APStudyProfileStatus = { setFocusMode() {} };
        window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = () => {};
        window.APSTUDY_SET_SIDEBAR_COLLAPSED = (collapsed) => {
            document.querySelector(".sidebar-container").classList.toggle("collapsed", collapsed);
            document.dispatchEvent(new CustomEvent("apstudy-sidebar-state-change", { detail: { collapsed } }));
        };
        const response = (payload, ok = true) => ({ ok, json: async () => payload });
        const libraryResponse = () => window.__focusTestHelpers.libraryFixtureResponse(window.__focusTest);
        const syncSessionPlaylists = () => {
            if (!window.__focusTest.session) return;
            const library = libraryResponse();
            window.__focusTest.session.spotify_url = library.spotify_url;
            window.__focusTest.session.spotify_embed_url = library.spotify_url
                ? `https://open.spotify.com/embed/playlist/${library.spotify_url.split("/").at(-1)}`
                : null;
            window.__focusTest.session.playlists = library.playlists;
        };
        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            const body = options.body ? JSON.parse(options.body) : {};
            window.__focusTest.calls.push({ url, method, body });
            if (url === "/api/focus" && method === "GET") {
                const library = libraryResponse();
                return response({
                    routines: window.__focusTest.routines,
                    history: window.__focusTest.history,
                    recent_selections: window.__focusTest.recent,
                    active_session: window.__focusTest.session,
                    player_preferences: window.__focusTest.playerPreferences,
                    playlists: library.playlists,
                    active_playlist_url: library.spotify_url,
                    playlist_entitlements: library.playlist_entitlements,
                });
            }
            if (url === "/api/focus/player-preferences" && method === "PATCH") {
                window.__focusTest.playerPreferences = body;
                return response({ player_preferences: body });
            }
            if (url === "/api/focus/playlists/preview" && method === "POST") {
                const playlistUrl = body.spotify_url || body.playlist_url;
                return response({ playlist: window.__focusTestHelpers.playlistFixtureMeta(playlistUrl) });
            }
            if (url === "/api/focus/playlists" && method === "POST") {
                const playlistUrl = body.spotify_url || body.playlist_url;
                const exists = window.__focusTest.userPlaylists.some((item) => item.spotify_url === playlistUrl);
                if (!exists) {
                    if (window.__focusTest.playlistLimit != null
                        && window.__focusTest.userPlaylists.length >= window.__focusTest.playlistLimit) {
                        return response({
                            error: `Your focus playlists limit is ${window.__focusTest.playlistLimit}; current usage is ${window.__focusTest.userPlaylists.length} and this action would use 1.`,
                            code: "tier_limit",
                            resource: "focus_playlists",
                            limit: window.__focusTest.playlistLimit,
                            current: window.__focusTest.userPlaylists.length,
                            requested: 1,
                        }, false);
                    }
                    window.__focusTest.userPlaylists.push(window.__focusTestHelpers.playlistFixtureMeta(playlistUrl));
                    if (!window.__focusTest.activePlaylistUrl) window.__focusTest.activePlaylistUrl = playlistUrl;
                }
                syncSessionPlaylists();
                return response(libraryResponse());
            }
            if (url === "/api/focus/playlists" && method === "DELETE") {
                const playlistUrl = body.spotify_url || body.playlist_url;
                window.__focusTest.userPlaylists = window.__focusTest.userPlaylists
                    .filter((item) => item.spotify_url !== playlistUrl);
                if (window.__focusTest.activePlaylistUrl === playlistUrl) {
                    window.__focusTest.activePlaylistUrl = window.__focusTest.userPlaylists[0]?.spotify_url || null;
                }
                syncSessionPlaylists();
                return response(libraryResponse());
            }
            if (url === "/api/focus/playlists/active" && method === "PATCH") {
                const playlistUrl = body.spotify_url || body.playlist_url;
                window.__focusTest.activePlaylistUrl = playlistUrl;
                syncSessionPlaylists();
                return response(libraryResponse());
            }
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
                const library = libraryResponse();
                const activeUrl = body.spotify_url || library.spotify_url || initialSpotifyUrl || null;
                window.__focusTest.session = {
                    id: "session-1", routine_name: body.name || "Custom focus",
                    focus_seconds: Number(body.focus_minutes) * 60, break_seconds: Number(body.break_minutes) * 60,
                    long_break_seconds: Number(body.long_break_minutes) * 60, total_cycles: Number(body.cycles),
                    completed_focus_cycles: 0, cycle_number: 1, phase: "focus", state: "running",
                    auto_start_next: false, remaining_seconds: Number(body.focus_minutes) * 60,
                    phase_duration_seconds: Number(body.focus_minutes) * 60,
                    spotify_url: activeUrl,
                    spotify_embed_url: activeUrl
                        ? `https://open.spotify.com/embed/playlist/${activeUrl.split("/").at(-1)}`
                        : null,
                    playlists: library.playlists,
                };
                return response({ session: window.__focusTest.session });
            }
            if (url === "/api/focus/sessions/session-1" && method === "PATCH") {
                if (body.action === "set_playlist") {
                    if (body.spotify_url) {
                        const exists = window.__focusTest.userPlaylists
                            .some((item) => item.spotify_url === body.spotify_url);
                        if (!exists) {
                            window.__focusTest.userPlaylists.push(
                                window.__focusTestHelpers.playlistFixtureMeta(body.spotify_url),
                            );
                        }
                        window.__focusTest.activePlaylistUrl = body.spotify_url;
                    } else {
                        window.__focusTest.activePlaylistUrl = null;
                    }
                    syncSessionPlaylists();
                    return response({ active: true, session: window.__focusTest.session });
                }
                if (body.action === "remove_playlist") {
                    window.__focusTest.userPlaylists = window.__focusTest.userPlaylists
                        .filter((item) => item.spotify_url !== body.spotify_url);
                    if (window.__focusTest.activePlaylistUrl === body.spotify_url) {
                        window.__focusTest.activePlaylistUrl = window.__focusTest.userPlaylists[0]?.spotify_url || null;
                    }
                    syncSessionPlaylists();
                    return response({ active: true, session: window.__focusTest.session });
                }
                if (body.action === "restore_playlist") {
                    if (body.spotify_url) {
                        const exists = window.__focusTest.userPlaylists
                            .some((item) => item.spotify_url === body.spotify_url);
                        if (!exists) {
                            window.__focusTest.userPlaylists.push(
                                window.__focusTestHelpers.playlistFixtureMeta(body.spotify_url),
                            );
                        }
                    }
                    window.__focusTest.activePlaylistUrl = body.active_spotify_url
                        || body.spotify_url
                        || window.__focusTest.activePlaylistUrl;
                    syncSessionPlaylists();
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
    await page.evaluate(() => {
        window.__focusTest.recent = [
            { focus_minutes: 35, break_minutes: 7, cycles: 1 },
            { focus_minutes: 60, break_minutes: 10, cycles: 1 },
            { focus_minutes: 20, break_minutes: 5, cycles: 1 },
        ];
    });
    await page.evaluate(() => import(`/static/js/focus/index.js?focus=${Date.now()}`));

    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-spotify-layout", "beside");
    await expect(page.locator("[data-focus-routine-picker]")).toBeHidden();
    await expect(page.locator("#focus-routine-name")).toHaveValue("Default");
    await expect(page.locator("[data-focus-history-region]")).toBeHidden();
    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();
    await expect(page.locator("[data-focus-recent-list] .focus-choice")).toHaveText([
        "35 / 7 min", "60 / 10 min", "25 min", "50 min", "90 min",
    ]);
    await page.getByRole("button", { name: "Set 35 / 7 minutes" }).click();
    await expect(page.locator("#focus-minutes")).toHaveValue("35");
    await expect(page.locator("#focus-break-minutes")).toHaveValue("7");
    await expect(page.getByRole("button", { name: "Set 35 / 7 minutes" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Set 25 / 5 minutes" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Set 50 / 10 minutes" }).click();
    await expect(page.locator("#focus-minutes")).toHaveValue("50");
    await expect(page.getByRole("button", { name: "Set 50 / 10 minutes" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Set 35 / 7 minutes" })).toHaveAttribute("aria-pressed", "false");
    const durationAlignment = await page.evaluate(() => {
        const shell = document.querySelector(".focus-setup-timer-shell").getBoundingClientRect();
        const input = document.querySelector("#focus-minutes").getBoundingClientRect();
        return Math.abs((shell.left + shell.width / 2) - (input.left + input.width / 2));
    });
    expect(durationAlignment).toBeLessThanOrEqual(1);

    const before = await page.locator("[data-focus-setup]").boundingBox();
    await page.getByRole("button", { name: "Focus Settings" }).first().click();
    await expect(page.locator("[data-focus-options]")).toBeVisible();
    const whileOpen = await page.locator("[data-focus-setup]").boundingBox();
    expect(whileOpen).toEqual(before);
    await expect(page.locator("[data-focus-options] [data-focus-routine-picker]")).toBeVisible();
    await page.locator("[data-focus-routine-create] [data-focus-save-routine]").click();
    await expect(page.locator("#focus-routine-select")).toHaveValue("routine-1");
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    await expect(page.locator("[data-focus-settings-status]").first()).toHaveText('“Default” saved as a new setup.');
    await page.getByRole("button", { name: "Close" }).click();

    await page.locator("[data-focus-playlist-toggle]").click();
    await expect(page.locator("[data-focus-playlist-composer]")).toHaveClass(/is-open/);
    await expect(page.locator("[data-focus-playlist-editor]")).toBeVisible();
    await expect(page.locator("#focus-spotify-url")).toBeFocused();
    await expect(page.locator("#focus-spotify-url")).toHaveAttribute("placeholder", "Paste a Spotify, YouTube, or YouTube Music playlist");
    await expect.poll(() => page.locator("#focus-spotify-url").evaluate((element) => {
        const style = getComputedStyle(element);
        return { outline: style.outlineStyle, boxShadow: style.boxShadow };
    })).toEqual({ outline: "none", boxShadow: "none" });
    await expect(page.locator("[data-focus-playlist-apply]")).toBeHidden();
    await expect.poll(() => page.locator("[data-focus-playlist-toggle]").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    await expect.poll(() => page.locator(".focus-playlist-add-vertical").evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    const addIconAlignment = await page.locator(".focus-playlist-composer").evaluate((element) => {
        const icon = element.querySelector(".focus-playlist-add-icon").getBoundingClientRect();
        const composer = element.getBoundingClientRect();
        return Math.abs((icon.left + icon.width / 2) - (composer.left + composer.width / 2));
    });
    expect(addIconAlignment).toBeLessThanOrEqual(1);
    await page.locator("#focus-spotify-url").fill("not-a-playlist");
    await expect(page.locator("[data-focus-playlist-apply]")).toBeHidden();
    await expect(page.locator("#focus-spotify-url")).toHaveAttribute("aria-invalid", "true");
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await expect(page.locator("[data-focus-playlist-apply]")).toBeEnabled();
    await expect(page.locator("[data-focus-playlist-submit-logo]")).toHaveAttribute("data-provider", "spotify");
    await page.locator("[data-focus-playlist-apply]").hover();
    await expect(page.locator(".focus-playlist-submit-check")).toBeVisible();
    await expect(page.locator("[data-focus-playlist-submit-logo]")).toBeHidden();
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator('script[src="https://open.spotify.com/embed/iframe-api/v1"]')).toHaveCount(1);
    await expect(page.locator("[data-focus-playlist-action]")).toHaveText("Add playlist");
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.duration)).toBe(1000);
    await expect(page.locator("[data-focus-playlist-composer]")).not.toHaveClass(/is-open/);
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await expect(page.locator("#focus-spotify-url")).toHaveValue("");
    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(replacementSpotifyUrl);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-focus-playlist-composer]")).not.toHaveClass(/is-open/);
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(replacementSpotifyUrl);
    await page.locator(".focus-region-heading h2").click();
    await expect(page.locator("[data-focus-playlist-composer]")).not.toHaveClass(/is-open/);
    await expect(page.locator("#focus-spotify-url")).toHaveValue("");
    await page.locator('[data-focus-preset][data-focus="50"]').click();
    await expect(page.locator("#focus-minutes")).toHaveValue("50");
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await expect(page.locator("#focus-spotify-url")).toHaveValue("");
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toHaveCount(1);

    await page.getByRole("button", { name: "Focus Settings" }).first().click();
    await page.locator("#focus-cycles").fill("2");
    await page.locator("#focus-break-minutes").fill("5");
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-focus-session]")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/focus-session-active/);
    await expect(page.locator("[data-focus-countdown]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    const countdownAlignment = await page.evaluate(() => {
        const shell = document.querySelector(".focus-timer-shell").getBoundingClientRect();
        const countdown = document.querySelector("[data-focus-countdown]").getBoundingClientRect();
        return {
            x: Math.abs((shell.left + shell.width / 2) - (countdown.left + countdown.width / 2)),
            y: Math.abs((shell.top + shell.height / 2) - (countdown.top + countdown.height / 2)),
        };
    });
    expect(countdownAlignment.x).toBeLessThanOrEqual(1);
    expect(countdownAlignment.y).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Finish focus" })).toBeVisible();
    await expect(page.locator(".sidebar-container")).toHaveAttribute("inert", "");
    await expect.poll(() => page.evaluate(() => window.__spotifyFixture.calls.includes("resume"))).toBe(true);

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(replacementSpotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect.poll(() => page.evaluate((url) => window.__focusTest.calls.some((call) => (
        call.url === "/api/focus/sessions/session-1"
        && call.method === "PATCH"
        && call.body.action === "set_playlist"
        && call.body.spotify_url === url
    )), replacementSpotifyUrl)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__spotifyFixture.calls.filter((call) => call === "destroy").length)).toBe(1);
    await expect(page.locator("[data-spotify-fixture='player']")).toHaveCount(1);
    await expect(page.locator("[data-focus-playlist-list] .focus-playlist-card")).toHaveCount(1);
    await expect(page.locator("[data-focus-playlist-list]")).toContainText("Deep Focus");
    await expect(page.locator("[data-focus-playlist-list]")).toContainText("Nest listener");
    await page.locator("[data-focus-playlist-list] .focus-playlist-card").click();
    await expect.poll(() => page.evaluate(() => window.__focusTest.session.spotify_url)).toBe(spotifyUrl);
    await expect(page.locator("[data-focus-playlist-list]")).toContainText("Reading Flow");
    const addControlStyle = await page.locator("[data-focus-playlist-composer]").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth,
            color: style.color,
            panelWidth: element.closest("[data-focus-utilities]").getBoundingClientRect().width,
            width: element.getBoundingClientRect().width,
        };
    });
    expect(addControlStyle.borderWidth).toBe("1px");
    expect(addControlStyle.borderColor).toBe(addControlStyle.color);
    expect(addControlStyle.width).toBeLessThan(addControlStyle.panelWidth);

    await page.getByRole("button", { name: "Focus Settings" }).click();
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

test("adding a playlist autoloads the player", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?manualPlayer=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
});

test("playlist submit control identifies Spotify, YouTube, and YouTube Music", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?playlistProviders=${Date.now()}`));

    const providers = [
        [spotifyUrl, "spotify"],
        ["https://www.youtube.com/playlist?list=PL1234567890abc", "youtube"],
        ["https://music.youtube.com/playlist?list=PLabcdefghijk", "youtube_music"],
    ];
    for (const [url, provider] of providers) {
        await page.locator("[data-focus-playlist-toggle]").click();
        await page.locator("#focus-spotify-url").fill(url);
        const logo = page.locator("[data-focus-playlist-submit-logo]");
        await expect(logo).toHaveAttribute("data-provider", provider);
        await expect(logo.locator("svg")).toBeVisible();
        await page.locator("[data-focus-playlist-apply]").hover();
        await expect(page.locator(".focus-playlist-submit-check")).toBeVisible();
        await expect(logo).toBeHidden();
        await page.locator("#focus-spotify-url").press("Escape");
    }
});

test("Recent sessions stays rendered and anchored for every player placement", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => {
        window.__focusTest.history = [{
            phase: "focus",
            duration_seconds: 1500,
            cycle_number: 1,
            routine_name: "Deep work",
            completed_at: new Date().toISOString(),
        }];
    });
    await page.evaluate(() => import(`/static/js/focus/index.js?historyPlacements=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();

    const details = page.locator("[data-focus-history-region]");
    const item = page.locator("[data-focus-history] .focus-history-item");
    await expect(details).toBeVisible();
    await expect(item).toHaveCount(1);

    for (const layout of ["below", "beside", "floating"]) {
        await page.getByRole("button", { name: "Focus Settings" }).first().click();
        await page.locator(`input[name="spotify_layout"][value="${layout}"]`).check();
        await page.getByRole("button", { name: "Close" }).click();
        await expect(page.locator("body")).toHaveAttribute("data-spotify-layout", layout);
        await details.locator("summary").scrollIntoViewIfNeeded();
        const before = await page.locator("[data-focus-history-region] summary").evaluate((element) => ({
            top: element.getBoundingClientRect().top,
            scrollY: window.scrollY,
            scrolling: document.scrollingElement?.scrollTop || 0,
            bodyScroll: document.body.scrollTop,
        }));
        await details.locator("summary").click();
        await expect(details).toHaveAttribute("open", "");
        await expect(item).toBeVisible();
        const after = await page.locator("[data-focus-history-region] summary").evaluate((element) => ({
            top: element.getBoundingClientRect().top,
            scrollY: window.scrollY,
            scrolling: document.scrollingElement?.scrollTop || 0,
            bodyScroll: document.body.scrollTop,
        }));
        expect(Math.abs(after.top - before.top), `${layout}: ${JSON.stringify({ before, after })}`).toBeLessThanOrEqual(1);
        expect(after.scrollY, `${layout}: ${JSON.stringify({ before, after })}`).toBe(before.scrollY);
        await details.locator("summary").click();
        await expect(details).not.toHaveAttribute("open", "");
    }
});

test("focus time suggestions dedupe recent matches and fall back to defaults", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => {
        window.__focusTest.recent = [
            { focus_minutes: 25, break_minutes: 5, cycles: 1 },
            { focus_minutes: 25, break_minutes: 5, cycles: 1 },
            { focus_minutes: 40, break_minutes: 8, cycles: 1 },
        ];
    });
    await page.evaluate(() => import(`/static/js/focus/index.js?presets=${Date.now()}`));

    await expect(page.locator("[data-focus-recent-list] .focus-choice")).toHaveText([
        "25 / 5 min", "40 / 8 min", "50 min", "90 min",
    ]);
    await page.getByRole("button", { name: "Set 25 / 5 minutes" }).click();
    await expect(page.getByRole("button", { name: "Set 25 / 5 minutes" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#focus-minutes")).toHaveValue("25");
    await expect(page.locator("#focus-break-minutes")).toHaveValue("5");

    await page.evaluate(() => { window.__focusTest.recent = []; });
    await page.reload();
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => { window.__focusTest.recent = []; });
    await page.evaluate(() => import(`/static/js/focus/index.js?presetsEmpty=${Date.now()}`));
    await expect(page.locator("[data-focus-recent-list] .focus-choice")).toHaveText([
        "25 min", "50 min", "90 min",
    ]);
});

test("Focus errors stay in toasts instead of inline status copy", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => {
        const originalFetch = window.fetch;
        window.fetch = async (input, options = {}) => {
            const url = String(input);
            const method = options.method || "GET";
            if (url === "/api/focus/playlists" && method === "POST") throw new Error("Failed to fetch");
            return originalFetch(input, options);
        };
    });
    await page.evaluate(() => import(`/static/js/focus/index.js?errors=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.message)).toBe("Failed to fetch");
});

test("floating player can resize, move, and account-sync its placement", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?floating=${Date.now()}`));
    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await page.getByRole("button", { name: "Start focus" }).click();
    await page.getByRole("button", { name: "Focus Settings" }).click();
    await page.locator('input[name="spotify_layout"][value="floating"]').check();
    await page.getByRole("button", { name: "Close" }).click();

    const player = page.locator("[data-focus-utilities]");
    const compact = await player.boundingBox();
    await page.getByRole("button", { name: "Expand playlist player" }).click();
    const expanded = await player.boundingBox();
    expect(expanded.width).toBeGreaterThan(compact.width);
    await page.getByRole("button", { name: "Move playlist player" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => page.evaluate(() => window.__focusTest.playerPreferences?.layout)).toBe("floating");
    await expect.poll(() => page.evaluate(() => window.__focusTest.playerPreferences?.floating_size)).toBe("expanded");
    const moved = await player.boundingBox();
    expect(moved.x).toBeLessThan(expanded.x);
    await page.getByRole("button", { name: /Resize music panel/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => page.evaluate(() => window.__focusTest.playerPreferences?.panel_width)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__focusTest.playerPreferences?.panel_height)).toBeGreaterThan(0);
    const resized = await player.boundingBox();
    expect(resized.width).toBeGreaterThan(expanded.width);
    expect(resized.height).toBeGreaterThan(expanded.height);
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
    await page.evaluate(() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === '(hover: none), (pointer: coarse)'
            ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
            : nativeMatchMedia(query);
    });
    await page.locator("[data-focus-player-frame]").hover();
    await expect(page.locator("[data-focus-playlist-remove]")).toBeVisible();
    await page.locator("[data-focus-playlist-remove]").click();
    await expect(page.locator("[data-focus-player-frame]")).toHaveClass(/is-actions-visible/);
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await page.locator("[data-focus-playlist-remove]").click();
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
    await expect(page.locator("[data-focus-playlist-apply]")).toBeDisabled();
    await expect(page.locator("[data-focus-playlist-remove]")).toBeHidden();
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue("");
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.action?.label)).toBe("Undo");
});

test("saving keeps the selected setup target and supports undo", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?routineUndo=${Date.now()}`));

    await page.getByRole("button", { name: "Focus Settings" }).first().click();
    await page.locator("[data-focus-routine-create] [data-focus-save-routine]").click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.locator('[data-focus-preset][data-focus="50"]').click();
    await expect(page.locator("#focus-routine-select")).toHaveValue("routine-1");
    await page.getByRole("button", { name: "Focus Settings" }).first().click();
    await page.getByRole("button", { name: "Save changes" }).first().click();
    await expect(page.locator("[data-focus-settings-status]").first()).toHaveText('Changes saved to “Default”.');
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.filter((call) => call.url === "/api/focus/routines" && call.method === "POST").length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.filter((call) => call.url === "/api/focus/routines/routine-1" && call.method === "PATCH").length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.action?.label)).toBe("Undo");

    await page.evaluate(() => window.__focusTest.toasts.at(-1).action.onClick());
    await expect(page.locator("#focus-minutes")).toHaveValue("25");
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.filter((call) => call.url === "/api/focus/routines/routine-1" && call.method === "PATCH").length)).toBe(2);
});

test("non-active playlists remove on hover or touch swipe and can be undone", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?playlistGestures=${Date.now()}`));

    for (const url of [spotifyUrl, replacementSpotifyUrl]) {
        await page.locator("[data-focus-playlist-toggle]").click();
        await page.locator("#focus-spotify-url").fill(url);
        await page.locator("[data-focus-playlist-apply]").click();
    }

    const item = page.locator("[data-focus-playlist-item]");
    await expect(item).toHaveCount(1);
    await item.hover();
    const remove = page.locator(".focus-playlist-card-remove");
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(item).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__focusTest.toasts.at(-1)?.action?.label)).toBe("Undo");
    await page.evaluate(() => window.__focusTest.toasts.at(-1).action.onClick());
    await expect(item).toHaveCount(1);

    const box = await item.boundingBox();
    const pointer = { pointerId: 7, pointerType: "touch", isPrimary: true };
    await item.dispatchEvent("pointerdown", { ...pointer, clientX: box.x + box.width - 12, clientY: box.y + box.height / 2 });
    await item.dispatchEvent("pointermove", { ...pointer, clientX: box.x + 12, clientY: box.y + box.height / 2 });
    await item.dispatchEvent("pointerup", { ...pointer, clientX: box.x + 12, clientY: box.y + box.height / 2 });
    await expect(item).toHaveCount(0);
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
    const playerIdentity = await page.locator("[data-spotify-fixture='player']").evaluate((node) => {
        node.dataset.focusPlayerProbe = "keep";
        return node.dataset.focusPlayerProbe;
    });
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-focus-cycle-status]")).toBeHidden();
    await page.getByRole("button", { name: "Finish focus" }).click();

    await expect(page.locator("[data-focus-session]")).toBeVisible();
    await expect(page.locator("[data-focus-setup]")).toBeHidden();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toHaveAttribute("data-focus-player-probe", playerIdentity);
    await expect(page.getByRole("button", { name: "Exit focus" })).toBeVisible();
    await expect(page.locator("[data-focus-toggle]")).toBeHidden();
    const destroyCountBeforeExit = await page.evaluate(() => (window.__spotifyFixture?.calls || []).filter((call) => call === "destroy").length);
    await page.getByRole("button", { name: "Exit focus" }).click();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start focus" })).toBeEnabled();
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toHaveAttribute("data-focus-player-probe", playerIdentity);
    const destroyCountAfterExit = await page.evaluate(() => (window.__spotifyFixture?.calls || []).filter((call) => call === "destroy").length);
    expect(destroyCountAfterExit).toBe(destroyCountBeforeExit);
});

test("exiting a running session keeps the same playlist player mounted", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?exitKeep=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await page.locator("[data-spotify-fixture='player']").evaluate((node) => {
        node.dataset.focusPlayerProbe = "keep-running-exit";
    });
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    const destroyCountBeforeExit = await page.evaluate(() => (window.__spotifyFixture?.calls || []).filter((call) => call === "destroy").length);
    await page.getByRole("button", { name: "Exit" }).click();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start focus" })).toBeEnabled();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();
    await expect(page.locator("[data-spotify-fixture='player']")).toHaveAttribute("data-focus-player-probe", "keep-running-exit");
    const destroyCountAfterExit = await page.evaluate(() => (window.__spotifyFixture?.calls || []).filter((call) => call === "destroy").length);
    expect(destroyCountAfterExit).toBe(destroyCountBeforeExit);
});

test("player resizing snaps out of unsafe embedded-player heights", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(baseURL + "/static/js/focus/index.js");
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import("/static/js/focus/index.js?resizeSnap=" + Date.now()));
    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await page.getByRole("button", { name: "Start focus" }).click();
    await expect(page.locator("[data-spotify-fixture='player']")).toBeVisible();

    for (const layout of ["below", "beside", "floating"]) {
        await page.getByRole("button", { name: "Focus Settings" }).click({ force: true });
        await page.locator(`input[name="spotify_layout"][value="${layout}"]`).evaluate((input) => {
            input.checked = true;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.evaluate(() => document.querySelector("[data-focus-options-close]")?.click());
        await page.locator("[data-focus-utilities]").scrollIntoViewIfNeeded();
        await page.locator("[data-focus-panel-resize]").evaluate((element) => {
            element.focus();
            for (let index = 0; index < 50; index += 1) {
                element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
                element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
            }
        });
        const dimensions = await page.evaluate(() => {
            const rect = (selector) => {
                const element = document.querySelector(selector);
                const box = element?.getBoundingClientRect();
                return box ? { width: box.width, height: box.height } : null;
            };
            return {
                layout: document.body.dataset.spotifyLayout,
                preferences: window.__focusTest.playerPreferences,
                soundtrack: rect("[data-focus-utilities]"),
                frame: rect("[data-focus-player-frame]"),
                embed: rect("[data-focus-spotify-embed]"),
                customSize: document.body.dataset.spotifyCustomSize,
            };
        });
        expect(dimensions.layout).toBe(layout);
        expect(Math.round(dimensions.frame.height)).toBeGreaterThanOrEqual(140);
        expect(Math.round(dimensions.frame.height)).toBeLessThanOrEqual(160);
        expect(Math.round(dimensions.embed.height)).toBeGreaterThanOrEqual(140);
        expect(Math.round(dimensions.embed.height)).toBeLessThanOrEqual(160);
        expect(dimensions.preferences.panel_height).toBeGreaterThanOrEqual(Math.round(dimensions.frame.height));
        expect(dimensions.soundtrack.height).toBeGreaterThanOrEqual(Math.round(dimensions.frame.height));
        expect(dimensions.customSize).toBe("true");
    }
});

test("account playlists reload after Focus Mode reinitializes", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(() => import(`/static/js/focus/index.js?persist=${Date.now()}`));

    await page.locator("[data-focus-playlist-toggle]").click();
    await page.locator("#focus-spotify-url").fill(spotifyUrl);
    await page.locator("[data-focus-playlist-apply]").click();
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await expect.poll(() => page.evaluate(() => window.__focusTest.userPlaylists.length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.filter((call) => call.url === "/api/focus/playlists" && call.method === "POST").length)).toBe(1);

    await page.evaluate(() => {
        document.querySelector("[data-focus-active-playlist-url]").value = "";
        const embed = document.querySelector("[data-focus-spotify-embed]");
        if (embed) embed.hidden = true;
    });
    await page.evaluate(() => new Promise((resolve) => {
        let hidden = true;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        window.setTimeout(resolve, 250);
    }));

    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await expect(page.locator("[data-focus-spotify-embed]")).toBeVisible();
    await expect(page.locator("[data-focus-setup]")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__focusTest.calls.filter((call) => call.url === "/api/focus" && call.method === "GET").length)).toBeGreaterThanOrEqual(2);
});

test("playlist tier limits disable add controls when the library is full", async ({ page, baseURL }) => {
    await installSpotifyEmbedFixture(page);
    await page.goto(`${baseURL}/static/js/focus/index.js`);
    await page.setContent(focusFixture());
    await installFocusApi(page);
    await page.evaluate(({ spotifyUrl, replacementSpotifyUrl, thirdSpotifyUrl }) => {
        window.__focusTest.playlistLimit = 2;
        window.__focusTest.userPlaylists = [spotifyUrl, replacementSpotifyUrl]
            .map((url) => window.__focusTestHelpers.playlistFixtureMeta(url));
        window.__focusTest.activePlaylistUrl = spotifyUrl;
    }, { spotifyUrl, replacementSpotifyUrl, thirdSpotifyUrl });
    await page.evaluate(() => import(`/static/js/focus/index.js?tierLimit=${Date.now()}`));

    const toggle = page.locator("[data-focus-playlist-toggle]");
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-label", "Playlist limit reached (2 of 2)");
    await expect(page.locator("[data-focus-active-playlist-url]")).toHaveValue(spotifyUrl);
    await expect.poll(() => page.evaluate(() => window.__focusTest.userPlaylists.length)).toBe(2);
    await expect(page.locator("[data-focus-playlist-status]")).toHaveText("");
});

test("settings drawer and all player placements stay inside mobile, tablet, and laptop viewports", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/css/focus.css`);
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/static/css/focus.css"></head>
        <body class="focus-body focus-session-active" data-spotify-layout="beside"><main class="focus-main"><form class="focus-routine-form"><section class="focus-session"><div class="focus-session-stage"><div class="focus-timer-shell"></div></div></section><section class="focus-soundtrack"><div class="focus-playlist-form"><label class="focus-field"><span>Spotify playlist</span><input></label><button>Add playlist</button></div><iframe class="focus-spotify-embed"></iframe></section>
        <dialog class="focus-options-dialog" open><header class="focus-options-header"><h2>Focus Settings</h2></header><div class="focus-options-scroll"><div style="height:900px">Settings</div></div></dialog></form></main></body></html>`);

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

test("focus setup controls stay inside Focus Settings and remain touch friendly", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/static/css/focus.css`);
    await page.setContent(`<!doctype html><html data-theme="obsidian-dark"><head><link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/static/css/focus.css"></head>
        <body class="focus-body"><main class="focus-main"><section class="focus-setup"><header class="focus-setup-header focus-setup-header-actions"><h1 class="sr-only">Focus Mode</h1><button class="focus-button focus-button-secondary">Focus Settings</button></header></section>
        <dialog class="focus-options-dialog" open><div class="focus-options-scroll"><section class="focus-options-group focus-routine-editor" data-focus-routine-picker><h3>Focus setup</h3>
            <div class="focus-field focus-routine-setup-field"><span class="focus-field-label">Saved setup</span><div class="focus-combobox" data-focus-routine-combobox><input type="hidden" id="focus-routine-select" value="" /><button type="button" class="focus-combobox-trigger" data-focus-combobox-trigger role="combobox" aria-expanded="false"><span data-focus-combobox-label class="focus-combobox-placeholder">Select setup</span><svg class="focus-combobox-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5"></path></svg></button><div class="focus-combobox-menu" data-focus-combobox-menu hidden><div class="focus-combobox-list" data-focus-combobox-list></div></div></div></div>
            <div class="focus-routine-create" data-focus-routine-create><label class="focus-field focus-routine-name-field"><span>Setup name</span><div class="focus-routine-name-row"><input value="Default"><button class="focus-button focus-button-primary focus-routine-save">Save setup</button></div></label></div>
        </section></div></dialog></main></body></html>`);

    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        const dialog = await page.locator(".focus-options-dialog").boundingBox();
        const picker = await page.locator(".focus-combobox").boundingBox();
        const button = await page.getByRole("button", { name: "Save setup" }).boundingBox();
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.x).toBeGreaterThanOrEqual(dialog.x);
        expect(button.x + button.width).toBeLessThanOrEqual(dialog.x + dialog.width + 1);
        expect(button.y).toBeGreaterThanOrEqual(picker.y + picker.height);
    }
});
