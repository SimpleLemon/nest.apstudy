import { CHAT_CACHE_SCHEMA, mergeMessages, roomCachePayload, updateCacheCursors } from "./cache.js";

/**
 * @typedef {{type: "channel" | "thread", id: string}} ChatRoomRef
 * @typedef {{id: string, created_at?: string, content?: string, can_delete?: boolean,
 *   delete_expires_at?: string | null, delivery_state?: "sending" | "failed"} & Record<string, unknown>} ChatMessage
 * @typedef {{id: string, online_users?: Array<{id: string}>, active_users?: Array<{id: string}>}
 *   & Record<string, unknown>} ChatRoomRecord
 * @typedef {{messages: ChatMessage[], oldestCursor: string | null, oldestMessageId: string | null, latestCursor: string | null,
 *   latestMessageId: string | null, hasMore: boolean, loaded: boolean, stale: boolean,
 *   scrollTop: number}} ChatRoomCache
 * @typedef {{room: ChatRoomRef, messages: ChatMessage[], hasMore: boolean,
 *   scrollTop: number, savedAt: number}} ChatRoomCachePayload
 * @typedef {{hasMore?: boolean}} ChatMessageWriteOptions
 * @typedef {{persist?: boolean}} ChatScrollOptions
 * @typedef {{key: string, cache: ChatRoomCache, message: ChatMessage, index: number}} RemovedChatMessage
 * @typedef {{read: (key: string) => Promise<unknown>, write: (key: string, value: unknown) => Promise<void>}} PersistentChatCache
 */

/**
 * Keeps per-room snapshots; live writes take precedence over pending disk reads.
 * @param {{
 *   state: {activeRoom: ChatRoomRef | null, roomCache: Map<string, ChatRoomCache>},
 *   identity: {currentUserId: () => string, roomKey: (room: ChatRoomRef | null | undefined) => string},
 *   scheduler: {scheduleTransientTimeout: (callback: () => void, delay?: number) => number},
 *   persistentCache: PersistentChatCache
 * }} context
 */
export function createChatStore({ state, identity, scheduler, persistentCache }) {
  /** @param {string} suffix @returns {string} */
  function persistentCacheKey(suffix) {
    const userId = identity.currentUserId();
    return userId ? `${CHAT_CACHE_SCHEMA}:user:${userId}:${suffix}` : "";
  }

  /** @param {ChatRoomCachePayload | null} payload @param {ChatRoomCache | null} cache @returns {boolean} */
  function applyRoomCachePayload(payload, cache) {
    if (!payload?.room) return false;
    if (!cache) return false;
    const snapshot = roomCachePayload(payload.room, payload);
    cache.messages = snapshot.messages;
    cache.hasMore = snapshot.hasMore;
    cache.loaded = true;
    cache.stale = true;
    cache.scrollTop = Number(payload.scrollTop) || 0;
    updateCacheCursors(cache);
    return true;
  }

  /** @param {ChatRoomRef | null} room @returns {Promise<void>} */
  async function persistRoomCache(room) {
    const cache = cacheFor(room);
    if (!cache?.loaded) return;
    await persistentCache.write(
      persistentCacheKey(`room:${identity.roomKey(room)}`),
      roomCachePayload(room, cache)
    );
  }

  /** @param {ChatRoomRef} room @returns {Promise<boolean>} */
  async function hydrateRoomFromPersistentCache(room) {
    const cache = cacheFor(room);
    if (!cache || cache.loaded || cache.messages.length) return false;
    const initialMessages = cache.messages;
    const payload = /** @type {ChatRoomCachePayload | null} */ (
      await persistentCache.read(persistentCacheKey(`room:${identity.roomKey(room)}`))
    );
    // A live load or realtime merge owns the newer snapshot while disk is read.
    if (cache.loaded || cache.messages !== initialMessages || cache.messages.length) return false;
    if (cacheFor(room) !== cache || identity.roomKey(payload?.room) !== identity.roomKey(room)) return false;
    return applyRoomCachePayload(payload, cache);
  }

  /** @param {ChatRoomRef} room @returns {void} */
  function schedulePersistentRoomSave(room) {
    scheduler.scheduleTransientTimeout(() => {
      void persistRoomCache(room);
    }, 0);
  }

  /** @param {ChatRoomRef | null | undefined} room @returns {ChatRoomCache | null} */
  function cacheFor(room) {
    const key = identity.roomKey(room);
    if (!key) return null;
    if (!state.roomCache.has(key)) {
      state.roomCache.set(key, {
        messages: [],
        oldestCursor: null,
        oldestMessageId: null,
        latestCursor: null,
        latestMessageId: null,
        hasMore: false,
        loaded: false,
        stale: false,
        scrollTop: 0,
      });
    }
    return state.roomCache.get(key);
  }

  /**
   * Merge live updates or replace a server snapshot, then publish the stored change.
   * @param {ChatRoomRef} room
   * @param {ChatMessage[]} messages
   * @param {ChatMessageWriteOptions & {replace?: boolean}} [options]
   * @returns {{room: ChatRoomRef, cache: ChatRoomCache, messages: ChatMessage[], incoming: ChatMessage[]}|null}
   */
  function writeRoomMessages(room, messages, { replace = false, hasMore } = {}) {
    const cache = cacheFor(room);
    if (!cache) return null;
    const previousIds = new Set(cache.messages.map((message) => message.id));
    const nextMessages = mergeMessages(replace ? [] : cache.messages, messages);
    cache.messages = nextMessages;
    cache.loaded = true;
    cache.stale = false;
    if (hasMore !== undefined) cache.hasMore = Boolean(hasMore);
    updateCacheCursors(cache);
    schedulePersistentRoomSave(room);
    return {
      room,
      cache,
      messages: nextMessages,
      incoming: nextMessages.filter((message) => !previousIds.has(message.id)),
    };
  }

  /** @param {ChatRoomRef} room @param {ChatMessage[]} messages @param {ChatMessageWriteOptions} [options] @returns {ReturnType<typeof writeRoomMessages>} */
  function mergeRoomMessages(room, messages, options) {
    return writeRoomMessages(room, messages, options);
  }

  /** @param {ChatRoomRef} room @param {ChatMessage[]} messages @param {ChatMessageWriteOptions} [options] @returns {ReturnType<typeof writeRoomMessages>} */
  function replaceRoomMessages(room, messages, options = {}) {
    return writeRoomMessages(room, messages, { ...options, replace: true });
  }

  /** @param {ChatRoomRef} room @param {string} messageId @param {ChatMessage["delivery_state"]} deliveryState @returns {ReturnType<typeof writeRoomMessages>} */
  function updateMessageDelivery(room, messageId, deliveryState) {
    const message = cacheFor(room)?.messages.find((row) => row.id === messageId);
    if (!message) return null;
    return mergeRoomMessages(room, [{ ...message, delivery_state: deliveryState }]);
  }

  /** @param {ChatRoomRef | null} room @param {number} scrollTop @param {ChatScrollOptions} [options] @returns {void} */
  function saveRoomScroll(room, scrollTop, { persist = true } = {}) {
    const cache = cacheFor(room);
    if (!cache) return;
    cache.scrollTop = scrollTop;
    if (persist) schedulePersistentRoomSave(room);
  }

  /** @param {ChatRoomRef} room @returns {void} */
  function markRoomStale(room) {
    const cache = cacheFor(room);
    if (cache) cache.stale = true;
  }

  /** @param {string} messageId @returns {RemovedChatMessage[]} */
  function removeMessageFromCaches(messageId) {
    if (!messageId) return [];
    /** @type {RemovedChatMessage[]} */
    const removed = [];
    for (const [key, cache] of state.roomCache.entries()) {
      const nextMessages = [];
      cache.messages.forEach((message, index) => {
        if (message.id === messageId) {
          removed.push({ key, cache, message, index });
        } else {
          nextMessages.push(message);
        }
      });
      if (nextMessages.length === cache.messages.length) continue;
      cache.messages = nextMessages;
      updateCacheCursors(cache);
      const [type, id] = key.split(":");
      if (type && id) schedulePersistentRoomSave({ type, id });
    }
    return removed;
  }

  /** @param {RemovedChatMessage[]} [removed] @returns {ChatRoomCache|null} */
  function restoreMessagesToCaches(removed = []) {
    for (const record of removed) {
      if (!record?.cache || record.cache.messages.some((message) => message.id === record.message?.id)) continue;
      const messages = [...record.cache.messages];
      messages.splice(Math.min(record.index, messages.length), 0, record.message);
      record.cache.messages = messages;
      updateCacheCursors(record.cache);
      const [type, id] = String(record.key || "").split(":");
      if (type && id) schedulePersistentRoomSave({ type, id });
    }
    return cacheFor(state.activeRoom);
  }

  return { mergeRoomMessages, replaceRoomMessages, updateMessageDelivery, saveRoomScroll, cacheFor, persistRoomCache, hydrateRoomFromPersistentCache, schedulePersistentRoomSave, markRoomStale, removeMessageFromCaches, restoreMessagesToCaches };
}
