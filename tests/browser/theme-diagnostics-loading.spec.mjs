import { expect, test } from "playwright/test";

test("theme applies at the next parser step without requesting diagnostics by default", async ({ page, baseURL }) => {
    const diagnosticsRequests = [];
    page.on("request", (request) => {
        if (request.url().endsWith("/static/js/core/console-discord.js")) diagnosticsRequests.push(request.url());
    });
    await page.goto(`${baseURL}/static/js/core/theme-init.js`);
    await page.evaluate(() => localStorage.setItem("apstudy-theme", "parchment-light"));
    await page.setContent(`<!doctype html><html><head>
        <script src="/static/js/core/theme-init.js"></script>
        <script>window.themeAtNextParserStep = document.documentElement.dataset.theme;</script>
        <link rel="stylesheet" href="/static/css/themes.css">
    </head><body></body></html>`);
    expect(await page.evaluate(() => window.themeAtNextParserStep)).toBe("parchment-light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "parchment-light");
    await page.waitForTimeout(100);
    expect(diagnosticsRequests).toEqual([]);
});

test("enabled diagnostics load independently and asynchronously after synchronous theme selection", async ({ page, baseURL }) => {
    const diagnosticsRequest = page.waitForRequest((request) => request.url().endsWith("/static/js/core/console-discord.js"));
    await page.goto(`${baseURL}/static/js/core/theme-init.js`);
    await page.evaluate(() => localStorage.setItem("apstudy-theme", "obsidian-dark"));
    await page.setContent(`<!doctype html><html><head>
        <script src="/static/js/core/theme-init.js"></script>
        <script src="/static/js/core/console-discord.js" async></script>
        <script>window.themeBeforeDiagnostics = document.documentElement.dataset.theme;</script>
    </head><body></body></html>`);
    await diagnosticsRequest;
    expect(await page.evaluate(() => window.themeBeforeDiagnostics)).toBe("obsidian-dark");
    await expect.poll(() => page.evaluate(() => window.__apstudyConsoleDiscord === true)).toBe(true);
});
