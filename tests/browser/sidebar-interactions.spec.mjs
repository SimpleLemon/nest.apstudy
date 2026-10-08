import { expect, test } from "playwright/test";
import { openSidebarHarness } from "./helpers/sidebar-harness.mjs";

async function expectClosedMobileDrawer(page) {
    const sidebar = page.locator("#sidebar-root");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(sidebar).not.toHaveAttribute("role", "dialog");
    await expect(sidebar).not.toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#sidebar-mobile-backdrop")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toHaveAttribute("aria-expanded", "false");
}

test("navbar hamburger opens real mobile navigation; Escape and backdrop dismiss and restore focus", async ({ page, baseURL }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSidebarHarness(page, baseURL);
    await expectClosedMobileDrawer(page);

    for (const dismissal of ["Escape", "backdrop"]) {
        await page.getByRole("button", { name: "Open navigation menu" }).click();
        const drawer = page.getByRole("dialog", { name: "Primary navigation" });
        await expect(drawer).toBeVisible();
        await expect(drawer).toHaveAttribute("aria-modal", "true");
        await expect(drawer).toHaveAttribute("aria-hidden", "false");
        await expect(drawer).not.toHaveAttribute("inert", "");
        await expect(page.getByRole("button", { name: "Close navigation menu" })).toHaveAttribute("aria-expanded", "true");
        await expect(drawer.getByRole("link", { name: "Dashboard", exact: true })).toBeFocused();
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        else await page.locator("#sidebar-mobile-backdrop").click({ position: { x: 385, y: 400 } });
        await expectClosedMobileDrawer(page);
        await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeFocused();
    }
    expect(errors).toEqual([]);
});

test("breakpoint transitions synchronize inertness, backdrop and dialog attributes", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSidebarHarness(page, baseURL);
    const sidebar = page.locator("#sidebar-root");
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await page.setViewportSize({ width: 390, height: 800 });
    await expectClosedMobileDrawer(page);
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("dialog", { name: "Primary navigation" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sidebar).not.toHaveClass(/mobile-open/);
    await expect(page.locator("body")).not.toHaveClass(/mobile-sidebar-open/);
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(sidebar).not.toHaveAttribute("role", "dialog");
    await expect(sidebar).not.toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#sidebar-mobile-backdrop")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 800 });
    await expectClosedMobileDrawer(page);
});

test("desktop collapse controls persist geometry and preference independently of mobile opening", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSidebarHarness(page, baseURL);
    const sidebar = page.locator("#sidebar-root");
    await expect(sidebar).toHaveCSS("width", "208px");
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).toHaveCSS("width", "60px");
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed"))).toBe("true");
    await page.reload({ waitUntil: "networkidle" });
    await expect(sidebar).toHaveCSS("width", "60px");
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("dialog", { name: "Primary navigation" })).toHaveCSS("width", "320px");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed"))).toBe("true");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sidebar).toHaveCSS("width", "60px");
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
    await expect(sidebar).toHaveCSS("width", "208px");
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed"))).toBe("false");
});

test("server defaults, persisted overrides and preference events update the rendered sidebar", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSidebarHarness(page, baseURL, { sidebarDefault: "collapsed" });
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "false"));
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Collapse sidebar", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("apstudy-sidebar-default-change", { detail: { collapsed: true } })));
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed"))).toBe("true");
});

test("chat badge renders summary fetches and shared summary events with accessible capped counts", async ({ page, baseURL }) => {
    await page.clock.install();
    await openSidebarHarness(page, baseURL);
    let requests = 0;
    await page.route("**/api/chat/summary", route => {
        requests += 1;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ rooms: [{ unread_count: 1, has_unread: true }] }) });
    });
    await page.clock.runFor(2500);
    const badge = page.locator("[data-chat-unread-badge]");
    await expect(badge).toHaveText("1");
    await expect(badge).toHaveAttribute("aria-label", "1 unread chat message");
    expect(requests).toBe(1);
    await page.clock.runFor(120000);
    await expect.poll(() => requests).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("apstudy-chat-summary", {
        detail: { total_unread: 0, rooms: [{ unread_count: 60 }, { unread_count: 40 }] },
    })));
    await expect(badge).toHaveText("99+");
    await expect(badge).toHaveAttribute("aria-label", "99+ unread chat messages");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("apstudy-chat-summary", { detail: { total_unread: 0 } })));
    await expect(badge).toBeHidden();
    await expect(badge).toHaveText("");
    await expect(badge).not.toHaveAttribute("aria-label", /.+/);
});

test("chat summary polling stops while idle and resumes after actual shell activity", async ({ page, baseURL }) => {
    await page.clock.install();
    await openSidebarHarness(page, baseURL);
    let requests = 0;
    await page.route("**/api/chat/summary", route => {
        requests += 1;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ total_unread: requests }) });
    });
    const badge = page.locator("[data-chat-unread-badge]");
    await page.clock.runFor(2500);
    await expect(badge).toHaveText("1");
    await page.clock.runFor(120000);
    await expect(badge).toHaveText("2");
    await page.clock.runFor(120000);
    await expect(badge).toHaveText("3");
    await page.clock.runFor(300000);
    expect(requests).toBe(3);
    await page.locator("#workspace-control").click();
    await page.clock.runFor(1000);
    await expect(badge).toHaveText("4");
    expect(requests).toBe(4);
});
