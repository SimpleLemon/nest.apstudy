import { expect, test } from "playwright/test";

test("extracted frontend modules load with their original computed behavior", async ({ page, baseURL }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/frontend-module-harness", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head>
      <link rel="stylesheet" href="/static/css/global.css">
      <link rel="stylesheet" href="/static/css/core/feedback-overlays.css">
      <link rel="stylesheet" href="/static/css/admin.css">
      <link rel="stylesheet" href="/static/css/admin/analytics.css">
      <link rel="stylesheet" href="/static/css/admin/responsive.css">
      <link rel="stylesheet" href="/static/css/notes.css">
      <link rel="stylesheet" href="/static/css/notes/editor.css">
    </head><body class="notes-editor-body">
      <div class="apstudy-toast-host"></div>
      <main class="admin-analytics-shell"></main>
    </body></html>`,
  }));
  await page.goto(`${baseURL}/frontend-module-harness`, { waitUntil: "networkidle" });
  await page.addScriptTag({ type: "module", content: `
    import { startChatRuntime } from "/static/js/chat/runtime.js";
    import { groupMessages } from "/static/js/chat/presentation.js";
    import { mergeMessages } from "/static/js/chat/cache.js";
    startChatRuntime();
    window.__moduleResults = [groupMessages([]).length, mergeMessages([], []).length];
  ` });

  await expect.poll(() => page.evaluate(() => window.__moduleResults)).toEqual([0, 0]);
  expect(pageErrors).toEqual([]);
  expect(await page.locator(".apstudy-toast-host").evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
  expect(await page.locator(".admin-analytics-shell").evaluate((node) => getComputedStyle(node).gap)).toBe("18px");
  expect(await page.locator("body").evaluate((node) => getComputedStyle(node).display)).toBe("grid");
});
