import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFor(relativePath) {
    return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("command palette keeps primary navigation, theme actions, and global controls wired", async () => {
    const source = await sourceFor("static/js/command-palette.js");

    for (const route of ["/calendar", "/courses", "/notes", "/tasks", "/files", "/chat", "/settings"]) {
        assert.match(source, new RegExp(`route: ['"]${route}['"]`));
    }

    assert.match(source, /export const COMMAND_PALETTE_PAGES\b/);
    assert.match(source, /const THEME_TO_INTERFACE_THEME = \{/);
    assert.match(source, /dark: ['"]obsidian-dark['"]/);
    assert.match(source, /light: ['"]parchment-light['"]/);
    assert.match(source, /system: ['"]system-match['"]/);
    assert.match(source, /window\.APSTUDY_COMMAND_PALETTE = commandPalette/);
});

test("calendar event form preserves escaping, API routes, and cache refresh behavior", async () => {
    const source = await sourceFor("static/js/calendar_event_form.js");

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
    const source = await sourceFor("static/js/calendar.js");

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
    assert.match(source, /function escapeHtml\(text\)/);
});

test("sidebar keeps persisted collapse state, route targets, and preference event bridge", async () => {
    const source = await sourceFor("static/js/sidebar.js");

    for (const route of ["/calendar", "/courses", "/files", "/notes", "/tasks", "/chat", "/settings"]) {
        assert.match(source, new RegExp(`data-route="${route}"`));
    }

    assert.match(source, /function normalizeSidebarDefault\(value\)/);
    assert.match(source, /localStorage\.getItem\('sidebar-collapsed'\)/);
    assert.match(source, /localStorage\.setItem\('sidebar-collapsed', String\(isCollapsed\)\)/);
    assert.match(source, /window\.APSTUDY_SET_SIDEBAR_COLLAPSED = applySidebarCollapsedState/);
    assert.match(source, /apstudy-sidebar-default-change/);
});

test("theme init normalizes theme aliases and persists pending settings safely", async () => {
    const source = await sourceFor("static/js/theme-init.js");

    assert.match(source, /var DARK_THEMES = \['obsidian-dark', 'nest-dark'\]/);
    assert.match(source, /return 'obsidian-dark'/);
    assert.match(source, /return 'parchment-light'/);
    assert.match(source, /return 'system-match'/);
    assert.match(source, /window\.APSTUDY_SET_THEME_PREFERENCE = applyThemePreference/);
    assert.match(source, /new CustomEvent\('apstudy-theme-change'/);
    assert.match(source, /fetch\('\/settings\/api\/interface-preferences'/);
    assert.match(source, /clearPendingTheme\(\)/);
});

test("notes list guards destructive actions and supports folder/export workflows", async () => {
    const source = await sourceFor("static/js/notes-list.js");

    assert.match(source, /function trackedFetch\(url, options = \{\}\)/);
    assert.match(source, /APStudyPendingMutations\?\.track\(request, 'notes-save'\)/);
    assert.match(source, /trackedFetch\(`\/api\/notes\/\$\{encodeURIComponent\(noteId\)\}`/);
    assert.match(source, /trackedFetch\(`\/api\/notes\/folders\/\$\{encodeURIComponent\(folderId\)\}`/);
    assert.match(source, /NotesExport\.exportNoteJsonToTxt/);
    assert.match(source, /NotesExport\.exportNoteJsonToPdf/);
    assert.match(source, /data-action="move"/);
});

test("notes editor keeps autosave, BlockNote schema, and load/save endpoints wired", async () => {
    const source = await sourceFor("static/js/notes-editor.js");
    const styles = await sourceFor("static/css/notes.css");

    assert.match(source, /const SAVE_DEBOUNCE_MS = 800/);
    assert.match(source, /const SAVED_TIME_REFRESH_MS = 60000/);
    assert.match(source, /const notesEditorSchema = BlockNoteSchema\.create/);
    assert.match(source, /createReactStyleSpec/);
    assert.match(source, /fontSizeStyle/);
    assert.match(source, /FormattingToolbarController/);
    assert.match(source, /function ContextualNotesToolbar\(\)/);
    assert.match(source, /formattingToolbar: false/);
    assert.doesNotMatch(source, /slashMenu:\s*false/);
    assert.doesNotMatch(source, /function FontSizeControl/);
    assert.doesNotMatch(source, /TextColorDropdown/);
    assert.match(source, /window\.APStudyPendingMutations\?\.track\(fetch\(`\/api\/notes\/\$\{noteId\}`/);
    assert.match(source, /fetch\(`\/api\/notes\/\$\{noteId\}`\)/);
    assert.match(source, /triggerDebouncedSave\(\)/);
    assert.match(source, /applyToolbarTooltips\(rootElement\)/);
    assert.match(source, /React\.createElement\(NoteEditor, \{ initialContent: parsedContent \}\)/);
    assert.match(styles, /--notes-bg-base: hsl\(220 22% 9%\)/);
    assert.match(styles, /--notes-bg-toolbar: hsl\(220 16% 20%\)/);
    assert.match(styles, /max-width: 720px/);
    assert.doesNotMatch(styles, /STATIC TOOLBAR/);
    assert.doesNotMatch(styles, /padding-top:\s*58px/);
    assert.doesNotMatch(styles, /#4ade80/i);
});

test("courses page keeps Atlas APIs, filtering state, and schedule constants connected", async () => {
    const source = await sourceFor("static/js/courses.js");

    assert.match(source, /const COURSE_DAYS = \[/);
    assert.match(source, /const COURSE_RESULT_LIMIT = 100/);
    assert.match(source, /selectedTerm: window\.APSTUDY_COURSES_DEFAULT_TERM/);
    assert.match(source, /fetchJson\("\/api\/atlas\/terms"\)/);
    assert.match(source, /fetchJson\(`\/api\/atlas\/sections\?term=\$\{encodeURIComponent\(term\)\}&include_cancelled=0`\)/);
    assert.match(source, /fetchJson\("\/api\/courses\/saved"\)/);
    assert.match(source, /fetchJson\("\/api\/courses\/tracks"\)/);
    assert.match(source, /buildSectionSearchBlob\(normalized\)/);
});

test("files page keeps upload limits, modal elements, and share/delete endpoints wired", async () => {
    const source = await sourceFor("static/js/files.js");

    assert.match(source, /const MAX_FILE_SIZE_BYTES = Number\(CONFIG\.maxFileSize\) \|\| \(50 \* 1024 \* 1024\)/);
    assert.match(source, /const MAX_UPLOAD_FILES = Number\(CONFIG\.maxUploadFiles\) \|\| 5/);
    assert.match(source, /allowedExpiryOptions/);
    assert.match(source, /file-share-upload-modal/);
    assert.match(source, /file-share-confirm-modal/);
    assert.match(source, /file-share-share-modal/);
    assert.match(source, /bulkDelete/);
    assert.match(source, /copyShareButton/);
});

test("settings page keeps account, theme, calendar, and destructive endpoints centralized", async () => {
    const source = await sourceFor("static/js/settings.js");

    for (const endpoint of [
        "/settings/api/bootstrap",
        "/settings/api/profile",
        "/settings/api/avatar-upload",
        "/settings/api/feed-url",
        "/settings/api/interface-preferences",
        "/settings/api/export",
        "/settings/api/account/delete",
    ]) {
        assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
    }

    assert.match(source, /const SETTINGS_SECTION_IDS = \['account', 'data', 'preferences'\]/);
    assert.match(source, /const SETTINGS_MAX_OTHER_CALENDARS = 10/);
    assert.match(source, /const USERNAME_RESERVED = new Set\(\[/);
    assert.match(source, /window\.APSTUDY_THEME_PREFERENCE = interfaceTheme/);
    assert.match(source, /apstudy-sidebar-default-change/);
});

test("task app shell keeps data-layer wiring, destructive confirms, and mount contract", async () => {
    const source = await sourceFor("static/js/tasks/task.js");

    assert.match(source, /from "\.\/task-components\.js"/);
    assert.match(source, /from "\.\/task-data\.js"/);
    assert.match(source, /from "\.\/task-utils\.js"/);
    assert.match(source, /function requestDestructiveAction\(\{ title, message, acceptLabel \}\)/);
    assert.match(source, /window\.APStudyConfirm\?\.request\?\.\(\{/);
    assert.match(source, /const \{ lists: nextLists, tasks: nextTasks, preferences \} = await fetchTaskBoard\(\)/);
    assert.match(source, /buildCompletedTaskOptimistic\(task, completed\)/);
    assert.match(source, /completeTaskRecord\(task\.id, completed, optimistic\.occurrenceKey\)/);
    assert.match(source, /buildListOrderUpdates\(orderedIds\)/);
    assert.match(source, /taskOrderUpdatesFromDocument\(\)/);
    assert.match(source, /createRoot\(mount\)\.render\(h\(TaskApp/);
});

test("appwrite bootstrap exposes configured SDK clients globally", async () => {
    const source = await sourceFor("static/js/appwrite.js");

    assert.match(source, /const APPWRITE_ENDPOINT = "https:\/\/nyc\.cloud\.appwrite\.io\/v1"/);
    assert.match(source, /const APPWRITE_PROJECT_ID = "69f77663000c16abdff2"/);
    assert.match(source, /new Appwrite\.Client\(\)/);
    assert.match(source, /\.setEndpoint\(APPWRITE_ENDPOINT\)/);
    assert.match(source, /\.setProject\(APPWRITE_PROJECT_ID\)/);
    assert.match(source, /window\.account = account/);
    assert.match(source, /window\.databases = databases/);
    assert.match(source, /window\.storage = storage/);
});

test("calendar context menu keeps task, event, override, and keyboard flows wired", async () => {
    const source = await sourceFor("static/js/calendar_context_menu.js");

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
    const source = await sourceFor("static/js/global.js");

    assert.match(source, /window\.APStudyPendingMutations = \{/);
    assert.match(source, /new CustomEvent\("apstudy-pending-save-change"/);
    assert.match(source, /window\.APStudyConfirm = \{ request \}/);
    assert.match(source, /id = "apstudy-confirm-root"/);
    assert.match(source, /window\.APStudyLoader = \{/);
    assert.match(source, /window\.APStudyDate = \{/);
    assert.match(source, /function clearClientState\(\)/);
    assert.match(source, /function shouldEnforceAuth\(\)/);
    assert.match(source, /account\.deleteSession\("current"\)/);
    assert.match(source, /document\.querySelectorAll\("\[data-logout\]"\)/);
});

test("login page keeps OAuth provider storage and Flask session exchange guarded", async () => {
    const source = await sourceFor("static/js/login.js");

    assert.match(source, /const providerStorageKey = "apstudy-oauth-provider"/);
    assert.match(source, /function exchangeAppwriteSession\(provider, accountData, providerAccessToken\)/);
    assert.match(source, /fetch\("\/auth\/session", \{/);
    assert.match(source, /method: "POST"/);
    assert.match(source, /appwriteAccount\.get\(\)/);
    assert.match(source, /getCurrentSessionDetails\(\)/);
    assert.match(source, /readSessionStorageItem\("apstudy-logged-out"\)/);
    for (const provider of ["github", "discord", "google"]) {
        assert.match(source, new RegExp(`provider: "${provider}"`));
    }
    assert.match(source, /createOAuth2Session\(entry\.provider, successRedirect, failureRedirect\)/);
});

test("navbar keeps avatar sizing, command palette shortcut, and logout/account flows", async () => {
    const source = await sourceFor("static/js/navbar.js");

    assert.match(source, /window\.APSTUDY_AVATAR_URL_FOR_SIZE = avatarUrlForSize/);
    assert.match(source, /nearestDiscordAvatarSize\(normalizedSize\)/);
    assert.match(source, /googleAvatarUrlForSize\(rawUrl, normalizedSize\)/);
    assert.match(source, /import\('\/static\/js\/command-palette\.js'\)/);
    assert.match(source, /window\.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND/);
    assert.match(source, /event\.metaKey && !event\.ctrlKey/);
    assert.match(source, /window\.location\.href = '\/settings#account'/);
    assert.match(source, /runLogoutFlow\(\)/);
});

test("notes export keeps markdown/plain-text conversion and PDF fallback paths", async () => {
    const source = await sourceFor("static/js/notes-export.js");

    assert.match(source, /function blockNoteJsonToMarkdown\(blockNoteJson\)/);
    assert.match(source, /function blockNoteJsonToPlainText\(blockNoteJson\)/);
    assert.match(source, /function exportNoteJsonToTxt\(blockNoteJson, title\)/);
    assert.match(source, /async function exportEditorContainerToPdf\(container, title\)/);
    assert.match(source, /html2pdf\.bundle\.min\.js/);
    assert.match(source, /window\.jspdf\?\.jsPDF/);
    assert.match(source, /sanitizeFilename\(normalizeTitle\(title\)\)/);
    assert.match(source, /window\.NotesExport = \{/);
});
