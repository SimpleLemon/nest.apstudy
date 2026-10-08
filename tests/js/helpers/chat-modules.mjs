import { readFile } from "node:fs/promises";

const modules = new Map();
export async function chatModuleUrl(name) {
  return browserModuleUrl(new URL(`../../../static/js/chat/${name}`, import.meta.url));
}

// Node treats repository .js files as CommonJS. Relink only relative module
// specifiers so these tests execute the browser owners and their real helpers.
async function browserModuleUrl(file) {
  file.search = "";
  const key = file.href;
  if (modules.has(key)) return modules.get(key);
  let source = await readFile(file, "utf8");
  const references = [...source.matchAll(/(?:from\s+|import\s*)(["'])(\.[^"']+)\1/g)];
  for (const [, quote, reference] of references) {
    const dependency = await browserModuleUrl(new URL(reference, file));
    source = source.replaceAll(`${quote}${reference}${quote}`, JSON.stringify(dependency));
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  modules.set(key, url);
  return url;
}
export async function importChatModule(name) {
  return import(await chatModuleUrl(name));
}

const { createChatStore } = await importChatModule("store.js");

export function createTestChatStore(state, cache = null) {
  const roomKey = (room) => room ? `${room.type}:${room.id}` : "";
  state.roomCache ||= new Map();
  if (cache && state.activeRoom) state.roomCache.set(roomKey(state.activeRoom), cache);
  return createChatStore({
    state,
    identity: { roomKey, currentUserId: () => "test-user" },
    scheduler: { scheduleTransientTimeout: () => {} },
    persistentCache: { read: async () => null, write: async () => {} },
  });
}

export function installChatHttpStub(browserWindow, fetchJson) {
  browserWindow.APStudyHttp = { fetchJson };
}
