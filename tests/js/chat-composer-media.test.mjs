import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (file) => readFile(path.join(root, file), "utf8");

test("chat entry point keeps composer responsibilities in adjacent modules", async () => {
  const index = await source("static/js/chat/index.js");
  assert.match(index, /attachments\.js/);
  assert.match(index, /media-picker\.js/);
  assert.match(index, /message-media\.js/);
  assert.match(index, /runtime\.js/);
});

test("chat attachments support progress, retry, cancellation, and browser gzip", async () => {
  const attachments = await source("static/js/chat/attachments.js");
  assert.match(attachments, /CompressionStream\("gzip"\)/);
  assert.match(attachments, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(attachments, /data-upload-retry/);
  assert.match(attachments, /method: "DELETE"/);
});

test("media picker has emoji keyboard navigation and a separately disabled GIF mode", async () => {
  const picker = await source("static/js/chat/media-picker.js");
  const template = await source("templates/chat.html");
  assert.match(picker, /ArrowRight/);
  assert.match(picker, /apstudy-chat-recent-emoji/);
  assert.match(picker, /capabilities\.giphy\?\.available/);
  assert.match(template, /Powered by GIPHY/);
  assert.match(picker, /analytics\?\.onsent/);
});

test("every non-image card opens the advisory download warning", async () => {
  const media = await source("static/js/chat/message-media.js");
  const template = await source("templates/chat.html");
  assert.match(media, /data-chat-download/);
  assert.match(media, /showModal/);
  assert.match(template, /Nest never submits files automatically/);
  assert.match(template, /VirusTotal/);
});
