import { expect, test } from "playwright/test";

for (const colorScheme of ["light", "dark"]) {
    test(`landing has no CSP execution errors and paints in the ${colorScheme} theme`, async ({ page, baseURL }) => {
        const cspErrors = [];
        const pageErrors = [];
        page.on("console", (message) => {
            if (message.type() === "error" && /content security policy|refused to (execute|load|apply)/i.test(message.text())) {
                cspErrors.push(message.text());
            }
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.emulateMedia({ colorScheme });
        await page.addInitScript(() => {
            window.__themeAtFirstFrame = new Promise((resolve) => {
                requestAnimationFrame(() => resolve(document.documentElement.dataset.theme || ""));
            });
        });
        const response = await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
        expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
        expect(response.headers()["content-security-policy"]).not.toContain("unsafe-inline");
        const expected = colorScheme === "dark" ? "nest-dark" : "parchment-light";
        expect(await page.evaluate(() => window.__themeAtFirstFrame)).toBe(expected);
        await expect(page.locator("html")).toHaveAttribute("data-theme", expected);
        expect(cspErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
    });
}

test("locked landing theme follows system color-scheme changes", async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nest-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "parchment-light");
});
