import { expect, test } from "playwright/test";

test("calendar events activate and expose valid context actions without a mouse", async ({ page, baseURL }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/calendar-event-keyboard-harness", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><body><div id="calendar-view-root">
      <div role="button" tabindex="0" aria-haspopup="menu" aria-label="Office hours, July 21 at 2 PM, Personal. Open event. More actions available." data-event-id="event-1" data-event-ref="event-1">Office hours</div>
    </div></body></html>`,
  }));
  await page.goto(`${baseURL}/calendar-event-keyboard-harness`);
  await page.evaluate(() => {
    window.state = { public: { readOnly: false } };
    window.getCalendarEventByRef = () => ({ id: "event-1", title: "Office hours", start: "2026-07-21T14:00:00", end: "2026-07-21T15:00:00" });
    window.__formCalls = [];
    window.openCalendarEventForm = (payload) => window.__formCalls.push(payload.mode);
  });
  await page.addScriptTag({ url: `${baseURL}/static/js/calendar/events/context-menu.js` });
  await page.evaluate(() => window.APStudyCalendarEventMenu.register());

  const event = page.getByRole("button", { name: /Office hours, July 21 at 2 PM/ });
  await event.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__formCalls)).toEqual(["edit"]);

  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Event actions" });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "View / Edit Event" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete Event" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(event).toBeFocused();

  await page.evaluate(() => { document.body.dataset.calendarReadonly = "true"; });
  await page.keyboard.press("ContextMenu");
  await expect(page.getByRole("menuitem", { name: "View Event" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate Event" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete Event" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__formCalls)).toEqual(["edit", "view"]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
