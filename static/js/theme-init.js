/**
 * Add this to EVERY page's <head>, BEFORE stylesheets if possible
 * <script src="{{ url_for('static', filename='js/theme-init.js') }}"></script>
 */
(function() {
    var DARK_THEMES = ['obsidian-dark', 'nest-dark'];
    var VALID_THEMES = ['obsidian-dark', 'parchment-light', 'system-match', 'nest-light', 'nest-dark'];
    var STORAGE_KEY = 'apstudy-theme';

    var stored = localStorage.getItem(STORAGE_KEY);
    var overrideTheme = window.APSTUDY_THEME_PREFERENCE;
    var lockTheme = window.APSTUDY_THEME_LOCKED === true;
    var theme;

    if (overrideTheme && VALID_THEMES.indexOf(overrideTheme) !== -1) {
        theme = overrideTheme;
    } else if (!lockTheme && stored && VALID_THEMES.indexOf(stored) !== -1) {
        theme = stored;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        theme = 'obsidian-dark';
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        theme = 'parchment-light';
    } else {
        theme = 'obsidian-dark';
    }

    document.documentElement.setAttribute('data-theme', theme);

    var isDark;
    if (theme === 'system-match') {
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
        isDark = DARK_THEMES.indexOf(theme) !== -1;
    }
    document.documentElement.classList.toggle('dark', isDark);
})();