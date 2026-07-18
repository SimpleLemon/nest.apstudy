import { expect, test } from "playwright/test";

test("shared form, loader, skeleton, toast, and dialog primitives initialize independently", async ({ page, baseURL }) => {
    await page.route("**/ui-primitives-harness", (route) => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/static/css/core/feedback-overlays.css"></head><body><button id="trigger">Delete</button><input id="field"><script src="/static/js/core/ui-primitives.js"></script></body></html>`,
    }));
    await page.goto(`${baseURL}/ui-primitives-harness`, { waitUntil: "networkidle" });

    expect(await page.evaluate(() => Object.keys(window.APStudyUIPrimitives).sort())).toEqual([
        "confirm", "form", "loader", "skeleton", "toast",
    ]);
    expect(await page.evaluate(() => window.APStudyLoader.html("<Loading>"))).toContain("&lt;Loading&gt;");
    expect(await page.evaluate(() => window.APStudySkeleton.cards({ count: 2 }))).toContain('role="status"');

    await page.evaluate(() => window.APStudyFormField.markInvalid(document.querySelector("#field")));
    await expect(page.locator("#field")).toHaveAttribute("aria-invalid", "true");
    await page.locator("#field").fill("fixed");
    await page.evaluate(() => window.APStudyFormField.bindAutoClear(document.querySelector("#field")));
    await page.locator("#field").fill("valid");
    await expect(page.locator("#field")).not.toHaveAttribute("aria-invalid", "true");

    await page.evaluate(() => window.APStudyToast.success("Saved", { duration: 0 }));
    await expect(page.getByRole("status")).toContainText("Saved");
    await page.getByRole("button", { name: "Dismiss notification" }).click();

    await page.locator("#trigger").focus();
    await page.evaluate(() => {
        window.__confirmation = window.APStudyConfirm.request({ title: "Delete note?", acceptLabel: "Delete" });
    });
    await expect(page.getByRole("dialog", { name: "Delete note?" })).toBeVisible();
    await expect(page.locator("[data-confirm-cancel]")).toBeFocused();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.__confirmation)).toBe(false);
    await expect(page.locator("#trigger")).toBeFocused();
});
