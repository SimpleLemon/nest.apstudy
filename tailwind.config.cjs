const withOpacity = (cssVariable) => ({ opacityValue, opacityVariable }) => {
    if (!opacityVariable && opacityValue !== undefined) {
        const percent = parseFloat(opacityValue) * 100;
        return `color-mix(in srgb, var(${cssVariable}) ${percent}%, transparent)`;
    }

    return `var(${cssVariable})`;
};

/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: "class",
    content: [
        "./templates/**/*.html",
        "./static/js/**/*.js",
        "./blueprints/**/*.py",
        "./app.py",
    ],
    safelist: [
        "bg-emerald-600/60",
        "border-emerald-400/70",
        "text-emerald-50",
        "text-emerald-100",
        "hover:text-white",
        "bg-red-600/60",
        "border-red-400/70",
        "text-red-50",
        "text-red-100",
    ],
    corePlugins: {
        preflight: false,
    },
    theme: {
        extend: {
            colors: {
                "surface-container": withOpacity("--color-surface-container"),
                "on-tertiary": withOpacity("--color-on-tertiary"),
                "secondary-fixed": "#d3e4ff",
                "on-surface-variant": withOpacity("--color-on-surface-variant"),
                "primary-fixed-dim": "#a2c9ff",
                "tertiary-fixed": "#ffddaf",
                "on-secondary": withOpacity("--color-on-secondary"),
                "on-tertiary-fixed": "#281800",
                "inverse-primary": withOpacity("--color-inverse-primary"),
                "surface-tint": withOpacity("--color-surface-tint"),
                "secondary-container": withOpacity("--color-secondary-container"),
                "outline": withOpacity("--color-outline"),
                "inverse-on-surface": withOpacity("--color-inverse-on-surface"),
                "surface": withOpacity("--color-surface"),
                "surface-bright": withOpacity("--color-surface-bright"),
                "surface-container-low": withOpacity("--color-surface-container-low"),
                "on-secondary-container": withOpacity("--color-on-secondary-container"),
                "surface-container-high": withOpacity("--color-surface-container-high"),
                "on-background": withOpacity("--color-on-background"),
                "outline-variant": withOpacity("--color-outline-variant"),
                "on-tertiary-fixed-variant": "#614000",
                "on-error": withOpacity("--color-on-error"),
                "secondary-fixed-dim": "#aec8ef",
                "primary-container": withOpacity("--color-primary-container"),
                "surface-variant": withOpacity("--color-surface-variant"),
                "surface-dim": withOpacity("--color-surface-dim"),
                "on-secondary-fixed-variant": "#2e4869",
                "tertiary-fixed-dim": "#ffba42",
                "inverse-surface": withOpacity("--color-inverse-surface"),
                "on-primary": withOpacity("--color-on-primary"),
                "on-error-container": withOpacity("--color-on-error-container"),
                "on-tertiary-container": withOpacity("--color-on-tertiary-container"),
                "error": withOpacity("--color-error"),
                "tertiary": withOpacity("--color-tertiary"),
                "on-surface": withOpacity("--color-on-surface"),
                "surface-container-highest": withOpacity("--color-surface-container-highest"),
                "primary": withOpacity("--color-primary"),
                "background": withOpacity("--color-background"),
                "on-primary-fixed-variant": "#004882",
                "on-primary-fixed": "#001c38",
                "primary-fixed": "#d3e4ff",
                "surface-container-lowest": withOpacity("--color-surface-container-lowest"),
                "on-primary-container": withOpacity("--color-on-primary-container"),
                "error-container": withOpacity("--color-error-container"),
                "on-secondary-fixed": "#001c38",
                "secondary": withOpacity("--color-secondary"),
                "tertiary-container": withOpacity("--color-tertiary-container"),
                "calendar-rule": withOpacity("--color-calendar-rule"),
            },
            borderRadius: {
                DEFAULT: "0.25rem",
                lg: "0.5rem",
                xl: "0.75rem",
                full: "9999px",
            },
            fontFamily: {
                headline: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Arial", "sans-serif"],
                body: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Arial", "sans-serif"],
                label: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Arial", "sans-serif"],
            },
            keyframes: {
                "fade-in-up": {
                    "0%": { opacity: "0", transform: "translateY(8px)" },
                    "100%": { opacity: "1", transform: "translateY(0)" },
                },
            },
            animation: {
                "fade-in-up": "fade-in-up 260ms ease-out both",
            },
        },
    },
};
