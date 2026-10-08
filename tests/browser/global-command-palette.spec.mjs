import { expect, test } from "playwright/test";

const groupedPayload = {
    query: "bio",
    total: 5,
    courses_enabled: true,
    unavailable_categories: [],
    groups: {
        files: [{
            id: "file-1",
            category: "files",
            title: "Biology syllabus.pdf",
            secondary: "PDF · 2.0 MB · Fall classes",
            timestamp: "2026-07-20T16:00:00Z",
            href: "/files?file=file-1&folder=folder-1",
            icon: "description",
        }],
        notes: [{
            id: "note-1",
            category: "notes",
            title: "Biology review",
            secondary: "Cell structure and genetics",
            href: "/notes/note-1",
            icon: "article",
        }],
        events: [{
            id: "event-1",
            category: "events",
            title: "Biology midterm",
            secondary: "BIOL 141",
            timestamp: "2026-10-02T16:00:00Z",
            href: "/calendar?event=event-1&date=2026-10-02",
            icon: "calendar_today",
        }],
        messages: [{
            id: "thread-1",
            category: "messages",
            title: "Alex Morgan",
            secondary: "@alex · Emory University",
            href: "/chat?thread=thread-1",
            icon: "chat_bubble",
        }],
        courses: [{
            id: "course-1",
            category: "courses",
            title: "BIOL 141 — Foundations of Biology",
            secondary: "fall 2026 · Dr. Rivera",
            href: "/courses?section=fall-2026%7CBIOL%7C141%7C1234%7C001",
            icon: "school",
        }],
    },
};

async function openPaletteHarness(page, baseURL) {
    await page.route("**/api/search?q=*", (route) => route.fulfill({ json: groupedPayload }));
    await page.goto(`${baseURL}/static/css/global.css`);
    await page.setContent(`<!doctype html><html data-theme="nest-light"><head>
        <link rel="stylesheet" href="${baseURL}/static/css/fonts.css">
        <link rel="stylesheet" href="${baseURL}/static/css/global.css">
    </head><body><main>Palette test host</main></body></html>`);
    await page.evaluate(() => {
        window.__openedSearchResult = "";
        window.APStudyNavigation = {
            go(href) {
                window.__openedSearchResult = href;
                return true;
            },
        };
    });
    await page.addScriptTag({ type: "module", url: `${baseURL}/static/js/core/dist/command-palette.js` });
    await page.waitForFunction(() => Boolean(window.APSTUDY_COMMAND_PALETTE));
    await page.evaluate(() => window.APSTUDY_COMMAND_PALETTE.open());
}

test("Command-K groups workspace results and opens one with the keyboard", async ({ page, baseURL }) => {
    const errors = [];
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    await openPaletteHarness(page, baseURL);

    const input = page.getByRole("combobox", { name: "Command palette" });
    await expect(input).toBeVisible();
    await input.fill("bio");
    await expect(page.getByText("Biology syllabus.pdf")).toBeVisible();

    const headings = await page.locator("[cmdk-group-heading]").allTextContents();
    expect(headings.slice(0, 5)).toEqual(["Files", "Notes", "Events", "Messages", "Courses"]);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__openedSearchResult)).not.toBe("");
    expect(errors).toEqual([]);
});

test("Command-K remains bounded and usable on a narrow viewport", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openPaletteHarness(page, baseURL);
    await page.getByRole("combobox", { name: "Command palette" }).fill("bio");
    await expect(page.getByText("Biology syllabus.pdf")).toBeVisible();

    const geometry = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
        dialogHeight: document.querySelector("[cmdk-dialog]")?.getBoundingClientRect().height,
        footerVisible: Boolean(document.querySelector(".apstudy-command-palette-footer")?.getClientRects().length),
    }));
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.dialogHeight).toBeLessThanOrEqual(640);
    expect(geometry.footerVisible).toBe(true);
});

test('palette traps focus, restores its trigger, and closes through Escape and the backdrop', async ({ page, baseURL }) => {
    await openPaletteHarness(page, baseURL);
    await page.evaluate(() => window.APSTUDY_COMMAND_PALETTE.close());
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => {
        const trigger = document.createElement('button');
        trigger.textContent = 'Open search';
        trigger.onclick = () => window.APSTUDY_COMMAND_PALETTE.open();
        document.querySelector('main').appendChild(trigger);
    });
    const trigger = page.getByRole('button', { name: 'Open search' });
    await trigger.click();
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    const listId = await input.getAttribute('aria-controls');
    await expect(page.getByRole('listbox')).toHaveAttribute('id', listId);
    await expect(page.locator('main')).toHaveAttribute('aria-hidden', 'true');
    await input.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Esc to close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await input.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator('main')).not.toHaveAttribute('aria-hidden');
    await trigger.click();
    await page.locator('[cmdk-overlay]').click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(trigger).toBeFocused();
});

test('palette selects, wraps, filters commands, and resets on reopen without CDN requests', async ({ page, baseURL }) => {
    const remoteModules = [];
    page.on('request', (request) => {
        if (/esm\.sh|cdn\.jsdelivr/.test(request.url())) remoteModules.push(request.url());
    });
    await openPaletteHarness(page, baseURL);
    const input = page.getByRole('combobox', { name: 'Command palette' });
    const selected = page.locator('[role="option"][aria-selected="true"]');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Dashboard');
    await input.press('ArrowUp');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Set theme to auto');
    await input.press('ArrowDown');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Dashboard');
    await input.press('End');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Set theme to auto');
    await input.press('Home');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Dashboard');
    await input.fill('z');
    await expect(page.getByText('No commands found.')).toBeVisible();
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    await input.fill('settings');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Settings');
    await expect(input).toHaveAttribute('aria-activedescendant', await selected.getAttribute('id'));
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__openedSearchResult)).toBe('/settings');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.evaluate(() => window.APSTUDY_COMMAND_PALETTE.open());
    await expect(input).toHaveValue('');
    await expect(selected.locator('.apstudy-command-palette-item-label')).toHaveText('Dashboard');
    expect(remoteModules).toEqual([]);
});

test('workspace failure leaves matching commands available and retrying search recovers', async ({ page, baseURL }) => {
    await openPaletteHarness(page, baseURL);
    await page.route('**/api/search?q=*', (route) => route.fulfill({ status: 503, json: {} }));
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await input.fill('settings');
    await expect(page.getByText('Workspace results are unavailable. Commands still work.')).toBeVisible();
    await expect(page.getByRole('option', { name: 'Settings', exact: true })).toBeVisible();
    await page.route('**/api/search?q=*', (route) => route.fulfill({ json: groupedPayload }));
    await input.fill('bio');
    await expect(page.getByText('Biology syllabus.pdf')).toBeVisible();
    await expect(page.getByText('Workspace results are unavailable. Commands still work.')).toBeHidden();
});
