const CHAT_CACHE_DB_NAME = "apstudy-chat-cache";
const CHAT_CACHE_DB_VERSION = 2;
const CHAT_CACHE_STORE = "items";
export const CHAT_CACHE_SCHEMA = "v2";
export const CHAT_CACHE_MESSAGE_LIMIT = 50;

export function createPersistentChatCache(browserWindow = window) {
  let database = null;
  let databasePromise = null;

  function open() {
    if (!browserWindow.indexedDB) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      const request = browserWindow.indexedDB.open(CHAT_CACHE_DB_NAME, CHAT_CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const nextDatabase = request.result;
        if (!nextDatabase.objectStoreNames.contains(CHAT_CACHE_STORE)) {
          nextDatabase.createObjectStore(CHAT_CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        resolve(database);
      };
      request.onerror = () => {
        console.warn("Chat cache unavailable", request.error);
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  async function read(key) {
    if (!key) return null;
    const currentDatabase = await open();
    if (!currentDatabase) return null;
    return new Promise((resolve) => {
      const request = currentDatabase.transaction(CHAT_CACHE_STORE, "readonly")
        .objectStore(CHAT_CACHE_STORE)
        .get(key);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(null);
    });
  }

  async function write(key, value) {
    if (!key || !value) return;
    const currentDatabase = await open();
    if (!currentDatabase) return;
    await new Promise((resolve) => {
      const request = currentDatabase.transaction(CHAT_CACHE_STORE, "readwrite")
        .objectStore(CHAT_CACHE_STORE)
        .put({ key, value, updatedAt: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.warn("Failed to persist chat cache", request.error);
        resolve();
      };
    });
  }

  return { read, write };
}

export function normalizeCachedMessage(message, now = Date.now()) {
  if (!message) return null;
  const normalized = { ...message };
  const deleteExpiry = normalized.delete_expires_at ? new Date(normalized.delete_expires_at) : null;
  if (deleteExpiry && !Number.isNaN(deleteExpiry.getTime()) && deleteExpiry.getTime() <= now) {
    normalized.can_delete = false;
  }
  return normalized;
}

export function trimMessagesForPersistentCache(messages, limit = CHAT_CACHE_MESSAGE_LIMIT) {
  return (messages || [])
    .map((message) => normalizeCachedMessage(message))
    .filter((message) => message && message.id)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .slice(-limit);
}

export function roomCachePayload(room, cache) {
  return {
    room,
    messages: trimMessagesForPersistentCache(cache?.messages || []),
    hasMore: Boolean(cache?.hasMore),
    scrollTop: Number(cache?.scrollTop) || 0,
    savedAt: Date.now(),
  };
}

export function updateCacheCursors(cache) {
  if (!cache || !cache.messages.length) {
    if (cache) {
      cache.oldestCursor = null;
      cache.latestCursor = null;
      cache.latestMessageId = null;
    }
    return;
  }
  cache.messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  cache.oldestCursor = cache.messages[0].created_at || null;
  const latest = cache.messages[cache.messages.length - 1];
  cache.latestCursor = latest.created_at || null;
  cache.latestMessageId = latest.id || null;
}

export function deltaLoadParams(cache) {
  if (!cache?.latestCursor) return {};
  const params = { after: cache.latestCursor };
  if (cache.latestMessageId) params.after_message_id = cache.latestMessageId;
  return params;
}

export function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const message of existing || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  for (const message of incoming || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  return Array.from(byId.values())
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}
