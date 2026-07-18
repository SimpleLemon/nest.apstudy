import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function importBrowserModule(relativePath) {
    const source = await readFile(path.join(repoRoot, relativePath), "utf8");
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    return import(url);
}

function paragraph(id, text, type = "paragraph") {
    return {
        id,
        type,
        props: {
            textColor: "default",
            backgroundColor: "default",
            textAlignment: "left",
        },
        content: [{ type: "text", text, styles: {} }],
        children: [],
    };
}

test("notes markdown repair converts flattened glyph bullets into nested BlockNote lists", async () => {
    const { normalizeImportedMarkdownBlocks } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");

    const result = normalizeImportedMarkdownBlocks([
        paragraph("title", "Advising", "heading"),
        paragraph("marker-1", "•"),
        paragraph("item-1", "Advisor: Brigette Kinkade"),
        paragraph("marker-2", "◦"),
        paragraph("item-2", "Recommend splitting seminar and writing"),
        paragraph("marker-3", "•"),
        paragraph("item-3", "Always reach out"),
    ]);

    assert.equal(result.changed, true);
    assert.equal(result.blocks.length, 3);
    assert.equal(result.blocks[1].type, "bulletListItem");
    assert.equal(result.blocks[1].content[0].text, "Advisor: Brigette Kinkade");
    assert.equal(result.blocks[1].children.length, 1);
    assert.equal(result.blocks[1].children[0].type, "bulletListItem");
    assert.equal(result.blocks[1].children[0].content[0].text, "Recommend splitting seminar and writing");
    assert.equal(result.blocks[2].type, "bulletListItem");
    assert.equal(result.blocks[2].content[0].text, "Always reach out");
});

test("notes markdown repair keeps numbered sublists under colon-ended bullets", async () => {
    const { normalizeImportedMarkdownBlocks } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");

    const result = normalizeImportedMarkdownBlocks([
        paragraph("marker-1", "•"),
        paragraph("item-1", "Only two GERs can be satisfied with AP/IB credit:"),
        paragraph("number-1", "1."),
        paragraph("number-item-1", "First Year Writing"),
        paragraph("number-2", "2."),
        paragraph("number-item-2", "One Language requirement"),
        paragraph("marker-2", "•"),
        paragraph("item-2", "AP/IB credit can be used elsewhere"),
    ]);

    assert.equal(result.changed, true);
    assert.equal(result.blocks.length, 2);
    assert.equal(result.blocks[0].type, "bulletListItem");
    assert.equal(result.blocks[0].children.length, 2);
    assert.equal(result.blocks[0].children[0].type, "numberedListItem");
    assert.equal(result.blocks[0].children[0].content[0].text, "First Year Writing");
    assert.equal(result.blocks[0].children[1].type, "numberedListItem");
    assert.equal(result.blocks[1].type, "bulletListItem");
});

test("notes markdown repair converts dividers and quote markers", async () => {
    const { clipboardTextLooksStructured, normalizeImportedMarkdownBlocks } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");

    const result = normalizeImportedMarkdownBlocks([
        paragraph("divider", "---"),
        paragraph("quote", "> Also called GDRs."),
    ]);

    assert.equal(result.changed, true);
    assert.equal(result.blocks[0].type, "divider");
    assert.equal(result.blocks[1].type, "quote");
    assert.equal(result.blocks[1].content[0].text, "Also called GDRs.");
    assert.equal(clipboardTextLooksStructured("# Title\n\n- Item"), true);
});

test("notes markdown repair converts pasted heading markers without joining surrounding lines", async () => {
    const { normalizeImportedMarkdownBlocks } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");
    const result = normalizeImportedMarkdownBlocks([
        paragraph("intro", "Intro paragraph"),
        paragraph("heading", "## Details"),
        paragraph("body", "Body paragraph"),
    ]);

    assert.equal(result.changed, true);
    assert.equal(result.blocks.length, 3);
    assert.equal(result.blocks[1].type, "heading");
    assert.equal(result.blocks[1].props.level, 2);
    assert.equal(result.blocks[1].content[0].text, "Details");
});

test("notes markdown clipboard normalization preserves paragraphs and collapses excessive blanks", async () => {
    const { clipboardTextLooksStructured, normalizeClipboardMarkdown, normalizeClipboardText } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");

    assert.equal(
        normalizeClipboardText("First paragraph\r\n\r\nSecond paragraph"),
        "First paragraph\n\nSecond paragraph"
    );
    assert.equal(
        normalizeClipboardText("Line one   \n   \n\n\nLine two\t"),
        "Line one\n\nLine two"
    );
    assert.equal(normalizeClipboardText("Line one\nLine two\nLine three"), "Line one\nLine two\nLine three");
    assert.equal(clipboardTextLooksStructured("Line one\nLine two\nLine three"), false);
    assert.equal(
        normalizeClipboardMarkdown("•\nAdvisor: Brigette Kinkade\n◦\nRecommend splitting seminar and writing\n•\nAlways reach out"),
        "- Advisor: Brigette Kinkade\n  - Recommend splitting seminar and writing\n- Always reach out"
    );
    assert.equal(
        normalizeClipboardMarkdown("•\nOnly two GERs can be satisfied with AP/IB credit:\n1.\nFirst Year Writing\n2.\nOne Language requirement"),
        "- Only two GERs can be satisfied with AP/IB credit:\n  1. First Year Writing\n  2. One Language requirement"
    );
    assert.equal(normalizeClipboardMarkdown(">\nQuoted line"), "> Quoted line");
});

test("notes copied plain text does not add blank lines between editor blocks", async () => {
    const { normalizeCopiedPlainText } = await importBrowserModule("static/js/notes/editor/markdown-repair.js");

    assert.equal(
        normalizeCopiedPlainText("First line\n\nSecond line\n\n\nThird line\n"),
        "First line\nSecond line\nThird line"
    );
    assert.equal(normalizeCopiedPlainText("Line one\nLine two"), "Line one\nLine two");
    assert.equal(
        normalizeCopiedPlainText("Before\n\n```\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter\n"),
        "Before\n```\nconst a = 1;\n\nconst b = 2;\n```\nAfter"
    );
});
