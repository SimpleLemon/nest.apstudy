import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFor(relativePath) {
    return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("courses page keeps Atlas APIs, filtering state, and schedule constants connected", async () => {
    const source = await sourceFor("static/js/courses/index.js");
    const combinedSource = [
        source,
        await sourceFor("static/js/courses/utils.js"),
        await sourceFor("static/js/courses/filters.js"),
        await sourceFor("static/js/courses/panel.js"),
        await sourceFor("static/js/courses/calendar.js"),
        await sourceFor("static/js/courses/controls.js"),
        await sourceFor("static/js/courses/data.js"),
    ].join("\n");
    const styles = await sourceFor("static/css/courses.css");

    assert.match(source, /const COURSE_DAYS = \[/);
    assert.match(source, /const COURSE_RESULT_LIMIT = 100/);
    assert.match(source, /selectedTerm: window\.APSTUDY_COURSES_DEFAULT_TERM/);
    assert.match(source, /activeCourseView: "search"/);
    assert.match(combinedSource, /button\[data-course-view\]/);
    assert.match(combinedSource, /state\.activeCourseView = nextView/);
    assert.match(combinedSource, /fetchJson\("\/api\/atlas\/terms"\)/);
    assert.match(combinedSource, /new URLSearchParams\(\{\s*term,\s*include_cancelled: "0",\s*\}\)/);
    assert.match(combinedSource, /params\.set\("q", query\)/);
    assert.match(source, /window\.APStudyAtlasLive\.fetchSectionStatus\(section\)/);
    assert.match(combinedSource, /fetchJson\("\/api\/courses\/saved"\)/);
    assert.match(combinedSource, /fetchJson\("\/api\/courses\/tracks"\)/);
    assert.match(combinedSource, /buildSectionSearchBlob\(normalized\)/);
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
    assert.match(combinedSource, /if \(section\?\.is_cancelled\) return false/);
    assert.match(combinedSource, /if \(seats === 0\) return true/);
    assert.match(combinedSource, /normalizeScheduleDisplay/);
    assert.match(combinedSource, /detail: `\$\{formatAtlasTime\(meeting\.start\)\}-\$\{formatAtlasTime\(meeting\.end\)\}`/);
    assert.doesNotMatch(source, /detail: `[^`]*\| Sec/);
    assert.match(combinedSource, /No tracked courses match your filters\./);
    assert.match(styles, /\.courses-view-toggle/);
    assert.match(styles, /\.course-section-inline/);
    assert.match(styles, /\.course-card-tracked/);
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
        await sourceFor("static/js/settings/discord.js"),
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
    assert.match(template, /settings_assets_version = 'settings-[^']+'/);
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
});

test("appwrite bootstrap exposes configured SDK clients globally", async () => {
    const source = await sourceFor("static/js/core/appwrite.js");

    assert.match(source, /const APPWRITE_ENDPOINT = configMeta\.endpoint \|\| "https:\/\/nyc\.cloud\.appwrite\.io\/v1"/);
    assert.match(source, /const APPWRITE_PROJECT_ID = configMeta\.projectId \|\| "69f77663000c16abdff2"/);
    assert.match(source, /new Appwrite\.Client\(\)/);
    assert.match(source, /\.setEndpoint\(APPWRITE_ENDPOINT\)/);
    assert.match(source, /\.setProject\(APPWRITE_PROJECT_ID\)/);
    assert.match(source, /window\.account = account/);
    assert.match(source, /window\.databases = databases/);
    assert.match(source, /window\.storage = storage/);
    assert.match(source, /window\.presences = presences/);
    assert.match(source, /window\.realtime = realtime/);
    assert.match(source, /window\.Channel = Appwrite\.Channel/);
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
    const source = [
        await sourceFor("static/js/core/ui-primitives.js"),
        await sourceFor("static/js/core/global.js"),
    ].join("\n");

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
    const source = await sourceFor("static/js/core/landing.js");
    const styles = await sourceFor("static/css/landing.css");

    assert.match(template, /css\/landing\.css/);
    assert.match(template, /js\/core\/landing\.js/);
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
    assert.match(template, /3<\/strong> Open/);
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
    assert.match(source, /window\.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND/);
    assert.match(source, /event\.metaKey && !event\.ctrlKey/);
    assert.match(source, /window\.location\.href = '\/settings#account'/);
    assert.match(source, /runLogoutFlow\(\)/);
});

test("notes export keeps markdown/plain-text conversion and PDF fallback paths", async () => {
    const source = await sourceFor("static/js/notes/export.js");

    assert.match(source, /function blockNoteJsonToMarkdown\(blockNoteJson\)/);
    assert.match(source, /function blockNoteJsonToPlainText\(blockNoteJson\)/);
    assert.match(source, /function exportNoteJsonToTxt\(blockNoteJson, title\)/);
    assert.match(source, /async function exportEditorContainerToPdf\(container, title\)/);
    assert.match(source, /html2pdf\.bundle\.min\.js/);
    assert.match(source, /window\.jspdf\?\.jsPDF/);
    assert.match(source, /sanitizeFilename\(normalizeTitle\(title\)\)/);
    assert.match(source, /window\.NotesExport = \{/);
});
