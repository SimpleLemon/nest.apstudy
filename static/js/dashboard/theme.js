(function () {
    "use strict";

    var DASHBOARD_DARK_THEME = "nest-dark";
    var DASHBOARD_LIGHT_THEME = "parchment-light";
    var DARK_THEMES = ["obsidian-dark", "nest-dark"];
    var root = document.documentElement;
    var mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function isDarkAppearance(themeValue) {
        if (themeValue === "system-match") {
            return mediaQuery.matches;
        }
        return DARK_THEMES.indexOf(themeValue) !== -1;
    }

    function resolveDashboardPalette(sourceTheme) {
        return isDarkAppearance(sourceTheme) ? DASHBOARD_DARK_THEME : DASHBOARD_LIGHT_THEME;
    }

    function applyDashboardTheme(sourceTheme, options) {
        var resolved = resolveDashboardPalette(sourceTheme || window.APSTUDY_THEME_PREFERENCE);
        var opts = options || {};

        root.setAttribute("data-theme", resolved);
        root.classList.toggle("dark", resolved === DASHBOARD_DARK_THEME);

        if (!opts.silent) {
            document.dispatchEvent(new CustomEvent("apstudy-dashboard-theme-applied", {
                detail: { theme: resolved },
            }));
        }

        return resolved;
    }

    window.APSTUDY_APPLY_DASHBOARD_THEME = applyDashboardTheme;

    applyDashboardTheme(window.APSTUDY_THEME_PREFERENCE, { silent: true });

    document.addEventListener("apstudy-theme-change", function (event) {
        var theme = event.detail && event.detail.theme;
        applyDashboardTheme(theme, { silent: true });
    });

    if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", function () {
            if (window.APSTUDY_THEME_PREFERENCE === "system-match") {
                applyDashboardTheme("system-match", { silent: true });
            }
        });
    } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(function () {
            if (window.APSTUDY_THEME_PREFERENCE === "system-match") {
                applyDashboardTheme("system-match", { silent: true });
            }
        });
    }
})();
