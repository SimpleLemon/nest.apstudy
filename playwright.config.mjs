import { defineConfig } from "playwright/test";

export default defineConfig({
    testDir: "./tests/browser",
    timeout: 30_000,
    fullyParallel: false,
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8000",
        headless: true,
        viewport: { width: 1280, height: 800 },
    },
});
