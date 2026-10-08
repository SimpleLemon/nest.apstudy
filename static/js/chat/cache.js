/**
 * @typedef {import("./store.js").ChatMessage} ChatMessage
 * @typedef {import("./store.js").ChatRoomRef} ChatRoomRef
 * @typedef {import("./store.js").ChatRoomCache} ChatRoomCache
 * @typedef {import("./store.js").ChatRoomCachePayload} ChatRoomCachePayload
 * @typedef {import("./store.js").PersistentChatCache} PersistentChatCache
 */

const CHAT_CACHE_DB_NAME = "apstudy-chat-cache";
const CHAT_CACHE_DB_VERSION = 2;
const CHAT_CACHE_STORE = "items";
export const CHAT_CACHE_SCHEMA = "v2";
export const CHAT_CACHE_MESSAGE_LIMIT = 50;

/** @param {Partial<Pick<Window, "indexedDB">>} [browserWindow] @returns {PersistentChatCache} */
export function createPersistentChatCache(browserWindow = window) {
  let database = null;
  let databasePromise = null;

  function open() {
    if (!browserWindow.indexedDB) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      let request;
      try {
        request = browserWindow.indexedDB.open(CHAT_CACHE_DB_NAME, CHAT_CACHE_DB_VERSION);
      } catch (error) {
        console.warn("Chat cache unavailable", error);
        resolve(null);
        return;
      }
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
      try {
        const transaction = currentDatabase.transaction(CHAT_CACHE_STORE, "readonly");
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
        const request = transaction.objectStore(CHAT_CACHE_STORE).get(key);
        request.onsuccess = () => resolve(request.result?.value || null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function write(key, value) {
    if (!key || !value) return;
    const currentDatabase = await open();
    if (!currentDatabase) return;
    await new Promise((resolve) => {
      let finished = false;
      const finish = (error = null) => {
        if (finished) return;
        finished = true;
        if (error) console.warn("Failed to persist chat cache", error);
        resolve();
      };
      try {
        const transaction = currentDatabase.transaction(CHAT_CACHE_STORE, "readwrite");
        // A successful put request can still be rolled back by its transaction.
        // Cache persistence is best effort, but success waits for the commit.
        transaction.oncomplete = () => finish();
        transaction.onabort = () => finish(transaction.error || new Error("Chat cache transaction aborted."));
        transaction.onerror = () => finish(transaction.error || new Error("Chat cache transaction failed."));
        transaction.objectStore(CHAT_CACHE_STORE).put({ key, value, updatedAt: Date.now() });
      } catch (error) {
        finish(error);
      }
    });
  }

  return { read, write };
}

/**
 * Copy a message and expire its delete permission without changing the source.
 * @param {ChatMessage|null|undefined} message
 * @param {number} [now] Current Unix time in milliseconds.
 * @returns {ChatMessage|null}
 */
export function normalizeCachedMessage(message, now = Date.now()) {
  if (!message) return null;
  const normalized = { ...message };
  const deleteExpiry = normalized.delete_expires_at ? new Date(normalized.delete_expires_at) : null;
  if (deleteExpiry && !Number.isNaN(deleteExpiry.getTime()) && deleteExpiry.getTime() <= now) {
    normalized.can_delete = false;
  }
  return normalized;
}

/** @param {ChatMessage} a @param {ChatMessage} b @returns {number} */
function compareMessages(a, b) {
  const timestampOrder = String(a.created_at || "").localeCompare(String(b.created_at || ""));
  if (timestampOrder) return timestampOrder;
  const leftId = String(a.id || "");
  const rightId = String(b.id || "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/**
 * @param {Array<ChatMessage|null|undefined>|null|undefined} messages
 * @param {number} [limit]
 * @returns {ChatMessage[]}
 */
export function trimMessagesForPersistentCache(messages, limit = CHAT_CACHE_MESSAGE_LIMIT) {
  return (messages || [])
    .map((message) => normalizeCachedMessage(message))
    .filter((message) => message && message.id)
    .sort(compareMessages)
    .slice(-limit);
}

/**
 * Persist the newest messages and retain history availability when trimming.
 * @param {ChatRoomRef} room
 * @param {Partial<Pick<ChatRoomCache, "messages"|"hasMore"|"scrollTop">>|null|undefined} cache
 * @returns {ChatRoomCachePayload}
 */
export function roomCachePayload(room, cache) {
  const sourceMessages = cache?.messages || [];
  const messages = trimMessagesForPersistentCache(sourceMessages);
  return {
    room,
    messages,
    hasMore: Boolean(cache?.hasMore) || sourceMessages.filter((message) => message?.id).length > messages.length,
    scrollTop: Number(cache?.scrollTop) || 0,
    savedAt: Date.now(),
  };
}

/**
 * Sort messages in place and refresh both cursor pairs; empty caches clear them.
 * @param {(Pick<ChatRoomCache, "messages"> & Partial<ChatRoomCache>)|null|undefined} cache
 * @returns {void}
 */
export function updateCacheCursors(cache) {
  if (!cache || !cache.messages.length) {
    if (cache) {
      cache.oldestCursor = null;
      cache.oldestMessageId = null;
      cache.latestCursor = null;
      cache.latestMessageId = null;
    }
    return;
  }
  cache.messages.sort(compareMessages);
  cache.oldestCursor = cache.messages[0].created_at || null;
  cache.oldestMessageId = cache.messages[0].id || null;
  const latest = cache.messages[cache.messages.length - 1];
  cache.latestCursor = latest.created_at || null;
  cache.latestMessageId = latest.id || null;
}

/**
 * @param {Partial<Pick<ChatRoomCache, "latestCursor"|"latestMessageId">>|null|undefined} cache
 * @returns {{after?: string, after_message_id?: string}}
 */
export function deltaLoadParams(cache) {
  if (!cache?.latestCursor) return {};
  const params = { after: cache.latestCursor };
  if (cache.latestMessageId) params.after_message_id = cache.latestMessageId;
  return params;
}

/**
 * Incoming records replace matching IDs; the returned array is chronological.
 * @param {Array<ChatMessage|null|undefined>|null|undefined} existing
 * @param {Array<ChatMessage|null|undefined>|null|undefined} incoming
 * @returns {ChatMessage[]} Records retain their original object identities.
 */
export function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const message of existing || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  for (const message of incoming || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  return Array.from(byId.values())
    .sort(compareMessages);
}
