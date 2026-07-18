import { expect, test } from "playwright/test";

const picture = `
    <picture>
        <source type="image/webp" srcset="/static/images/landing/nest-interface-hero-640.webp 640w, /static/images/landing/nest-interface-hero-960.webp 960w, /static/images/landing/nest-interface-hero-1400.webp 1400w, /static/images/landing/nest-interface-hero-1800.webp 1800w" sizes="100vw">
        <img class="landing-hero-image" src="/static/images/landing/nest-interface-hero.png" srcset="/static/images/landing/nest-interface-hero-640.png 640w, /static/images/landing/nest-interface-hero-960.png 960w, /static/images/landing/nest-interface-hero-1400.png 1400w, /static/images/landing/nest-interface-hero.png 1800w" sizes="100vw" alt="Nest interface" width="1800" height="1013" fetchpriority="high">
    </picture>`;

async function renderHero(page, baseURL) {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/static/css/landing.css`);
    await page.setContent(`<!doctype html><html data-theme="nest-dark"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/static/css/themes.css">
        <link rel="stylesheet" href="/static/css/global.css">
        <link rel="stylesheet" href="/static/css/landing.css">
    </head><body class="landing-page"><section class="landing-hero">${picture}<div class="landing-hero-scrim"></div></section></body></html>`);
    const image = page.getByRole("img", { name: "Nest interface" });
    await image.evaluate((element) => element.decode());
    return { image, errors };
}

test("mobile selects the 640px WebP candidate", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const { image, errors } = await renderHero(page, baseURL);
    await expect.poll(() => image.evaluate((element) => new URL(element.currentSrc).pathname)).toBe("/static/images/landing/nest-interface-hero-640.webp");
    await expect(image).toHaveAttribute("width", "1800");
    await expect(image).toHaveAttribute("height", "1013");
    expect(errors).toEqual([]);
    await context.close();
});

test("desktop selects a higher-resolution WebP candidate", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const { image, errors } = await renderHero(page, baseURL);
    await expect.poll(() => image.evaluate((element) => new URL(element.currentSrc).pathname)).toBe("/static/images/landing/nest-interface-hero-1400.webp");
    const dimensions = await image.evaluate(async (element) => {
        const bitmap = await createImageBitmap(await (await fetch(element.currentSrc)).blob());
        const result = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return result;
    });
    expect(dimensions).toEqual({ width: 1400, height: 788 });
    expect(errors).toEqual([]);
    await context.close();
});
