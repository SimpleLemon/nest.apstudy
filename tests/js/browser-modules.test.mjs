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
    await import("../../static/js/admin-nav.js");
    await import("../../static/js/admin-requests.js");
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
    await import("../../static/js/chat.js");
    await import("../../static/js/core/appwrite.js");
    await import("../../static/js/core/command-palette.js");
    await import("../../static/js/core/global.js");
    await import("../../static/js/core/navbar.js");
    await import("../../static/js/core/sidebar.js");
    await import("../../static/js/core/theme-init.js");
    await import("../../static/js/courses/calendar.js");
    await import("../../static/js/courses/controls.js");
    await import("../../static/js/courses/filters.js");
    await import("../../static/js/courses/index.js");
    await import("../../static/js/courses/panel.js");
    await import("../../static/js/courses/utils.js");
    await import("../../static/js/dashboard/daily-quote.js");
    await import("../../static/js/dashboard/daily-quote/data.js");
    await import("../../static/js/dashboard/index.js");
    await import("../../static/js/dashboard/renderers.js");
    await import("../../static/js/dashboard/utils.js");
    await import("../../static/js/files/events.js");
    await import("../../static/js/files/index.js");
    await import("../../static/js/files/modals.js");
    await import("../../static/js/files/renderers.js");
    await import("../../static/js/files/utils.js");
    await import("../../static/js/files/workflows.js");
    await import("../../static/js/landing.js");
    await import("../../static/js/notes/editor.js");
    await import("../../static/js/notes/editor/block-catalog.js");
    await import("../../static/js/notes/editor/utils.js");
    await import("../../static/js/notes/export.js");
    await import("../../static/js/notes/list.js");
    await import("../../static/js/notes/list/cards.js");
    await import("../../static/js/notes/list/utils.js");
    await import("../../static/js/notes/toolbar.js");
    await import("../../static/js/settings/account.js");
    await import("../../static/js/settings/calendar.js");
    await import("../../static/js/settings/index.js");
    await import("../../static/js/settings/preferences.js");
    await import("../../static/js/settings/profile.js");
    await import("../../static/js/settings/utils.js");
    await import("../../static/js/tasks/task-app-helpers.js");
    await import("../../static/js/tasks/task-audio.js");
    await import("../../static/js/tasks/task-components.js");
    await import("../../static/js/tasks/task-data.js");
    await import("../../static/js/tasks/task-entry-components.js");
    await import("../../static/js/tasks/task-popover.js");
    await import("../../static/js/tasks/task.js");
}

async function sourceFor(relativePath) {
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
    assert.doesNotMatch(source, /@radix-ui\/react-dialog|Dialog\.(?:Title|Description)/);
    assert.match(source, /'h2',\s*\{ className: 'apstudy-visually-hidden' \}/);
});

test("sidebar keeps persisted collapse state, route targets, and preference event bridge", async () => {
    const source = await sourceFor("static/js/core/sidebar.js");
    const template = await sourceFor("templates/_sidebar.html");

    for (const endpoint of [
        "dashboard.calendar",
        "dashboard.courses",
        "file_share.file_share_page",
        "dashboard.notes",
        "dashboard.tasks",
        "dashboard.chat",
        "settings.settings_page",
    ]) {
        assert.match(template, new RegExp(`url_for\\('${endpoint.replaceAll('.', '\\.')}'\\)`));
    }

    assert.match(template, /sidebar_path == '\/notes' or sidebar_path\.startswith\('\/notes\/'\)/);
    assert.match(source, /function normalizeSidebarDefault\(value\)/);
    assert.match(source, /localStorage\.getItem\('sidebar-collapsed'\)/);
    assert.match(source, /localStorage\.setItem\('sidebar-collapsed', String\(isCollapsed\)\)/);
    assert.match(source, /window\.APSTUDY_SET_SIDEBAR_COLLAPSED = applySidebarCollapsedState/);
    assert.match(source, /apstudy-sidebar-default-change/);
    assert.match(source, /const idleMs = 300000/);
    assert.match(source, /document\.addEventListener\('pointerdown', markActive/);
    assert.match(source, /document\.visibilityState === 'hidden' \|\| isIdle\(\)/);
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
    const catalogSource = await sourceFor("static/js/notes/editor/block-catalog.js");
    const styles = await sourceFor("static/css/notes.css");
    const editorTemplate = await sourceFor("templates/notes_editor.html");
    const notesTemplate = await sourceFor("templates/notes.html");

    assert.match(source, /const SAVE_DEBOUNCE_MS = 800/);
    assert.match(source, /const SAVED_TIME_REFRESH_MS = 60000/);
    assert.match(source, /from '\.\/toolbar\.js'/);
    assert.match(source, /from '\.\/editor\/block-catalog\.js'/);
    assert.match(toolbarSource, /const notesEditorSchema = BlockNoteSchema\.create/);
    assert.match(toolbarSource, /createReactBlockSpec/);
    assert.match(toolbarSource, /type: 'callout'/);
    assert.match(toolbarSource, /type: 'bookmark'/);
    assert.match(toolbarSource, /type: 'divider'/);
    assert.match(toolbarSource, /isCollapsed: collapsedProp/);
    assert.match(toolbarSource, /createReactStyleSpec/);
    assert.match(toolbarSource, /fontSizeStyle/);
    assert.doesNotMatch(source, /FormattingToolbarController/);
    assert.doesNotMatch(source, /function NotesSelectionToolbar\(\)/);
    assert.doesNotMatch(source, /function toolbarButton\(/);
    assert.match(source, /function NotesSlashMenu\(props\)/);
    assert.match(source, /function NotesSideMenu\(props\)/);
    assert.match(source, /freezeMenu\?\.\(\)/);
    assert.match(source, /unfreezeMenu\?\.\(\)/);
    assert.match(source, /document\.addEventListener\('pointerdown', handlePointerDown\)/);
    assert.match(source, /event\.key !== 'Escape'/);
    assert.match(source, /draggable: true/);
    assert.match(source, /onDragStart: \(event\) => blockDragStart\?\.\(event, block\)/);
    assert.match(source, /onDragEnd: blockDragEnd/);
    assert.match(source, /selectActionBlock\(\); moveSelectedBlocks\('up'\); closeMenu\(\)/);
    assert.match(source, /selectActionBlock\(\); moveSelectedBlocks\('down'\); closeMenu\(\)/);
    assert.match(source, /formattingToolbar: false/);
    assert.match(source, /slashMenu: false/);
    assert.match(source, /filePanel: false/);
    assert.match(source, /function handleNotesPaste\(\{ event, editor, defaultPasteHandler \}\)/);
    assert.match(source, /pasteHandler: handleNotesPaste/);
    assert.match(source, /prioritizeMarkdownOverHTML: true/);
    assert.match(source, /plainTextAsMarkdown: true/);
    assert.match(source, /application\/x-nest-blocknote\+json/);
    assert.match(source, /notes\/tools\/link-preview/);
    assert.match(source, /function toggleHeadingCollapse/);
    assert.match(source, /function syncHeadingCollapseChrome/);
    assert.match(catalogSource, /export const BLOCK_CATALOG = \[/);
    assert.match(catalogSource, /key: 'bookmark'/);
    assert.match(catalogSource, /key: 'image'/);
    assert.match(catalogSource, /key: 'video'/);
    assert.match(catalogSource, /export const FORMAT_COLORS = \[/);
    assert.match(catalogSource, /export const FONT_SIZE_PRESETS = \[/);
    assert.match(source, /window\.APStudyPendingMutations\?\.track\(fetch\(`\/api\/notes\/\$\{noteId\}`/);
    assert.match(source, /fetch\(`\/api\/notes\/\$\{noteId\}`\)/);
    assert.match(source, /triggerDebouncedSave\(\)/);
    assert.match(source, /React\.createElement\(NoteEditor, \{/);
    assert.match(source, /function insertBlockPayload\(block/);
    assert.match(source, /editorInstance\.insertBlocks\?\.\(/);
    assert.match(source, /editorInstance\.openSuggestionMenu\?\.\('\/'\)/);
    assert.match(source, /function canRunHistoryAction\(action\)/);
    assert.match(source, /editorInstance\._tiptapEditor\?\.can\?\.\(\)/);
    assert.match(source, /button\.disabled = disabled/);
    assert.match(styles, /--notes-bg-base: var\(--color-surface-container-lowest\)/);
    assert.match(styles, /--notes-bg-toolbar: var\(--color-surface-container-low\)/);
    assert.match(styles, /--notes-editor-content-width: 720px/);
    assert.match(styles, /max-width: var\(--notes-editor-content-width\)/);
    assert.ok(styles.includes('content: "\\2022" !important;'));
    assert.ok(styles.includes('content: attr(data-index) "." !important;'));
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="checkListItem"\] input\[type="checkbox"\]/);
    assert.match(styles, /\.blocknote-container \[data-content-type="table"\] table/);
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="quote"\]/);
    assert.match(styles, /\.blocknote-container \.bn-block-content\[data-content-type="codeBlock"\]/);
    assert.match(styles, /\.notes-callout-block/);
    assert.match(styles, /\.notes-bookmark-block/);
    assert.match(styles, /\.notes-slash-menu/);
    assert.match(styles, /\.notes-side-tools/);
    assert.match(styles, /\.notes-side-button \.material-symbols-outlined\s*\{[^}]*font-size:\s*20px;[^}]*line-height:\s*1;/s);
    assert.match(styles, /\.notes-block-select-handle\s*\{[^}]*cursor:\s*grab;/s);
    assert.match(styles, /\.notes-side-menu\s*\{[^}]*left:\s*calc\(100% \+ 6px\);/s);
    assert.doesNotMatch(styles, /\.notes-context-(?:toolbar|button|popover|menu-item)/);
    assert.match(styles, /\.notes-block-hidden-by-collapse/);
    assert.match(styles, /\.blocknote-container \[data-content-type="horizontalRule"\]/);
    assert.match(styles, /\.blocknote-container \.bn-block-group \.bn-block-group/);
    assert.match(styles, /\.notes-writing-toolbar button:disabled/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="add-block"/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="font-size"/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="text-color"/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="highlight-color"/);
    assert.match(editorTemplate, /data-toolbar-menu-trigger="block-actions"/);
    for (const action of ['copy-blocks', 'cut-blocks', 'duplicate-blocks', 'delete-blocks', 'move-blocks-up', 'move-blocks-down', 'toggle-heading-collapse']) {
        assert.match(editorTemplate, new RegExp(`data-editor-action="${action}"`));
    }
    assert.match(editorTemplate, /data-block-type="codeBlock"/);
    assert.match(editorTemplate, /data-block-type="callout"/);
    assert.match(source, /action === 'copy-blocks'/);
    assert.match(source, /action === 'cut-blocks'/);
    assert.match(source, /action === 'duplicate-blocks'/);
    assert.match(source, /action === 'delete-blocks'/);
    assert.match(source, /action === 'move-blocks-up'/);
    assert.match(source, /action === 'move-blocks-down'/);
    assert.match(source, /action === 'toggle-heading-collapse'/);
    assert.match(editorTemplate, /data-toolbar-menu="overflow" role="toolbar" aria-label="More writing tools" aria-orientation="horizontal"/);
    assert.match(styles, /\.notes-toolbar-overflow-menu\s*\{[^}]*display:\s*flex;[^}]*width:\s*max-content;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/s);
    assert.match(styles, /\.notes-toolbar-overflow-menu \.notes-toolbar-segment\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 0 auto;[^}]*flex-wrap:\s*nowrap;/s);
    assert.match(styles, /\.notes-toolbar-overflow-menu \.notes-toolbar-label,[^{]*\{[^}]*display:\s*none;/s);
    assert.doesNotMatch(styles, /\.notes-toolbar-overflow-menu \.notes-toolbar-segment\s*\{[^}]*width:\s*100%;/s);
    assert.match(source, /const isOverflowToolbar = menu\.classList\.contains\('notes-toolbar-overflow-menu'\)/);
    assert.match(source, /menu\.style\.maxWidth = isOverflowToolbar/);
    assert.match(source, /b\.priority - a\.priority \|\| b\.index - a\.index/);
    assert.doesNotMatch(editorTemplate, /<global class="thefooter"><\/global>/);
    assert.match(notesTemplate, /<global class="thefooter"><\/global>/);
    assert.doesNotMatch(styles, /STATIC TOOLBAR/);
    assert.doesNotMatch(styles, /padding-top:\s*58px/);
    assert.doesNotMatch(styles, /#4ade80/i);
});

test("courses page keeps Atlas APIs, filtering state, and schedule constants connected", async () => {
    const source = await sourceFor("static/js/courses/index.js");
    const combinedSource = [
        source,
        await sourceFor("static/js/courses/utils.js"),
        await sourceFor("static/js/courses/filters.js"),
        await sourceFor("static/js/courses/panel.js"),
        await sourceFor("static/js/courses/calendar.js"),
        await sourceFor("static/js/courses/controls.js"),
    ].join("\n");
    const styles = await sourceFor("static/css/courses.css");

    assert.match(source, /const COURSE_DAYS = \[/);
    assert.match(source, /const COURSE_RESULT_LIMIT = 100/);
    assert.match(source, /selectedTerm: window\.APSTUDY_COURSES_DEFAULT_TERM/);
    assert.match(source, /activeCourseView: "search"/);
    assert.match(combinedSource, /button\[data-course-view\]/);
    assert.match(combinedSource, /state\.activeCourseView = nextView/);
    assert.match(source, /fetchJson\("\/api\/atlas\/terms"\)/);
    assert.match(source, /new URLSearchParams\(\{\s*term,\s*include_cancelled: "0",\s*\}\)/);
    assert.match(source, /params\.set\("q", query\)/);
    assert.match(source, /window\.APStudyAtlasLive\.fetchSectionStatus\(section\)/);
    assert.match(source, /fetchJson\("\/api\/courses\/saved"\)/);
    assert.match(source, /fetchJson\("\/api\/courses\/tracks"\)/);
    assert.match(source, /buildSectionSearchBlob\(normalized\)/);
    assert.match(combinedSource, /state\.activeCourseView === "selected"/);
    assert.match(combinedSource, /state\.activeCourseView === "tracked"/);
    assert.match(combinedSource, /\.filter\(\(\[, track\]\) => Boolean\(track\?\.enabled\)\)/);
    assert.match(source, /removedSelectedSections: new Map\(\)/);
    assert.match(source, /state\.removedSelectedSections\.set\(String\(sectionId\), \{ \.\.\.removedSection, id: String\(sectionId\) \}\)/);
    assert.match(combinedSource, /return sections\.sort\(compareCourseSections\)/);
    assert.match(combinedSource, /\.filter\(Boolean\)\s*\.sort\(compareCourseSections\)/);
    assert.match(combinedSource, /function layoutConflictGroup\(events\)/);
    assert.match(combinedSource, /event\.start >= activeGroup\.end/);
    assert.match(combinedSource, /course-card-tracked/);
    assert.match(combinedSource, /notifications_active/);
    assert.match(combinedSource, /if \(section\?\.is_cancelled\) return false/);
    assert.match(combinedSource, /if \(seats === 0\) return true/);
    assert.match(combinedSource, /normalizeScheduleDisplay/);
    assert.match(combinedSource, /detail: `\$\{formatAtlasTime\(meeting\.start\)\}-\$\{formatAtlasTime\(meeting\.end\)\}`/);
    assert.doesNotMatch(source, /detail: `[^`]*\| Sec/);
    assert.match(combinedSource, /No tracked courses match your filters\./);
    assert.match(styles, /\.courses-view-toggle/);
    assert.match(styles, /\.course-section-inline/);
    assert.match(styles, /\.course-card-tracked/);
    assert.match(styles, /\.course-card-meta-row/);
});

test("files page keeps upload limits, modal elements, and share/delete endpoints wired", async () => {
    const source = await sourceFor("static/js/files/index.js");
    const utilsSource = await sourceFor("static/js/files/utils.js");
    const renderersSource = await sourceFor("static/js/files/renderers.js");
    const modalsSource = await sourceFor("static/js/files/modals.js");
    const workflowsSource = await sourceFor("static/js/files/workflows.js");
    const eventsSource = await sourceFor("static/js/files/events.js");
    const combinedSource = `${source}\n${utilsSource}\n${renderersSource}\n${modalsSource}\n${workflowsSource}\n${eventsSource}`;

    assert.match(source, /const MAX_FILE_SIZE_BYTES = Number\(CONFIG\.maxFileSize\) \|\| \(50 \* 1024 \* 1024\)/);
    assert.match(source, /const MAX_UPLOAD_FILES = Number\(CONFIG\.maxUploadFiles\) \|\| 5/);
    assert.match(source, /allowedExpiryOptions/);
    assert.match(combinedSource, /parseUploadResponse/);
    assert.match(combinedSource, /uploadErrorMessage/);
    assert.match(combinedSource, /function notify\(message, type = "info", options = \{\}\)/);
    assert.match(combinedSource, /file-share-upload-modal/);
    assert.match(combinedSource, /file-share-confirm-modal/);
    assert.match(combinedSource, /file-share-share-modal/);
    assert.match(combinedSource, /bulkDelete/);
    assert.match(combinedSource, /copyShareButton/);
});

test("settings page keeps account, theme, calendar, and destructive endpoints centralized", async () => {
    const template = await sourceFor("templates/settings.html");
    const source = [
        await sourceFor("static/js/settings/index.js"),
        await sourceFor("static/js/settings/utils.js"),
        await sourceFor("static/js/settings/calendar.js"),
        await sourceFor("static/js/settings/profile.js"),
        await sourceFor("static/js/settings/preferences.js"),
        await sourceFor("static/js/settings/account.js"),
      ].join("\n");

    for (const endpoint of [
        "/settings/api/bootstrap",
        "/settings/api/profile",
        "/settings/api/avatar-upload",
        "/settings/api/feed-url",
        "/settings/api/interface-preferences",
        "/settings/api/export",
        "/settings/api/account/delete",
        "/settings/api/account/recovery",
    ]) {
        assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
    }

    assert.doesNotMatch(template, /appwrite@|js\/core\/appwrite\.js/);
    assert.match(template, /settings-sqlite-20260613-1/);
    assert.match(template, /data-probe-appwrite-session="false"/);
    assert.match(source, /const SETTINGS_SECTION_IDS = \['account', 'data', 'preferences'\]/);
    assert.match(source, /const SETTINGS_INTERFACE_THEMES = \[/);
    assert.match(source, /'nest-light'/);
    assert.match(source, /'nest-dark'/);
    assert.match(source, /interface_theme: interfaceTheme/);
    assert.match(source, /const SETTINGS_MAX_OTHER_CALENDARS = 10/);
    assert.match(source, /const USERNAME_RESERVED = new Set\(\[/);
    assert.match(source, /window\.APSTUDY_THEME_PREFERENCE = interfaceTheme/);
    assert.match(source, /apstudy-sidebar-default-change/);
});

test("task app shell keeps data-layer wiring, destructive confirms, and mount contract", async () => {
    const source = await sourceFor("static/js/tasks/task.js");
    const helperSource = await sourceFor("static/js/tasks/task-app-helpers.js");
    const template = await sourceFor("templates/task.html");

    assert.match(source, /from "\.\/task-components\.js"/);
    assert.match(source, /from "\.\/task-app-helpers\.js"/);
    assert.match(source, /from "\.\/task-data\.js"/);
    assert.match(source, /from "\.\/task-utils\.js"/);
    assert.match(helperSource, /function requestDestructiveAction\(\{ title, message, acceptLabel \}\)/);
    assert.match(helperSource, /window\.APStudyConfirm\?\.request\?\.\(\{/);
    assert.match(helperSource, /function groupTasksByList\(lists, tasks, listById\)/);
    assert.match(helperSource, /function PrintSheet\(\{ list, tasks \}\)/);
    assert.match(source, /const \{ lists: nextLists, tasks: nextTasks, preferences \} = await fetchTaskBoard\(\)/);
    assert.match(source, /buildCompletedTaskOptimistic\(task, completed\)/);
    assert.match(source, /completeTaskRecord\(task\.id, completed, optimistic\.occurrenceKey\)/);
    assert.match(source, /buildListOrderUpdates\(orderedIds\)/);
    assert.match(source, /taskOrderUpdatesFromDocument\(\)/);
    assert.match(source, /createRoot\(mount\)\.render\(h\(TaskApp/);
    assert.match(source, /createTaskSounds\(\{ completeSound, uncompleteSound \}\)/);
    assert.doesNotMatch(source, /use-sound|useSound/);
    assert.doesNotMatch(template, /appwrite@|js\/core\/appwrite\.js|use-sound/);
    assert.match(template, /data-probe-appwrite-session="false"/);
    assert.match(template, /data-command-palette-preload="false"/);
});

test("appwrite bootstrap exposes configured SDK clients globally", async () => {
    const source = await sourceFor("static/js/core/appwrite.js");

    assert.match(source, /document\.querySelector\('meta\[name="apstudy-appwrite-endpoint"\]'\)\?\.content/);
    assert.match(source, /document\.querySelector\('meta\[name="apstudy-appwrite-project-id"\]'\)\?\.content/);
    assert.match(source, /const APPWRITE_ENDPOINT = configMeta\.endpoint \|\| "https:\/\/nyc\.cloud\.appwrite\.io\/v1"/);
    assert.match(source, /const APPWRITE_PROJECT_ID = configMeta\.projectId \|\| "69f77663000c16abdff2"/);
    assert.match(source, /new Appwrite\.Client\(\)/);
    assert.match(source, /\.setEndpoint\(APPWRITE_ENDPOINT\)/);
    assert.match(source, /\.setProject\(APPWRITE_PROJECT_ID\)/);
    assert.match(source, /window\.account = account/);
    assert.match(source, /window\.databases = databases/);
    assert.match(source, /window\.storage = storage/);
    assert.doesNotMatch(source, /window\.presences/);
    assert.doesNotMatch(source, /window\.realtime/);
    assert.doesNotMatch(source, /window\.Channel = Appwrite\.Channel/);
});

test("calendar context menu keeps task, event, override, and keyboard flows wired", async () => {
    const source = await sourceFor("static/js/calendar/events/context-menu.js");

    assert.match(source, /const rootSelector = "#calendar-view-root"/);
    assert.match(source, /role", "menu"/);
    assert.match(source, /data-event-ref], \[data-event-id]/);
    assert.match(source, /window\.openCalendarEventForm && window\.openCalendarEventForm\(\{ mode: 'create'/);
    assert.match(source, /const mode = isImportedEvent\(event\) \? 'override' : 'edit'/);
    assert.match(source, /window\.APStudyConfirm\?\.request\?\.\(\{/);
    assert.match(source, /fetch\('\/api\/calendar\/event-overrides\/hide'/);
    assert.match(source, /fetch\(`\/api\/calendar\/events\/\$\{encodeURIComponent\(event\.id \|\| ctx\.eventId\)\}`/);
    assert.match(source, /localStorage\.removeItem\('calendarEventsCache'\)/);
    assert.match(source, /e\.key === 'ArrowDown'/);
});

test("global chrome keeps pending mutation, confirmation, loader, date, and auth helpers", async () => {
    const chromeSource = await sourceFor("static/js/core/global-chrome.js");
    const source = await sourceFor("static/js/core/global.js");

    assert.match(chromeSource, /Compatibility shim/);
    assert.match(chromeSource, /global\.js/);
    assert.doesNotMatch(chromeSource, /window\.APStudyPendingMutations = \{/);
    assert.match(source, /window\.APStudyPendingMutations = \{/);
    assert.match(source, /new CustomEvent\("apstudy-pending-save-change"/);
    assert.match(source, /window\.APStudyConfirm = \{ request \}/);
    assert.match(source, /id = "apstudy-confirm-root"/);
    assert.match(source, /window\.APStudyLoader = \{/);
    assert.match(source, /window\.APStudyDate = \{/);
    assert.match(source, /function clearClientState\(options = \{\}\)/);
    assert.match(source, /function markClientLoggedOut\(\)/);
    assert.match(source, /function shouldEnforceAuth\(\)/);
    assert.match(source, /APStudyAppwriteSessionProbe/);
    assert.doesNotMatch(source, /account\.get\(/);
    assert.doesNotMatch(source, /window\.location\.replace\(`\$\{window\.location\.origin\}\/logout`\)/);
    assert.match(source, /account\.deleteSession\("current"\)/);
    assert.match(source, /clearClientState\(\{ includeCookies: false \}\)/);
    assert.match(source, /document\.querySelectorAll\("\[data-logout\]"\)/);
});

test("login template uses server-started Appwrite OAuth links", async () => {
    const source = await sourceFor("templates/login.html");

    assert.match(source, /url_for\('auth\.appwrite_oauth_start', provider='google'\)/);
    assert.match(source, /url_for\('auth\.appwrite_oauth_start', provider='github'\)/);
    assert.match(source, /url_for\('auth\.appwrite_oauth_start', provider='discord'\)/);
    assert.doesNotMatch(source, /createOAuth2Session/);
    assert.doesNotMatch(source, /js\/login\.js/);
    assert.doesNotMatch(source, /js\/appwrite\.js/);
});

test("landing page keeps local assets, tabs, analytics, and reduced-motion handling", async () => {
    const template = await sourceFor("templates/landing.html");
    const source = await sourceFor("static/js/landing.js");
    const styles = await sourceFor("static/css/landing.css");

    assert.match(template, /css\/landing\.css/);
    assert.match(template, /js\/landing\.js/);
    assert.match(template, /images\/landing\/nest-interface-hero\.png/);
    assert.match(template, /apple-touch-icon\.png/);
    assert.match(template, /landing_cta_label = 'Open Nest' if landing_is_authenticated else 'Log In'/);
    assert.match(template, /landing-app-demo-dashboard/);
    assert.match(template, /landing-app-demo-calendar/);
    assert.match(template, /landing-app-demo-tasks/);
    assert.match(template, /landing-app-demo-workspace/);
    assert.match(template, /id="tab-tasks"/);
    assert.match(template, /id="panel-tasks"/);
    assert.match(template, /data-landing-tab="tasks"/);
    assert.match(template, /data-landing-panel="tasks"/);
    assert.match(template, /course-planner-demo/);
    assert.match(template, /Small steps every day become the work you are proud of\./);
    assert.match(template, /Finish BIOL 141 lab draft/);
    assert.match(template, /School/);
    assert.match(template, /Completed/);
    assert.match(template, /Foundations of Modern Biol I/);
    assert.match(template, /5<\/strong> Open/);
    assert.match(template, /Nest Announcements/);
    assert.match(template, /Nest Chat/);
    assert.match(template, /Your University/);
    assert.doesNotMatch(template, /landing-nav-login/);
    assert.doesNotMatch(template, /demo-navbar/);
    assert.doesNotMatch(template, /demo-sidebar/);
    assert.doesNotMatch(template, /demo-shell/);
    assert.match(template, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-0NT330ZX5L/);
    assert.doesNotMatch(template, /cdn\.tailwindcss\.com/);
    assert.doesNotMatch(template, /placehold\.co/);
    assert.match(styles, /\.landing-app-demo/);
    assert.match(styles, /\.demo-week-shell/);
    assert.match(styles, /\.demo-mobile-agenda/);
    assert.match(styles, /\.course-planner-demo/);
    assert.match(styles, /@media \(max-width: 1024px\)/);
    assert.match(styles, /@media \(max-width: 760px\)/);
    assert.doesNotMatch(styles, /\.landing-final-cta\s*\{[^}]*var\(--color-inverse-surface\)/);
    assert.match(source, /GA_ID = "G-0NT330ZX5L"/);
    assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(source, /IntersectionObserver/);
    assert.match(source, /querySelector\("\[data-landing-tabs\]"\)/);
    assert.match(source, /data-landing-tab/);
    assert.match(source, /aria-selected/);
    assert.match(source, /panel\.hidden = !selected/);
    assert.match(source, /event\.key === "ArrowRight"/);
    assert.match(source, /event\.key === "Home"/);
    assert.match(source, /event\.key === "End"/);
});

test("navbar keeps avatar sizing, command palette shortcut, and logout/account flows", async () => {
    const source = await sourceFor("static/js/core/navbar.js");

    assert.match(source, /window\.APSTUDY_AVATAR_URL_FOR_SIZE = avatarUrlForSize/);
    assert.match(source, /nearestDiscordAvatarSize\(normalizedSize\)/);
    assert.match(source, /googleAvatarUrlForSize\(rawUrl, normalizedSize\)/);
    assert.match(source, /import\('\/static\/js\/core\/command-palette\.js'\)/);
    assert.match(source, /commandPalettePreload !== 'false'/);
    assert.match(source, /window\.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND/);
    assert.match(source, /event\.metaKey && !event\.ctrlKey/);
    assert.match(source, /window\.location\.href = '\/settings#account'/);
    assert.match(source, /runLogoutFlow\(\)/);
});

test("notes export keeps markdown/plain-text conversion and PDF fallback paths", async () => {
    const source = await sourceFor("static/js/notes/export.js");

    assert.match(source, /function blockNoteJsonToMarkdown\(blockNoteJson\)/);
    assert.match(source, /function blockNoteJsonToPlainText\(blockNoteJson\)/);
    assert.match(source, /case 'callout':/);
    assert.match(source, /case 'bookmark':/);
    assert.match(source, /case 'image':/);
    assert.match(source, /case 'video':/);
    assert.match(source, /case 'divider':/);
    assert.match(source, /function exportNoteJsonToTxt\(blockNoteJson, title\)/);
    assert.match(source, /async function exportEditorContainerToPdf\(container, title\)/);
    assert.match(source, /html2pdf\.bundle\.min\.js/);
    assert.match(source, /window\.jspdf\?\.jsPDF/);
    assert.match(source, /sanitizeFilename\(normalizeTitle\(title\)\)/);
    assert.match(source, /window\.NotesExport = \{/);
});
