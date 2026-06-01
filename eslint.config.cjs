module.exports = [
    {
        ignores: [
            ".next/**",
            ".venv/**",
            "node_modules/**",
            "Fall_2026/**",
            "Spring_2026/**",
            "data/**",
            "static/css/**",
        ],
    },
    {
        files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
        },
        rules: {},
    },
];
