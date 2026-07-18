import { expect, test } from "playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const iconNames = (await readFile(path.join(root, "static/fonts/material-symbols-outlined-v361-icons.txt"), "utf8"))
    .trim().split(/\s+/);

test("the self-hosted subset renders every declared icon through one local font request", async ({ page, baseURL }) => {
    const requests = [];
    const errors = [];
    page.on("request", (request) => {
        if (/material-symbols.*\.woff2/.test(request.url())) requests.push(request.url());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/static/css/fonts.css`);
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="/static/css/fonts.css"></head><body>
        <button id="icon-only" aria-label="Open menu"><span class="material-symbols-outlined" aria-hidden="true">menu</span></button>
        <button id="text-button"><span class="material-symbols-outlined" aria-hidden="true">add</span>Add course</button>
        <div id="icons">${iconNames.map((name) => `<span class="material-symbols-outlined" data-icon="${name}" aria-hidden="true">${name}</span>`).join("")}</div>
    </body></html>`);
    await page.evaluate(() => document.fonts.load('24px "Material Symbols Outlined"'));
    await expect.poll(() => page.evaluate(() => document.fonts.check('24px "Material Symbols Outlined"'))).toBe(true);

    const invalid = await page.locator("#icons > span").evaluateAll((elements) => elements
        .filter((element) => element.getBoundingClientRect().width > 26)
        .map((element) => ({ icon: element.dataset.icon, width: element.getBoundingClientRect().width })));
    expect(invalid).toEqual([]);
    expect(new Set(requests.map((url) => new URL(url).pathname))).toEqual(new Set([
        "/static/fonts/material-symbols-outlined-v361-subset.woff2",
    ]));
    expect(requests.every((url) => new URL(url).origin === baseURL)).toBe(true);
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAccessibleName("Open menu");
    await expect(page.getByRole("button", { name: "Add course" })).toHaveAccessibleName("Add course");
    expect(errors).toEqual([]);
});
