import {
  ANNOUNCEMENTS_CHANNEL_ID,
  CHAT_CACHE_DB_NAME,
  CHAT_CACHE_DB_VERSION,
  CHAT_CACHE_MESSAGE_LIMIT,
  CHAT_CACHE_SCHEMA,
  CHAT_CACHE_STORE,
  ROOM_SCROLL_RESTORE_DELAY,
  els,
  root,
  state,
} from "./context.js";
import {
  currentUserId,
  parseMessageDate,
  registerKnownUsersFromState,
  roomKey,
  staleChannelPresence,
  staleThreadPresence,
  unreadKey,
} from "./utils.js";
import {
  setStatus,
  unreadAnnouncementMessages,
  updateRoomLists,
} from "./render-ui.js";
import {
  selectRoom,
} from "./load.js";
import {
  initializePresenceRealtime,
  initializeRealtime,
  loadInitialPresences,
} from "./realtime.js";
import {
  setMembersCollapsed,
} from "./actions.js";

export function persistentCacheKey(suffix) {
  const userId = currentUserId();
  return userId ? `${CHAT_CACHE_SCHEMA}:user:${userId}:${suffix}` : "";
}

export function openChatCacheDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  if (state.chatCacheDb) return Promise.resolve(state.chatCacheDb);
  if (state.chatCacheDbPromise) return state.chatCacheDbPromise;
  state.chatCacheDbPromise = new Promise((resolve) => {
    const request = window.indexedDB.open(CHAT_CACHE_DB_NAME, CHAT_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHAT_CACHE_STORE)) {
        db.createObjectStore(CHAT_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      state.chatCacheDb = request.result;
      resolve(state.chatCacheDb);
    };
    request.onerror = () => {
      console.warn("Chat cache unavailable", request.error);
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });
  return state.chatCacheDbPromise;
}

export async function readPersistentCache(key) {
  if (!key) return null;
  const db = await openChatCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(CHAT_CACHE_STORE, "readonly")
      .objectStore(CHAT_CACHE_STORE)
      .get(key);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => resolve(null);
  });
}

export async function writePersistentCache(key, value) {
  if (!key || !value) return;
  const db = await openChatCacheDb();
  if (!db) return;
  await new Promise((resolve) => {
    const request = db.transaction(CHAT_CACHE_STORE, "readwrite")
      .objectStore(CHAT_CACHE_STORE)
      .put({ key, value, updatedAt: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.warn("Failed to persist chat cache", request.error);
      resolve();
    };
  });
}

export function normalizeCachedMessage(message) {
  if (!message) return null;
  const normalized = { ...message };
  const deleteExpiry = parseMessageDate(normalized.delete_expires_at);
  if (deleteExpiry && deleteExpiry.getTime() <= Date.now()) {
    normalized.can_delete = false;
  }
  return normalized;
}

export function trimMessagesForPersistentCache(messages) {
  return (messages || [])
    .map(normalizeCachedMessage)
    .filter((message) => message && message.id)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .slice(-CHAT_CACHE_MESSAGE_LIMIT);
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

export function applyRoomCachePayload(payload) {
  if (!payload?.room) return false;
  const cache = cacheFor(payload.room);
  if (!cache) return false;
  cache.messages = trimMessagesForPersistentCache(payload.messages || []);
  cache.hasMore = Boolean(payload.hasMore);
  cache.loaded = true;
  cache.stale = true;
  cache.scrollTop = Number(payload.scrollTop) || 0;
  updateCacheCursors(cache);
  return true;
}

export async function persistRoomCache(room) {
  const cache = cacheFor(room);
  if (!cache?.loaded) return;
  await writePersistentCache(
    persistentCacheKey(`room:${roomKey(room)}`),
    roomCachePayload(room, cache)
  );
}

export async function hydrateRoomFromPersistentCache(room) {
  const payload = await readPersistentCache(persistentCacheKey(`room:${roomKey(room)}`));
  return applyRoomCachePayload(payload);
}

export async function persistBootstrapCache() {
  if (!currentUserId()) return;
  await writePersistentCache(persistentCacheKey("bootstrap"), {
    user: state.user,
    settings: state.settings,
    channels: (state.channels || []).map(staleChannelPresence),
    threads: (state.threads || []).map(staleThreadPresence),
    university: state.university,
    activeRoom: state.activeRoom,
    discordInviteUrl: root.dataset.discordInviteUrl || "",
    membersCollapsed: state.membersCollapsed,
    savedAt: Date.now(),
  });
}

export async function hydrateFromPersistentCache() {
  const payload = await readPersistentCache(persistentCacheKey("bootstrap"));
  state.persistentCacheReady = true;
  if (!payload) return false;
  if (state.serverBootstrapped) return false;

  state.user = payload.user || state.user;
  state.settings = { ...state.settings, ...(payload.settings || {}) };
  state.channels = Array.isArray(payload.channels) ? payload.channels.map(staleChannelPresence) : [];
  state.threads = Array.isArray(payload.threads) ? payload.threads.map(staleThreadPresence) : [];
  state.university = payload.university || null;
  registerKnownUsersFromState();
  if (payload.discordInviteUrl) root.dataset.discordInviteUrl = payload.discordInviteUrl;
  if (typeof payload.membersCollapsed === "boolean") setMembersCollapsed(payload.membersCollapsed);
  updateRoomLists();
  initializeRealtime();
  initializePresenceRealtime();
  void loadInitialPresences();

  const room = payload.activeRoom || (state.channels[0] && { type: "channel", id: state.channels[0].id });
  if (room) {
    await hydrateRoomFromPersistentCache(room);
    state.hydratedFromPersistentCache = true;
    await selectRoom(room, { fromCacheHydration: true, quiet: true });
  }
  return true;
}

export function schedulePersistentBootstrapSave() {
  window.setTimeout(() => {
    void persistBootstrapCache();
  }, 0);
}

export function schedulePersistentRoomSave(room) {
  window.setTimeout(() => {
    void persistRoomCache(room);
  }, 0);
}

export function cacheFor(room) {
  const key = roomKey(room);
  if (!key) return null;
  if (!state.roomCache.has(key)) {
    state.roomCache.set(key, {
      messages: [],
      oldestCursor: null,
      latestCursor: null,
      hasMore: false,
      loaded: false,
      stale: false,
      scrollTop: 0,
    });
  }
  return state.roomCache.get(key);
}

export function updateCacheCursors(cache) {
  if (!cache || !cache.messages.length) {
    cache.oldestCursor = null;
    cache.latestCursor = null;
    return;
  }
  cache.messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  cache.oldestCursor = cache.messages[0].created_at || null;
  cache.latestCursor = cache.messages[cache.messages.length - 1].created_at || null;
}

export function mergeMessages(existing, incoming) {
  const byId = new Map();
  for (const message of existing || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  for (const message of incoming || []) {
    if (message && message.id) byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export function saveActiveScroll() {
  const cache = cacheFor(state.activeRoom);
  if (cache && els.messages) {
    cache.scrollTop = els.messages.scrollTop;
    schedulePersistentRoomSave(state.activeRoom);
  }
}

export function restoreScroll(cache, shouldBottom = false) {
  window.setTimeout(() => {
    if (!els.messages) return;
    if (shouldBottom) {
      els.messages.scrollTop = els.messages.scrollHeight;
      return;
    }
    if (typeof cache?.scrollTop === "number") {
      els.messages.scrollTop = cache.scrollTop;
    }
  }, ROOM_SCROLL_RESTORE_DELAY);
}

export function isNearBottom() {
  if (!els.messages) return true;
  const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  return remaining < 140;
}

export async function fetchJson(url, options = {}) {
  if (window.APStudyHttp?.fetchJson) {
    return window.APStudyHttp.fetchJson(url, options);
  }
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Something went wrong.");
  }
  return payload;
}

export function normalizeUnreadRoom(room = {}) {
  const type = room.type === "channel" ? "channel" : room.type === "thread" ? "thread" : "";
  const id = String(room.id || "");
  if (!type || !id) return null;
  const count = Math.max(0, Number(room.unread_count || 0));
  return {
    type,
    id,
    unread_count: Math.min(count, 99),
    has_unread: room.has_unread === true || count > 0,
  };
}

export function applyChatSummary(payload = {}) {
  const nextUnread = new Map();
  for (const room of payload.rooms || []) {
    const unread = normalizeUnreadRoom(room);
    if (!unread) continue;
    nextUnread.set(unreadKey(unread.type, unread.id), unread);
  }
  state.roomUnread = nextUnread;
  updateRoomLists();
  window.dispatchEvent(new CustomEvent("apstudy-chat-summary", { detail: payload }));
  return payload;
}

export async function refreshChatSummary() {
  if (state.chatSummaryLoading || document.visibilityState === "hidden") return null;
  state.chatSummaryLoading = true;
  const startReadSeq = state.localReadSeq;
  try {
    const payload = await fetchJson("/api/chat/summary", {
      headers: { Accept: "application/json" },
    });
    if (state.localReadSeq !== startReadSeq) {
      // A local read-state change (e.g. opening a room) happened while this
      // summary was in flight; discard it so it cannot resurrect a cleared badge.
      return null;
    }
    return applyChatSummary(payload);
  } catch (_) {
    return null;
  } finally {
    state.chatSummaryLoading = false;
  }
}

export function unreadForRoom(type, id) {
  return state.roomUnread.get(unreadKey(type, id)) || { unread_count: 0, has_unread: false };
}

export function setRoomUnread(room, unread = {}) {
  const key = roomKey(room);
  if (!key) return;
  const count = Math.max(0, Number(unread.unread_count || 0));
  state.roomUnread.set(key, {
    type: room.type,
    id: room.id,
    unread_count: Math.min(count, 99),
    has_unread: unread.has_unread === true || count > 0,
  });
  updateRoomLists();
}

export function incrementRoomUnread(room) {
  if (!room?.type || !room?.id) return;
  if (String(room.actor_id || "") === currentUserId()) return;
  const current = unreadForRoom(room.type, room.id);
  setRoomUnread(room, {
    unread_count: Math.min(Number(current.unread_count || 0) + 1, 99),
    has_unread: true,
  });
}

export function clearRoomUnread(room) {
  const key = roomKey(room);
  if (!key) return;
  state.localReadSeq += 1;
  state.roomUnread.set(key, {
    type: room.type,
    id: room.id,
    unread_count: 0,
    has_unread: false,
  });
  updateRoomLists();
}

export function latestMessageForRead(cache) {
  const messages = cache?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.id) return message;
  }
  return null;
}

export function shouldAutoMarkRoomRead(room, cache = cacheFor(room)) {
  if (room?.type === "channel" && room.id === ANNOUNCEMENTS_CHANNEL_ID) {
    return unreadAnnouncementMessages(cache?.messages, state.roomReadState).length === 0;
  }
  return true;
}

export function markRoomRead(room, cache = cacheFor(room)) {
  if (!room?.type || !room?.id || document.visibilityState === "hidden") return;
  if (!shouldAutoMarkRoomRead(room, cache)) return;
  const latest = latestMessageForRead(cache);
  const body = {
    scope_type: room.type === "channel" ? "channel" : "thread",
    scope_id: room.id,
  };
  if (latest?.id) body.message_id = latest.id;
  void fetchJson("/api/chat/read", {
    method: "POST",
    body: JSON.stringify(body),
  })
    .then(() => {
      clearRoomUnread(room);
      window.dispatchEvent(new CustomEvent("apstudy-chat-read-state-change", { detail: { room } }));
      void refreshChatSummary();
    })
    .catch(() => {});
}

export async function markRoomUnread(room) {
  if (!room?.type || !room?.id) return;
  try {
    await fetchJson("/api/chat/unread", {
      method: "POST",
      body: JSON.stringify({
        scope_type: room.type === "channel" ? "channel" : "thread",
        scope_id: room.id,
      }),
    });
    const summary = await refreshChatSummary();
    if (!summary) setRoomUnread(room, { unread_count: 1, has_unread: true });
    window.dispatchEvent(new CustomEvent("apstudy-chat-read-state-change", { detail: { room } }));
  } catch (error) {
    setStatus(error.message || "Unable to mark room unread.", "error");
  }
}
