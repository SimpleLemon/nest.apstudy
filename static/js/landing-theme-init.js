(function () {
    var colorScheme = window.matchMedia('(prefers-color-scheme: dark)');

    function resolveLandingTheme() {
        return colorScheme.matches ? 'nest-dark' : 'parchment-light';
    }

    function applyLandingTheme() {
        var theme = resolveLandingTheme();
        window.APSTUDY_THEME_LOCKED = true;
        window.APSTUDY_THEME_PREFERENCE = theme;
        if (typeof window.APSTUDY_SET_THEME_PREFERENCE === 'function') {
            window.APSTUDY_SET_THEME_PREFERENCE(theme, { persist: false, silent: true });
        }
    }

    applyLandingTheme();
    colorScheme.addEventListener('change', applyLandingTheme);
})();
