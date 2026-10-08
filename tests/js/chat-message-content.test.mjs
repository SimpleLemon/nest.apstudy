import assert from "node:assert/strict";
import test from "node:test";
import { importChatModule } from "./helpers/chat-modules.mjs";

const { createChatMessagesDom } = await importChatModule("messages-dom.js");
const noop = () => {};

// A small mutable content surface exercises the public patch method's DOM
// contract: preserving a lead header, replacing content, and updating status.
function messageNode(markup) {
  const contentStart = markup.indexOf(">", markup.indexOf('<div class="chat-message-content"')) + 1;
  let html = markup.slice(contentStart, markup.lastIndexOf("</div>"));
  const content = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    insertAdjacentHTML: (_position, value) => { html += value; },
    querySelector(selector) {
      if (selector !== ".chat-message-head") throw new Error(`Unexpected content selector ${selector}`);
      const header = html.match(/<div class="chat-message-head"[^>]*>[\s\S]*?<\/div>/)?.[0];
      if (!header) return null;
      return {
        outerHTML: header,
        querySelector: () => ({ remove: () => {
          html = html.replace(/<(?:span|button) class="chat-(?:delivery-state|message-retry)"[^>]*>[\s\S]*?<\/(?:span|button)>/, "");
        } }),
        insertAdjacentHTML: (_position, value) => {
          html = html.replace(/(<div class="chat-message-head"[^>]*>[\s\S]*?)(<\/div>)/, `$1${value}$2`);
        },
      };
    },
  };
  return {
    content,
    classList: { contains: (name) => name === "chat-message-continuation" && markup.includes('class="chat-message chat-message-continuation"') },
    querySelector: (selector) => selector === ".chat-message-content" ? content : null,
  };
}

function fixture() {
  const nodes = new Map();
  const pane = {
    innerHTML: "",
    querySelector: (selector) => nodes.get(selector.match(/data-message-id="(.*?)"/)?.[1]) || null,
  };
  const mediaCalls = [];
  const dom = createChatMessagesDom({
    root: { dataset: {} }, state: {}, els: { messages: pane },
    config: { ANNOUNCEMENTS_CHANNEL_ID: "announcements", GRAMMARLY_DISABLED_ATTRS: 'data-gramm="false"' },
    rooms: { activeChannel: () => null }, scheduler: { scheduleTransientFrame: noop },
    extensions: { messageMedia: {
      renderAttachments: (attachments) => { mediaCalls.push(["attachments", attachments]); return `<aside class="attachment">${attachments[0]?.name || ""}</aside>`; },
      renderGif: (gif) => { mediaCalls.push(["gif", gif]); return `<figure class="gif">${gif?.title || ""}</figure>`; },
    } },
  });
  const loadNodes = () => {
    for (const markup of pane.innerHTML.match(/<article\b[\s\S]*?<\/article>/g) || []) {
      nodes.set(markup.match(/data-message-id="(.*?)"/)[1], messageNode(markup));
    }
  };
  return { dom, pane, nodes, loadNodes, mediaCalls };
}

function message(id, minute) {
  return { id, author_name: "Author", user_id: "user", created_at: `2026-01-01T12:0${minute}:00Z`,
    content: '<unsafe & "text">', delivery_state: "sending", images: [{ url: "/image.png", filename: "picture" }],
    attachments: [{ name: "document" }], gif: { title: "animation" },
    previews: [{ title: "Preview", url: "/link", description: "Details" }] };
}

function assertContent(html, { inlineDelivery = true } = {}) {
  assert.match(html, /&lt;unsafe &amp; &quot;text&quot;&gt;/);
  const leadingSections = inlineDelivery
    ? ["chat-message-body", "chat-delivery-state"]
    : ["chat-delivery-state", "chat-message-body"];
  const sections = [...leadingSections, "chat-message-images", 'class="attachment"', 'class="gif"', "chat-preview"];
  const positions = sections.map((section) => html.indexOf(section));
  assert.ok(positions.every((position) => position >= 0));
  assert.ok(positions.slice(1).every((position, index) => position > positions[index]), "Message content and status retain their display order");
  assert.equal((html.match(/chat-message-body/g) || []).length, 1);
  assert.equal((html.match(/class="attachment"/g) || []).length, 1);
}

test("lead and continuation rendering share complete media content with distinct status placement", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const f = fixture();
    f.dom.renderMessages([message("lead", 0), message("continuation", 1)]);
    f.loadNodes();
    assert.equal(f.nodes.size, 2);
    const lead = f.nodes.get("lead").content.innerHTML;
    assert.ok(lead.indexOf("chat-delivery-state") < lead.indexOf("chat-message-body"));
    assertContent(lead, { inlineDelivery: false });
    assertContent(f.nodes.get("continuation").content.innerHTML);
    assert.deepEqual(f.mediaCalls.map(([kind]) => kind), ["attachments", "gif", "attachments", "gif"]);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("public patches refresh every content section and replace delivery state in its original location", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    const f = fixture();
    f.dom.renderMessages([message("lead", 0), message("continuation", 1)]);
    f.loadNodes();
    for (const id of ["lead", "continuation"]) {
      const updated = { ...message(id, 0), rendered_html: '<em>Updated body</em>', content: "ignored",
        images: [{ url: "/new.png" }], attachments: [{ name: "new document" }], gif: { title: "new animation" },
        previews: [{ title: "New preview", url: "/new-link" }], delivery_state: "failed" };
      assert.equal(f.dom.patchMessageInDom(updated), true);
      const html = f.nodes.get(id).content.innerHTML;
      for (const value of ["<em>Updated body</em>", "/new.png", "new document", "new animation", "New preview"]) assert.ok(html.includes(value));
      assert.doesNotMatch(html, /Sending…|unsafe|\/image\.png/);
      assert.equal((html.match(/chat-message-retry/g) || []).length, 1);
      if (id === "lead") {
        assert.match(html, />Author<\/button>/);
        assert.ok(html.indexOf("chat-message-retry") < html.indexOf("chat-message-body"));
      } else {
        assert.ok(html.indexOf("chat-message-retry") > html.indexOf("chat-message-body"));
        assert.ok(html.indexOf("chat-message-retry") < html.indexOf("chat-message-images"));
      }
      assert.equal(f.dom.patchMessageInDom({ ...updated, delivery_state: undefined }), true);
      assert.doesNotMatch(f.nodes.get(id).content.innerHTML, /chat-message-retry|chat-delivery-state/);
    }
    assert.equal(f.dom.patchMessageInDom({ id: "missing" }), false);
  } finally {
    globalThis.window = previousWindow;
  }
});
