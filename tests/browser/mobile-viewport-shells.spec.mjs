import { expect, test } from "playwright/test";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

test("mobile shells follow visual viewport shrink and recovery without clipping the chat composer", async ({ page, baseURL }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/static/js/core/viewport-sizing.js`);
    await page.setContent(`<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <link rel="stylesheet" href="/static/css/themes.css">
        <link rel="stylesheet" href="/static/css/global.css">
        <link rel="stylesheet" href="/static/css/layout.css">
        <link rel="stylesheet" href="/static/css/chat.css">
        <link rel="stylesheet" href="/static/css/onboarding.css">
    </head><body class="chat-body">
        <main class="chat-app">
            <section class="chat-main-panel">
                <header class="chat-topbar">Room</header>
                <div class="chat-conversation-body">
                    <div class="chat-conversation-pane">
                        <div class="chat-messages"><div class="chat-message-stack">Messages</div></div>
                        <form id="chat-composer" class="chat-composer"><textarea aria-label="Message"></textarea></form>
                    </div>
                </div>
            </section>
        </main>
        <main class="onboarding-main"><section class="onboarding-shell">Onboarding</section></main>
    </body></html>`);
    await page.evaluate(async () => {
        const { createViewportSizingController } = await import("/static/js/core/viewport-sizing.js");
        class TestViewport extends EventTarget { constructor(height) { super(); this.height = height; } }
        window.testViewport = new TestViewport(844);
        window.viewportController = createViewportSizingController({
            root: document.documentElement,
            viewport: window.testViewport,
            windowTarget: window,
            isCoarsePointer: () => true,
        });
        window.viewportController.install();
    });

    await expect(page.locator("html")).toHaveCSS("--app-viewport-height", "844px");
    await expect(page.locator(".chat-app")).toHaveCSS("height", "794px");

    await page.evaluate(() => {
        window.testViewport.height = 480;
        window.testViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("html")).toHaveCSS("--app-viewport-height", "480px");
    await expect(page.locator(".chat-app")).toHaveCSS("height", "430px");
    await expect.poll(() => page.locator("#chat-composer").evaluate((element) => element.getBoundingClientRect().bottom <= 480)).toBe(true);

    await page.evaluate(() => {
        window.testViewport.height = 844;
        window.testViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".chat-app")).toHaveCSS("height", "794px");

    await page.setViewportSize({ width: 412, height: 915 });
    await page.evaluate(() => {
        window.testViewport.height = 915;
        window.testViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".chat-app")).toHaveCSS("height", "865px");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test("desktop full-height behavior continues to follow the layout viewport", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ hasTouch: false, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${baseURL}/static/css/chat.css`);
    await page.setContent(`<!doctype html><html><head>
        <link rel="stylesheet" href="/static/css/global.css">
        <link rel="stylesheet" href="/static/css/layout.css">
        <link rel="stylesheet" href="/static/css/chat.css">
    </head><body class="chat-body"><main class="chat-app"></main></body></html>`);
    await expect(page.locator(".chat-app")).toHaveCSS("height", "850px");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
});
