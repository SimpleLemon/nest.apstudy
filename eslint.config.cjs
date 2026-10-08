const readonlyGlobals = names => Object.fromEntries(names.map(name => [name, "readonly"]));

// The globals package is not installed. List the standard runtime APIs used by
// this repository explicitly so environment mistakes do not hide app globals.
const webPlatformGlobals = readonlyGlobals([
    "AbortController", "AbortSignal", "Blob", "CompressionStream", "Event",
    "EventTarget", "File", "FormData", "Headers", "MessageChannel", "Request",
    "Response", "URL", "URLSearchParams", "clearInterval", "clearTimeout",
    "console", "crypto", "fetch", "performance", "queueMicrotask", "setInterval",
    "setTimeout", "structuredClone",
]);
const browserGlobals = {
    ...webPlatformGlobals,
    ...readonlyGlobals([
        "CSS", "ClipboardItem", "CustomEvent", "DOMParser", "EventSource",
        "HTMLAnchorElement", "HTMLElement", "IntersectionObserver", "KeyboardEvent",
        "MouseEvent", "MutationObserver", "Notification", "Option", "ResizeObserver",
        "XMLHttpRequest", "addEventListener", "alert", "cancelAnimationFrame",
        "confirm", "createImageBitmap", "document", "getComputedStyle", "history",
        "localStorage", "location", "matchMedia", "navigator", "removeEventListener",
        "reportError", "requestAnimationFrame", "self", "sessionStorage", "window",
    ]),
};
const nodeGlobals = {
    ...webPlatformGlobals,
    ...readonlyGlobals(["Buffer", "clearImmediate", "global", "process", "setImmediate"]),
};

module.exports = [
    {
        ignores: [
            ".next/**",
            ".venv/**",
            "node_modules/**",
            "Fall_2026/**",
            "Spring_2026/**",
            "data/**",
            ".desloppify/**",
            ".agents/**",
            "docs/**",
            "static/css/**",
            "static/js/core/dist/**",
            "static/js/notes/dist/**",
            "static/js/tasks/dist/**",
        ],
    },
    {
        files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
        },
        rules: {
            "no-unused-vars": "warn",
            "no-undef": "warn",
            "no-implicit-globals": "warn",
        },
    },
    {
        files: ["static/**/*.js", "temporary_rsvp/frontend/**/*.js"],
        ignores: ["static/service-worker.js"],
        languageOptions: { globals: browserGlobals },
    },
    {
        files: ["static/service-worker.js"],
        languageOptions: {
            globals: { ...webPlatformGlobals, ...readonlyGlobals(["clients", "self"]) },
        },
    },
    {
        files: [
            "*.js", "*.cjs", "*.mjs", "scripts/**/*.js", "scripts/**/*.mjs", "collaboration/**/*.mjs",
            "deploy/**/*.js", "tests/**/*.cjs", "tests/**/*.mjs",
            "static/js/calendar/build-extension.mjs",
        ],
        languageOptions: { globals: nodeGlobals },
    },
    {
        files: ["*.js", "**/*.cjs", "scripts/**/*.js", "deploy/**/*.js"],
        languageOptions: {
            sourceType: "commonjs",
            globals: readonlyGlobals(["__dirname", "__filename"]),
        },
    },
    {
        // Playwright callbacks execute in the page, while their test runners
        // execute in Node. These unit tests explicitly install browser mocks.
        files: [
            "tests/browser/**/*.mjs", "scripts/profile_navigation_memory.mjs",
            "tests/js/calendar-color-contrast.test.mjs",
            "tests/js/calendar-event-access.test.mjs",
            "tests/js/calendar-overlap-layout.test.mjs",
            "tests/js/calendar-urgency.test.mjs", "tests/js/task-utils.test.mjs",
        ],
        languageOptions: { globals: browserGlobals },
    },
    {
        files: ["static/js/community-themes/*.js"],
        languageOptions: {
            globals: Object.fromEntries([
                "document", "window", "location", "navigator", "confirm",
                "fetch", "AbortSignal", "URL", "URLSearchParams", "Blob",
                "structuredClone", "setTimeout",
            ].map(name => [name, "readonly"])),
        },
    },
    {
        files: ["static/js/community-themes/core.js"],
        languageOptions: { globals: { module: "readonly" } },
    },
    {
        // Classic templates load global.js before navbar.js.
        files: ["static/js/core/navbar.js"],
        languageOptions: { globals: { runLogoutFlow: "readonly" } },
    },
    {
        // dashboard.html loads the Sortable browser bundle before this consumer.
        files: ["static/js/dashboard/layout-editor.js"],
        languageOptions: { globals: { Sortable: "readonly" } },
    },
    // Measured 2026-08-07: 3,283 existing warnings (3,160 no-undef and
    // 123 no-unused-vars). Keep that backlog visible while enforcing the
    // clean shared browser-shell subset below.
    {
        files: ["eslint.config.cjs", "static/js/core/**/*.js"],
        rules: {
            "no-unused-vars": "error",
        },
    },
    {
        files: [
            "static/js/core/breadcrumb.js",
            "static/js/core/command-palette.js",
            "static/js/core/console-discord.js",
            "static/js/core/cookie-consent.js",
            "static/js/core/global-chrome.js",
            "static/js/core/global.js",
            "static/js/core/navbar.js",
            "static/js/core/notifications.js",
            "static/js/core/sidebar.js",
        ],
        // These nine files contain the 16 pre-existing core no-unused-vars
        // warnings and remain explicitly warning-baselined.
        rules: {
            "no-unused-vars": "warn",
        },
    },
];
