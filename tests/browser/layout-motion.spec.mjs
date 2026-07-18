import { expect, test } from "playwright/test";

const harness = `<!doctype html><html><head>
    <link rel="stylesheet" href="/static/css/themes.css">
    <link rel="stylesheet" href="/static/css/global.css">
    <link rel="stylesheet" href="/static/css/layout.css">
</head><body class="with-sidebar">
    <nav class="sidebar-container" id="sidebar-root"><span class="sidebar-item-label">Dashboard</span></nav>
    <main>Workspace</main>
</body></html>`;

async function openHarness(page, baseURL) {
    await page.route("**/layout-motion-harness", (route) => route.fulfill({
        contentType: "text/html",
        body: harness,
    }));
    await page.goto(`${baseURL}/layout-motion-harness`, { waitUntil: "networkidle" });
}

test("desktop sidebar snaps layout geometry without width or grid animation", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHarness(page, baseURL);
    const sidebar = page.locator("#sidebar-root");

    await expect(sidebar).toHaveCSS("width", "208px");
    const before = await page.locator("main").boundingBox();
    expect(before.x).toBe(208);
    await page.evaluate(() => {
        document.documentElement.classList.add("apstudy-sidebar-collapsed");
        document.body.classList.add("sidebar-collapsed");
        document.querySelector("#sidebar-root").classList.add("collapsed");
    });
    await expect(sidebar).toHaveCSS("width", "60px");
    const after = await page.locator("main").boundingBox();
    expect(after.x).toBe(60);
    const properties = await sidebar.evaluate((node) => getComputedStyle(node).transitionProperty);
    expect(properties).not.toMatch(/width|grid|margin/);
});

test("mobile sidebar uses transform motion and reduced motion makes it immediate", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHarness(page, baseURL);
    const sidebar = page.locator("#sidebar-root");

    await expect(sidebar).toHaveCSS("transform", /matrix\(1, 0, 0, 1, -/);
    await expect(sidebar).toHaveCSS("transition-duration", "0s");
    await sidebar.evaluate((node) => node.classList.add("mobile-open"));
    await expect(sidebar).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await expect(sidebar).toHaveCSS("width", "320px");
});
