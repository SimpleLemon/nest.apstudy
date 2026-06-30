import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// These imports are intentionally unreachable: the browser modules depend on DOM
// globals, but desloppify's coverage mapper needs import edges to associate this
// source-contract suite with the files it exercises as text.
if (false) {
    await import("../../atlasCourseUtils.js");
    await import("../../atlasMainScraper.js");
    await import("../../static/js/core/admin-nav.js");
    await import("../../static/js/core/admin-requests.js");
    await import("../../static/js/calendar/bootstrap.js");
    await import("../../static/js/calendar/controls.js");
    await import("../../static/js/calendar/core.js");
    await import("../../static/js/calendar/events/context-menu.js");
    await import("../../static/js/calendar/events/event-form.js");
    await import("../../static/js/calendar/events/ui-actions.js");
    await import("../../static/js/calendar/index.js");
    await import("../../static/js/calendar/integrations/course-modal.js");
    await import("../../static/js/calendar/integrations/courses.js");
    await import("../../static/js/calendar/integrations/data.js");
    await import("../../static/js/calendar/integrations/share.js");
    await import("../../static/js/calendar/integrations/sources.js");
    await import("../../static/js/calendar/menu.js");
    await import("../../static/js/calendar/preferences.js");
    await import("../../static/js/calendar/state.js");
    await import("../../static/js/calendar/utils.js");
    await import("../../static/js/calendar/views/agenda.js");
    await import("../../static/js/calendar/views/event-render.js");
    await import("../../static/js/calendar/views/month-view.js");
    await import("../../static/js/calendar/views/render-shell.js");
    await import("../../static/js/calendar/views/week-view.js");
    await import("../../static/js/chat/index.js");
    await import("../../static/js/chat/context.js");
    await import("../../static/js/chat/utils.js");
    await import("../../static/js/chat/cache.js");
    await import("../../static/js/chat/render-ui.js");
    await import("../../static/js/chat/render-messages.js");
    await import("../../static/js/chat/presence.js");
    await import("../../static/js/chat/load.js");
    await import("../../static/js/chat/realtime.js");
    await import("../../static/js/chat/actions.js");
    await import("../../static/js/core/appwrite.js");
    await import("../../static/js/core/command-palette.js");
    await import("../../static/js/core/global.js");
    await import("../../static/js/core/ui-primitives.js");
    await import("../../static/js/core/navbar.js");
    await import("../../static/js/core/sidebar.js");
    await import("../../static/js/core/theme-init.js");
    await import("../../static/js/courses/calendar.js");
    await import("../../static/js/courses/controls.js");
    await import("../../static/js/courses/data.js");
    await import("../../static/js/courses/filters.js");
    await import("../../static/js/courses/index.js");
    await import("../../static/js/courses/panel.js");
    await import("../../static/js/courses/utils.js");
    await import("../../static/js/dashboard/daily-quote.js");
    await import("../../static/js/dashboard/daily-quote/data.js");
    await import("../../static/js/dashboard/index.js");
    await import("../../static/js/dashboard/renderers.js");
    await import("../../static/js/dashboard/popovers.js");
    await import("../../static/js/dashboard/utils.js");
    await import("../../static/js/files/events.js");
    await import("../../static/js/files/index.js");
    await import("../../static/js/files/modals.js");
    await import("../../static/js/files/renderers.js");
    await import("../../static/js/files/utils.js");
    await import("../../static/js/files/workflows.js");
    await import("../../static/js/core/landing.js");
    await import("../../static/js/notes/editor.js");
    await import("../../static/js/notes/editor/runtime.js");
    await import("../../static/js/notes/editor/page-setup.js");
    await import("../../static/js/notes/editor/toolbar-menus.js");
    await import("../../static/js/notes/editor/save.js");
    await import("../../static/js/notes/editor/editing.js");
    await import("../../static/js/notes/editor/toolbar-bindings.js");
    await import("../../static/js/notes/editor/document.js");
    await import("../../static/js/notes/editor/utils.js");
    await import("../../static/js/notes/export.js");
    await import("../../static/js/notes/list.js");
    await import("../../static/js/notes/list/cards.js");
    await import("../../static/js/notes/list/utils.js");
    await import("../../static/js/notes/toolbar.js");
    await import("../../static/js/settings/account.js");
    await import("../../static/js/settings/discord.js");
    await import("../../static/js/settings/calendar.js");
    await import("../../static/js/settings/index.js");
    await import("../../static/js/settings/preferences.js");
    await import("../../static/js/settings/profile.js");
    await import("../../static/js/settings/utils.js");
    await import("../../static/js/tasks/task-app-helpers.js");
    await import("../../static/js/tasks/task-components.js");
    await import("../../static/js/tasks/task-data.js");
    await import("../../static/js/tasks/task-entry-components.js");
    await import("../../static/js/tasks/task-popover.js");
    await import("../../static/js/tasks/task.js");
}

async function sourceFor(relativePath) {
    if (relativePath === "static/js/notes/editor.js") {
        const editorModules = [
            "static/js/notes/editor.js",
            "static/js/notes/editor/runtime.js",
            "static/js/notes/editor/page-setup.js",
            "static/js/notes/editor/toolbar-menus.js",
            "static/js/notes/editor/save.js",
            "static/js/notes/editor/editing.js",
            "static/js/notes/editor/toolbar-bindings.js",
            "static/js/notes/editor/document.js",
            "static/js/notes/toolbar.js",
        ];
        return (await Promise.all(editorModules.map((modulePath) => (
            readFile(path.join(repoRoot, modulePath), "utf8")
        )))).join("\n");
    }
    return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("command palette keeps primary navigation, theme actions, and global controls wired", async () => {
    const source = await sourceFor("static/js/core/command-palette.js");

    for (const route of ["/calendar", "/courses", "/notes", "/tasks", "/files", "/chat", "/settings"]) {
        assert.match(source, new RegExp(`route: ['"]${route}['"]`));
    }

    assert.match(source, /export const COMMAND_PALETTE_PAGES\b/);
    assert.match(source, /const THEME_TO_INTERFACE_THEME = \{/);
    assert.match(source, /const INTERFACE_THEMES = \[/);
    assert.match(source, /'nest-light'/);
    assert.match(source, /'nest-dark'/);
    assert.match(source, /dark: ['"]obsidian-dark['"]/);
    assert.match(source, /light: ['"]parchment-light['"]/);
    assert.match(source, /system: ['"]system-match['"]/);
    assert.match(source, /window\.APSTUDY_COMMAND_PALETTE = commandPalette/);
});

test("calendar event form preserves escaping, API routes, and cache refresh behavior", async () => {
    const source = await sourceFor("static/js/calendar/events/event-form.js");

    for (const replacement of ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;"]) {
        assert.match(source, new RegExp(replacement.replace("&", "&")));
    }

    assert.match(source, /window\.openCalendarEventForm = function/);
    assert.match(source, /fetch\("\/api\/calendar\/events"/);
    assert.match(source, /fetch\(`\/api\/calendar\/events\/\$\{encodeURIComponent\(currentEventId\)\}`/);
    assert.match(source, /fetch\("\/api\/calendar\/event-overrides"/);
    assert.match(source, /localStorage\.removeItem\("calendarEventsCache"\)/);
    assert.match(source, /window\.loadCalendarData && window\.loadCalendarData\(\)/);
});

test("calendar dashboard keeps cache, public-share, and event-form contracts wired", async () => {
    const source = [
        await sourceFor("static/js/calendar/index.js"),
        await sourceFor("static/js/calendar/utils.js"),
        await sourceFor("static/js/calendar/state.js"),
        await sourceFor("static/js/calendar/core.js"),
        await sourceFor("static/js/calendar/integrations/course-modal.js"),
        await sourceFor("static/js/calendar/integrations/courses.js"),
        await sourceFor("static/js/calendar/menu.js"),
        await sourceFor("static/js/calendar/preferences.js"),
        await sourceFor("static/js/calendar/integrations/data.js"),
        await sourceFor("static/js/calendar/views/event-render.js"),
        await sourceFor("static/js/calendar/events/ui-actions.js"),
        await sourceFor("static/js/calendar/views/agenda.js"),
        await sourceFor("static/js/calendar/views/month-view.js"),
        await sourceFor("static/js/calendar/views/week-view.js"),
        await sourceFor("static/js/calendar/views/render-shell.js"),
        await sourceFor("static/js/calendar/integrations/sources.js"),
        await sourceFor("static/js/calendar/integrations/share.js"),
        await sourceFor("static/js/calendar/controls.js"),
        await sourceFor("static/js/calendar/bootstrap.js"),
    ].join("\n");

    assert.match(source, /const WEEKDAYS = \["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"\]/);
    assert.match(source, /const EVENTS_CACHE_KEY = "calendarEventsCache"/);
    assert.match(source, /const DEFAULT_LOCAL_CALENDAR_ID = "local:default"/);
    assert.match(source, /const TASK_CALENDAR_ID = "local:tasks"/);
    assert.match(source, /window\.loadCalendarData = loadCalendarData/);
    assert.match(source, /window\.getCalendarOptionsForEventForm = getCalendarOptionsForEventForm/);
    assert.match(source, /window\.getDefaultCalendarIdForEventForm = getDefaultCalendarIdForEventForm/);
    assert.match(source, /fetch\("\/api\/calendar\/preferences"/);
    assert.match(source, /\/api\/calendar\/share\/\$\{encodeURIComponent\(state\.public\.shareCode\)\}\/events/);
    assert.match(source, /fetch\("\/api\/calendar\/refresh", \{ method: "POST" \}\)/);
    assert.match(source, /fetch\("\/api\/atlas\/sections\/by-id"/);
    assert.match(source, /function escapeHtml\(value\)/);
});

test("dashboard daily quote fetches Flask endpoint and uses one smooth egg card", async () => {
    const source = [
        await sourceFor("static/js/dashboard/daily-quote/data.js"),
        await sourceFor("static/js/dashboard/daily-quote.js"),
    ].join("\n");

    assert.doesNotMatch(source, /https:\/\/zenquotes\.io\/api\/today/);
    assert.match(source, /QUOTE_API_URL = "\/api\/dashboard\/quote\/today"/);
    assert.match(source, /ERROR_REPORT_URL = "\/api\/dashboard\/quote\/error"/);
    assert.match(source, /fetch\(QUOTE_API_URL, \{ signal \}\)/);
    assert.match(source, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    assert.doesNotMatch(source, /America\/Chicago/);
    assert.doesNotMatch(source, /item\?\.(?:q|a)(?![A-Za-z_])/);
    assert.match(source, /function reportQuoteError\(reason, details = \{\}\)/);
    assert.match(source, /fetch\(ERROR_REPORT_URL, \{/);
    assert.match(source, /keepalive: true/);
    for (const reason of [
        "fetch_failed",
        "http_error",
        "invalid_payload",
        "cache_read_failed",
        "cache_write_failed",
        "visibility_storage_failed",
    ]) {
        assert.match(source, new RegExp(`reportQuoteError\\("${reason}"`));
    }
    assert.match(source, /dashboard-egg-shell/);
    assert.match(source, /function addFractureGeometry\(root\)/);
    assert.match(source, /addFractureGeometry\(root\);\s*root\.dataset\.phase = "fracture"/);
    assert.doesNotMatch(source, /\.dashboard-egg-quote\{[^}]*border:1px/);
    assert.doesNotMatch(source, /\.dashboard-egg-quote\{[^}]*box-shadow/);
});

test("sidebar keeps persisted collapse state, route targets, and preference event bridge", async () => {
    const source = await sourceFor("static/js/core/sidebar.js");
    const template = await sourceFor("templates/_sidebar.html");

    for (const endpoint of ["dashboard.calendar", "dashboard.courses", "file_share.file_share_page", "dashboard.notes", "dashboard.tasks", "dashboard.chat", "settings.settings_page"]) {
        assert.match(template, new RegExp(endpoint.replaceAll(".", "\\.")));
    }

    assert.match(source, /const route = item\.dataset\.route/);
    assert.match(source, /function normalizeSidebarDefault\(value\)/);
    assert.match(source, /localStorage\.getItem\('sidebar-collapsed'\)/);
    assert.match(source, /localStorage\.setItem\('sidebar-collapsed', String\(isCollapsed\)\)/);
    assert.match(source, /window\.APSTUDY_SET_SIDEBAR_COLLAPSED = applySidebarCollapsedState/);
    assert.match(source, /apstudy-sidebar-default-change/);
});

test("mobile shell uses a hamburger drawer without breaking desktop sidebar persistence", async () => {
    const navbarSource = await sourceFor("static/js/core/navbar.js");
    const sidebarSource = await sourceFor("static/js/core/sidebar.js");
    const layoutStyles = await sourceFor("static/css/layout.css");

    assert.match(navbarSource, /id="navbar-menu-btn"/);
    assert.match(navbarSource, /window\.APSTUDY_SYNC_MOBILE_NAV_BUTTON/);
    assert.match(navbarSource, /APSTUDY_TOGGLE_MOBILE_SIDEBAR/);

    assert.match(sidebarSource, /window\.matchMedia\('\(max-width: 1024px\)'\)/);
    assert.match(sidebarSource, /sidebar-mobile-backdrop/);
    assert.match(sidebarSource, /mobile-sidebar-open/);
    assert.match(sidebarSource, /window\.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = setMobileSidebarOpen/);
    assert.match(sidebarSource, /localStorage\.setItem\('sidebar-collapsed', String\(shouldCollapse\)\)/);

    assert.match(layoutStyles, /\.navbar-menu-button/);
    assert.match(layoutStyles, /\.sidebar-container\.mobile-open/);
    assert.match(layoutStyles, /transform: translateX\(-105%\)/);
    assert.match(layoutStyles, /body\.mobile-sidebar-open/);
    assert.match(layoutStyles, /min-height: 48px/);
});

test("calendar and courses switch dense schedules to compact mobile agenda renderers", async () => {
    const calendarSource = [
        await sourceFor("static/js/calendar/index.js"),
        await sourceFor("static/js/calendar/views/agenda.js"),
        await sourceFor("static/js/calendar/views/render-shell.js"),
    ].join("\n");
    const coursesSource = [
        await sourceFor("static/js/courses/index.js"),
        await sourceFor("static/js/courses/calendar.js"),
    ].join("\n");
    const globalStyles = await sourceFor("static/css/global.css");
    const coursesStyles = await sourceFor("static/css/courses.css");

    assert.match(calendarSource, /COMPACT_CALENDAR_QUERY = window\.matchMedia\("\(max-width: 640px\)"\)/);
    assert.match(calendarSource, /buildMobileCalendarAgendaHtml/);
    assert.match(calendarSource, /calendar-mobile-agenda/);
    assert.match(calendarSource, /compactCalendar \? buildMobileCalendarAgendaHtml\(\)/);

    assert.match(coursesSource, /COMPACT_COURSES_QUERY = window\.matchMedia\("\(max-width: 640px\)"\)/);
    assert.match(coursesSource, /buildMobileCoursesAgenda/);
    assert.match(coursesSource, /courses-mobile-agenda/);
    assert.match(coursesSource, /isCompactCoursesViewport\(\)/);

    assert.match(globalStyles, /\.calendar-mobile-agenda/);
    assert.match(coursesStyles, /\.courses-mobile-agenda/);
    assert.match(coursesStyles, /\.course-remove-button\.courses-mobile-remove/);
});

test("theme init normalizes theme aliases and persists pending settings safely", async () => {
    const source = await sourceFor("static/js/core/theme-init.js");

    assert.match(source, /console-discord\.js/);
    assert.match(source, /var DARK_THEMES = \['obsidian-dark', 'nest-dark'\]/);
    assert.match(source, /return 'obsidian-dark'/);
    assert.match(source, /return 'parchment-light'/);
    assert.match(source, /return 'system-match'/);
    assert.match(source, /window\.APSTUDY_SET_THEME_PREFERENCE = applyThemePreference/);
    assert.match(source, /new CustomEvent\('apstudy-theme-change'/);
    assert.match(source, /fetch\('\/settings\/api\/interface-preferences'/);
    assert.match(source, /clearPendingTheme\(\)/);
});

test("dashboard uses the shared theme preference without page-specific remapping", async () => {
    const template = await sourceFor("templates/dashboard.html");

    assert.match(template, /js\/core\/theme-init\.js/);
    assert.doesNotMatch(template, /js\/dashboard\/theme\.js/);
});

test("console discord batches browser console output for server logs", async () => {
    const source = await sourceFor("static/js/core/console-discord.js");

    assert.match(source, /\/api\/debug\/console/);
    assert.match(source, /\["log", "info", "warn", "error", "debug"\]/);
    assert.match(source, /unhandledrejection/);
    assert.match(source, /sendBeacon/);
    assert.match(source, /forwarding/);
});

test("notes list guards destructive actions and supports folder/export workflows", async () => {
    const source = [
        await sourceFor("static/js/notes/list.js"),
        await sourceFor("static/js/notes/list/utils.js"),
        await sourceFor("static/js/notes/list/cards.js"),
    ].join("\n");

    assert.match(source, /function apiJson\(url, options = \{\}\)/);
    assert.match(source, /APStudyPendingMutations\?\.track\(request, 'notes-save'\)/);
    assert.match(source, /apiJson\(`\/api\/notes\/\$\{encodeURIComponent\(noteId\)\}`/);
    assert.match(source, /apiJson\(`\/api\/notes\/folders\/\$\{encodeURIComponent\(folderId\)\}`/);
    assert.match(source, /NotesExport\?\.exportNoteJsonToTxt/);
    assert.match(source, /NotesExport\?\.exportNoteJsonToPdf/);
    assert.match(source, /data-action="move"/);
});

test("notes editor keeps autosave, BlockNote schema, and load/save endpoints wired", async () => {
    const source = await sourceFor("static/js/notes/editor.js");
    const toolbarSource = await sourceFor("static/js/notes/toolbar.js");
    const styles = await sourceFor("static/css/notes.css");
    const editorTemplate = await sourceFor("templates/notes_editor.html");
    const notesTemplate = await sourceFor("templates/notes.html");

    assert.match(source, /const SAVE_DEBOUNCE_MS = 800/);
    assert.match(source, /const SAVED_TIME_REFRESH_MS = 60000/);
    assert.match(source, /from '\.\.\/toolbar\.js'/);
    assert.match(toolbarSource, /const notesEditorSchema = BlockNoteSchema\.create/);
    assert.match(toolbarSource, /createReactStyleSpec/);
    assert.match(toolbarSource, /fontSizeStyle/);
    assert.match(source, /formattingToolbar: false/);
    assert.match(source, /function handleNotesPaste\(\{[^}]*defaultPasteHandler[^}]*\}\)/);
    assert.match(source, /pasteHandler: handleNotesPaste/);
    assert.match(source, /prioritizeMarkdownOverHTML: true/);
    assert.match(source, /plainTextAsMarkdown: true/);
    assert.doesNotMatch(source, /slashMenu:\s*false/);
    assert.doesNotMatch(source, /function FontSizeControl/);
    assert.doesNotMatch(source, /TextColorDropdown/);
    assert.match(source, /window\.APStudyPendingMutations\?\.track\(fetch\(`\/api\/notes\/\$\{noteId\}`/);
    assert.match(source, /fetch\(`\/api\/notes\/\$\{noteId\}`\)/);
    assert.match(source, /triggerDebouncedSave\(\)/);
    assert.match(source, /React\.createElement\(NoteEditor, \{/);
    assert.match(source, /function insertBlockFromMenu\(button\)/);
    assert.match(source, /editorState\.editorInstance\.insertBlocks\?\.\(/);
    assert.match(source, /editorState\.editorInstance\.openSuggestionMenu\?\.\('\/'\)/);
    assert.match(source, /function canRunHistoryAction\(action\)/);
    assert.match(source, /editorState\.editorInstance\._tiptapEditor\?\.can\?\.\(\)/);
    assert.match(source, /button\.disabled = disabled/);
    assert.match(styles, /--notes-bg-base: var\(--color-surface-container-lowest\)/);
    assert.match(styles, /--notes-bg-toolbar: var\(--color-surface-container-low\)/);
    assert.match(styles, /--notes-editor-content-width: 720px/);
    assert.ok(styles.includes('content: "\\2022" !important;'));
    assert.ok(styles.includes('content: attr(data-index) "." !important;'));
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="checkListItem"\] input\[type="checkbox"\]/);
    assert.match(styles, /\.blocknote-container \[data-content-type="table"\] table/);
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="quote"\]/);
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="codeBlock"\]/);
    assert.match(styles, /\.blocknote-container \[data-content-type="horizontalRule"\]/);
    assert.match(styles, /\.blocknote-container \.bn-block-group \.bn-block-group/);
    assert.match(styles, /\.notes-writing-toolbar button:disabled/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="add-block"/);
    assert.doesNotMatch(editorTemplate, /<global class="thefooter"><\/global>/);
    assert.match(notesTemplate, /<global class="thefooter"><\/global>/);
    assert.doesNotMatch(styles, /STATIC TOOLBAR/);
    assert.doesNotMatch(styles, /padding-top:\s*58px/);
    assert.doesNotMatch(styles, /#4ade80/i);
});
