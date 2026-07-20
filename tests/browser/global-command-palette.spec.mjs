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
    await page.addScriptTag({ type: "module", url: `${baseURL}/static/js/core/command-palette.js` });
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
