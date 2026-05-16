/**
 * Add this to EVERY page's <head>, BEFORE stylesheets if possible
 * <script src="{{ url_for('static', filename='js/theme-init.js') }}"></script>
 */
(function() {
    var DARK_THEMES = ['obsidian-dark', 'nest-dark'];
    var VALID_THEMES = ['obsidian-dark', 'parchment-light', 'system-match', 'nest-light', 'nest-dark'];
    var STORAGE_KEY = 'apstudy-theme';
    var PENDING_STORAGE_KEY = 'apstudy-theme-pending';
    var PENDING_UPDATED_KEY = 'apstudy-theme-updated-at';

    var root = document.documentElement;
    var stored = normalizeThemePreference(getStoredTheme());
    var pending = normalizeThemePreference(getPendingTheme());
    var overrideTheme = normalizeThemePreference(window.APSTUDY_THEME_PREFERENCE || root.dataset.apstudyThemePreference);
    var lockTheme = window.APSTUDY_THEME_LOCKED === true || root.dataset.apstudyThemeLocked === 'true';
    var theme;

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            return '';
        }
    }

    function getPendingTheme() {
        try {
            return localStorage.getItem(PENDING_STORAGE_KEY);
        } catch (error) {
            return '';
        }
    }

    function clearPendingTheme() {
        try {
            localStorage.removeItem(PENDING_STORAGE_KEY);
            localStorage.removeItem(PENDING_UPDATED_KEY);
        } catch (error) {
            // Ignore storage failures so theme switching still works visually.
        }
    }

    function normalizeThemePreference(value) {
        var normalized = String(value || '').trim().toLowerCase();

        if (normalized === 'dark') {
            return 'obsidian-dark';
        }
        if (normalized === 'light') {
            return 'parchment-light';
        }
        if (normalized === 'auto' || normalized === 'system') {
            return 'system-match';
        }
        if (VALID_THEMES.indexOf(normalized) !== -1) {
            return normalized;
        }
        return '';
    }

    function isDarkTheme(themeValue) {
        if (themeValue === 'system-match') {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        return DARK_THEMES.indexOf(themeValue) !== -1;
    }

    function applyThemePreference(nextTheme, options) {
        var normalizedTheme = normalizeThemePreference(nextTheme);
        var applyOptions = options || {};

        if (!normalizedTheme) {
            normalizedTheme = 'obsidian-dark';
        }

        window.APSTUDY_THEME_PREFERENCE = normalizedTheme;
        root.setAttribute('data-theme', normalizedTheme);
        root.classList.toggle('dark', isDarkTheme(normalizedTheme));

        if (applyOptions.persist !== false) {
            try {
                localStorage.setItem(STORAGE_KEY, normalizedTheme);
            } catch (error) {
                // Ignore storage failures so theme switching still works visually.
            }
        }

        if (!applyOptions.silent) {
            document.dispatchEvent(new CustomEvent('apstudy-theme-change', {
                detail: { theme: normalizedTheme },
            }));
        }

        return normalizedTheme;
    }

    window.APSTUDY_SET_THEME_PREFERENCE = applyThemePreference;

    if (!lockTheme && pending) {
        theme = pending;
    } else if (overrideTheme) {
        theme = overrideTheme;
    } else if (!lockTheme && stored) {
        theme = stored;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        theme = 'obsidian-dark';
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        theme = 'parchment-light';
    } else {
        theme = 'obsidian-dark';
    }

    applyThemePreference(theme, { persist: false, silent: true });

    if (!lockTheme && pending && typeof window.fetch === 'function') {
        var persistPendingTheme = function() {
            fetch('/settings/api/interface-preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interface_theme: pending }),
            }).then(function(response) {
                if (response.ok) {
                    clearPendingTheme();
                }
            }).catch(function() {
                // Keep pending theme for later retry.
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', persistPendingTheme, { once: true });
        } else {
            window.setTimeout(persistPendingTheme, 0);
        }
    }
})();
