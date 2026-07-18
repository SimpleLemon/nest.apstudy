import { expect, test } from "playwright/test";

test("media picker tabs use roving focus, explain unavailable GIFs, and restore close focus", async ({ page, baseURL }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/static/js/chat/media-picker.js`);
    await page.setContent(`<!doctype html><html><body>
        <form id="chat-composer">
            <div id="chat-pending-files" hidden><div id="chat-upload-list"></div><div id="chat-gif-selection"></div></div>
            <textarea id="chat-message-input" aria-label="Message"></textarea>
            <button id="chat-media-button" type="button" aria-expanded="false">Media</button>
        </form>
        <section id="chat-media-picker" role="dialog" aria-label="Emoji and GIF picker" hidden>
            <div role="tablist" aria-label="Media type">
                <button id="chat-emoji-tab" type="button" role="tab" aria-selected="true" aria-controls="chat-emoji-panel" tabindex="0">Emoji</button>
                <button id="chat-gif-tab" type="button" role="tab" aria-selected="false" aria-controls="chat-gif-panel" aria-describedby="chat-gif-unavailable" tabindex="-1">GIFs</button>
            </div>
            <p id="chat-gif-unavailable" class="sr-only" hidden>GIF search is unavailable because it has not been configured.</p>
            <nav id="chat-emoji-categories"></nav>
            <input id="chat-media-search" type="search" aria-label="Search emoji">
            <div id="chat-emoji-panel" role="tabpanel" aria-labelledby="chat-emoji-tab"></div>
            <div id="chat-gif-panel" role="tabpanel" aria-labelledby="chat-gif-tab" hidden><div id="chat-gif-results"></div></div>
        </section>
    </body></html>`);
    await page.evaluate(async () => {
        const { createMediaPicker } = await import("/static/js/chat/media-picker.js");
        window.mediaPicker = createMediaPicker();
        window.mediaPicker.init();
        window.mediaPicker.configure({ giphy: { available: false } });
    });

    const trigger = page.getByRole("button", { name: "Media" });
    const emojiTab = page.getByRole("tab", { name: "Emoji" });
    const gifTab = page.getByRole("tab", { name: "GIFs" });
    const emojiPanel = page.getByRole("tabpanel", { name: "Emoji" });

    await trigger.click();
    await expect(page.getByRole("searchbox", { name: "Search emoji" })).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(emojiTab).toHaveAttribute("tabindex", "0");
    await expect(gifTab).toHaveAttribute("tabindex", "-1");
    await expect(gifTab).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#chat-gif-unavailable")).not.toHaveAttribute("hidden", "");

    await emojiTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(gifTab).toBeFocused();
    await expect(gifTab).toHaveAttribute("aria-selected", "false");
    await expect(emojiPanel).toBeVisible();
    await page.keyboard.press("Home");
    await expect(emojiTab).toBeFocused();

    await page.evaluate(() => window.mediaPicker.configure({ giphy: { available: true, api_key: "test" } }));
    await page.route("https://api.giphy.com/**", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{
            id: "gif-1",
            title: "Studying cat",
            images: { fixed_width: { webp: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" } },
            analytics: { onsent: { url: "" } },
        }] }),
    }));
    await page.keyboard.press("End");
    await expect(gifTab).toBeFocused();
    await expect(gifTab).toHaveAttribute("aria-selected", "true");
    await expect(gifTab).toHaveAttribute("tabindex", "0");
    await expect(emojiTab).toHaveAttribute("tabindex", "-1");
    await expect(page.getByRole("tabpanel", { name: "GIFs" })).toBeVisible();
    await expect(emojiPanel).toBeHidden();

    await page.keyboard.press("ArrowLeft");
    await expect(emojiTab).toBeFocused();
    await expect(emojiTab).toHaveAttribute("aria-selected", "true");
    await expect(emojiPanel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Emoji and GIF picker" })).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await emojiTab.focus();
    await page.keyboard.press("End");
    await page.getByRole("button", { name: "Choose Studying cat" }).click();
    await expect(page.getByRole("dialog", { name: "Emoji and GIF picker" })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
    expect(errors).toEqual([]);
});
