import { expect, test } from "playwright/test";

for (const { scale, expected } of [{ scale: 1, expected: 32 }, { scale: 2, expected: 64 }]) {
    test(`inline logo selects the ${expected}px local asset at ${scale}x density`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: scale });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseURL}/static/css/global.css`);
        await page.setContent(`<!doctype html><html><body><img id="logo" src="/static/images/brand/nest-logo-v1-32.png" srcset="/static/images/brand/nest-logo-v1-32.png 1x, /static/images/brand/nest-logo-v1-64.png 2x" alt="APStudy" width="32" height="32"></body></html>`);
        const logo = page.getByRole("img", { name: "APStudy" });
        await expect.poll(() => logo.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
        await expect(logo).toBeVisible();
        await expect.poll(() => logo.evaluate((element) => new URL(element.currentSrc).pathname))
            .toBe(`/static/images/brand/nest-logo-v1-${expected}.png`);
        await expect(logo).toHaveCSS("width", "32px");
        await expect(logo).toHaveCSS("height", "32px");
        expect(errors).toEqual([]);
        await context.close();
    });
}
