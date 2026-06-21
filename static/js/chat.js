(function () {
  const root = document.querySelector(".chat-app");
  if (!root) return;

  const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2096%2096'%3E%3Crect%20width='96'%20height='96'%20rx='24'%20fill='%23e5e7eb'/%3E%3Ccircle%20cx='48'%20cy='35'%20r='17'%20fill='%239ca3af'/%3E%3Cpath%20d='M20%2082c4-18%2017-28%2028-28s24%2010%2028%2028'%20fill='%239ca3af'/%3E%3C/svg%3E";
  const PRESENCE_APP_ID = "nest-chat";
  const VIEWING_PRESENCE_REFRESH_MS = 45000;
  const VIEWING_PRESENCE_TTL_MS = 90000;
  const TYPING_PRESENCE_TTL_MS = 8000;
  const CHAT_TAB_ID_KEY = "apstudy-chat-tab-id";
  const ROOM_SCROLL_RESTORE_DELAY = 0;
  const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;
  const DISCORD_HISTORY_CHANNEL_IDS = new Set(["nest_announcements", "nest_chat"]);
  const CHAT_CACHE_DB_NAME = "apstudy-chat-cache";
  const CHAT_CACHE_DB_VERSION = 1;
  const CHAT_CACHE_STORE = "items";
  const CHAT_CACHE_SCHEMA = "v1";
  const CHAT_CACHE_MESSAGE_LIMIT = 50;
  const CHAT_PREFETCH_ROOM_LIMIT = 8;
  const REALTIME_FALLBACK_MS = 3000;
  const REALTIME_HEARTBEAT_MS = 8000;
  const REALTIME_RECONNECT_MS = 1500;
  const REALTIME_JWT_REFRESH_MS = 50 * 60 * 1000;
  const ANNOUNCEMENTS_CHANNEL_ID = "nest_announcements";

  const state = {
    user: root.dataset.currentUserId ? { id: root.dataset.currentUserId } : null,
    settings: { chat_sound_enabled: true },
    channels: [],
    threads: [],
    university: null,
    activeRoom: null,
    activeProfile: null,
    roomCache: new Map(),
    roomUnread: new Map(),
    presenceRefreshTimer: null,
    typingInputTimer: null,
    typingClearTimer: null,
    presenceUnsubscribe: null,
    presenceReady: false,
    presenceConnecting: false,
    presenceRecords: new Map(),
    knownUsers: new Map(),
    resolvingPresenceUsers: new Set(),
    lastViewingPresenceId: null,
    lastTypingPresenceId: null,
    tabId: null,
    searchTimer: null,
    scrollSaveTimer: null,
    realtimeUnsubscribe: null,
    realtimeReady: false,
    realtimeConnecting: false,
    chatSummaryLoading: false,
    localReadSeq: 0,
    contextMenuRoom: null,
    loadingMessages: false,
    roomReadState: null,
    announcementsBannerVisible: false,
    membersCollapsed: sessionStorage.getItem("apstudy-chat-members-collapsed") === "true",
    hydratedFromPersistentCache: false,
    persistentCacheReady: false,
    serverBootstrapped: false,
    prefetchingRooms: new Set(),
  };

  window.NestChat = state;

  let realtimeFallbackTimer = null;
  let realtimeHeartbeatTimer = null;
  let realtimeReconnectTimer = null;
  let appwriteJwtRefreshTimer = null;
  let chatEventSource = null;
  let chatEventCursor = { since: null, after_id: null };
  const seenChatEventIds = new Set();
  let inlineProfilePopover = null;

  const els = {
    channelList: document.getElementById("chat-channel-list"),
    dmList: document.getElementById("chat-dm-list"),
    dmNew: document.getElementById("chat-dm-new"),
    dmSearch: document.getElementById("chat-dm-search"),
    dmSearchInput: document.getElementById("chat-dm-search-input"),
    dmResults: document.getElementById("chat-dm-results"),
    roomSymbol: document.getElementById("chat-room-symbol"),
    roomName: document.getElementById("chat-room-name"),
    roomMeta: document.getElementById("chat-room-meta"),
    status: document.getElementById("chat-status"),
    historyLimited: document.getElementById("chat-history-limited"),
    announcementsUnread: document.getElementById("chat-announcements-unread"),
    announcementsRead: document.getElementById("chat-announcements-read"),
    joinDiscord: document.getElementById("chat-join-discord"),
    messages: document.getElementById("chat-messages"),
    typing: document.getElementById("chat-typing-indicator"),
    composer: document.getElementById("chat-composer"),
    input: document.getElementById("chat-message-input"),
    sendButton: document.querySelector(".chat-send-button"),
    members: document.getElementById("chat-members"),
    memberList: document.getElementById("chat-member-list"),
    membersCount: document.getElementById("chat-members-count"),
    membersRestoreCount: document.getElementById("chat-members-restore-count"),
    profilePanel: document.getElementById("chat-profile-panel"),
    profileToggle: document.querySelector("[data-toggle-members]"),
    audio: document.getElementById("chat-audio"),
  };

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function avatarUrl(url, size = 64) {
    const candidate = url || DEFAULT_AVATAR;
    if (typeof window.APSTUDY_AVATAR_URL_FOR_SIZE === "function") {
      return window.APSTUDY_AVATAR_URL_FOR_SIZE(candidate, size);
    }
    return candidate;
  }

  function avatarAttrs(url, size = 64, sizes = `${size}px`) {
    const resolved = avatarUrl(url, size);
    const src = escapeHtml(resolved);
    // Data URLs are resolution-independent and may contain spaces that break
    // srcset tokenization, so emit them with src only.
    if (/^data:/i.test(resolved)) {
      return `src="${src}" sizes="${escapeHtml(sizes)}" loading="lazy" decoding="async"`;
    }
    const src2x = escapeHtml(avatarUrl(url, size * 2));
    return `src="${src}" srcset="${src} 1x, ${src2x} 2x" sizes="${escapeHtml(sizes)}" loading="lazy" decoding="async"`;
  }

  function parseMessageDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function localDateKey(date) {
    if (!date) return "";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function calendarDayDifference(date, now = new Date()) {
    if (!date) return 0;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((start - target) / 86400000);
  }

  function formatClockTime(date) {
    if (!date) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function formatMessageTimestamp(value, now = new Date()) {
    const date = parseMessageDate(value);
    if (!date) return "";
    const time = formatClockTime(date);
    const dayDifference = calendarDayDifference(date, now);
    if (dayDifference === 0) return time;
    if (dayDifference === 1) return `Yesterday at ${time}`;
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function messageAuthorKey(message) {
    return String(message?.user_id || message?.author_username || message?.author_name || "");
  }

  function shouldGroupMessage(previous, next) {
    const previousDate = parseMessageDate(previous?.created_at);
    const nextDate = parseMessageDate(next?.created_at);
    if (!previousDate || !nextDate) return false;
    if (messageAuthorKey(previous) !== messageAuthorKey(next)) return false;
    if (localDateKey(previousDate) !== localDateKey(nextDate)) return false;
    return nextDate - previousDate <= MESSAGE_GROUP_WINDOW_MS;
  }

  function groupMessages(messages) {
    const groups = [];
    for (const message of messages || []) {
      const lastGroup = groups[groups.length - 1];
      const previous = lastGroup?.messages[lastGroup.messages.length - 1];
      if (previous && shouldGroupMessage(previous, message)) {
        lastGroup.messages.push(message);
      } else {
        groups.push({ id: message.id, messages: [message] });
      }
    }
    return groups;
  }

  function plural(value, singular, pluralLabel) {
    const number = Number(value) || 0;
    return `${number} ${number === 1 ? singular : pluralLabel}`;
  }

  function roomKey(room) {
    if (!room || !room.id || !room.type) return "";
    return `${room.type}:${room.id}`;
  }

  function unreadKey(type, id) {
    return roomKey({ type, id });
  }

  function requestedRoomFromLocation() {
    const params = new URLSearchParams(window.location.search || "");
    const channelId = params.get("channel");
    if (channelId) return { type: "channel", id: channelId };
    const threadId = params.get("thread");
    if (threadId) return { type: "thread", id: threadId };
    return null;
  }

  function currentUserId() {
    return String(state.user?.id || root.dataset.currentUserId || "");
  }

  function currentTabId() {
    if (state.tabId) return state.tabId;
    try {
      state.tabId = sessionStorage.getItem(CHAT_TAB_ID_KEY);
      if (!state.tabId) {
        state.tabId = Math.random().toString(36).slice(2, 12);
        sessionStorage.setItem(CHAT_TAB_ID_KEY, state.tabId);
      }
    } catch (_) {
      state.tabId = state.tabId || Math.random().toString(36).slice(2, 12);
    }
    return state.tabId;
  }

  function compactHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function registerKnownUser(user) {
    if (!user?.id) return;
    state.knownUsers.set(String(user.id), { ...(state.knownUsers.get(String(user.id)) || {}), ...user });
  }

  function registerKnownUsersFromState() {
    registerKnownUser(state.user);
    for (const channel of state.channels || []) {
      for (const user of channel.active_users || []) registerKnownUser(user);
    }
    for (const thread of state.threads || []) {
      registerKnownUser(thread.other_user);
    }
  }

  function staleChannelPresence(channel) {
    return {
      ...channel,
      active_count: 0,
      active_users: [],
    };
  }

  function staleThreadPresence(thread) {
    const other = thread?.other_user ? { ...thread.other_user, online: false } : thread?.other_user;
    return {
      ...thread,
      other_user: other,
      active_count: 0,
      presence_status: "offline",
    };
  }

  function roomTarget(room) {
    if (!room) return null;
    if (room.type === "channel") return state.channels.find((channel) => channel.id === room.id) || null;
    if (room.type === "thread") return state.threads.find((thread) => thread.id === room.id) || null;
    return null;
  }

  function roomPresenceScope(room) {
    const target = roomTarget(room);
    if (target?.presence_scope?.scope_type && target?.presence_scope?.scope_id) return target.presence_scope;
    if (!room?.type || !room?.id) return null;
    return {
      scope_type: room.type,
      scope_id: room.id,
      room_key: `${room.type}:${room.id}`,
    };
  }

  function roomPresencePermissions(room) {
    const target = roomTarget(room);
    return Array.isArray(target?.presence_read_permissions) ? target.presence_read_permissions : [];
  }

  function presenceScopeKey(scopeOrMetadata) {
    const scopeType = scopeOrMetadata?.scope_type || scopeOrMetadata?.scopeType;
    const scopeId = scopeOrMetadata?.scope_id || scopeOrMetadata?.scopeId;
    return scopeType && scopeId ? `${scopeType}:${scopeId}` : "";
  }

  function knownPresenceScopeKeys() {
    const keys = new Set();
    for (const channel of state.channels || []) {
      const key = presenceScopeKey(channel.presence_scope || { scope_type: "channel", scope_id: channel.id });
      if (key) keys.add(key);
    }
    for (const thread of state.threads || []) {
      const key = presenceScopeKey(thread.presence_scope || { scope_type: "thread", scope_id: thread.id });
      if (key) keys.add(key);
    }
    return keys;
  }

  function persistentCacheKey(suffix) {
    const userId = currentUserId();
    return userId ? `${CHAT_CACHE_SCHEMA}:user:${userId}:${suffix}` : "";
  }

  function openChatCacheDb() {
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

  async function readPersistentCache(key) {
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

  async function writePersistentCache(key, value) {
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

  function normalizeCachedMessage(message) {
    if (!message) return null;
    const normalized = { ...message };
    const deleteExpiry = parseMessageDate(normalized.delete_expires_at);
    if (deleteExpiry && deleteExpiry.getTime() <= Date.now()) {
      normalized.can_delete = false;
    }
    return normalized;
  }

  function trimMessagesForPersistentCache(messages) {
    return (messages || [])
      .map(normalizeCachedMessage)
      .filter((message) => message && message.id)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
      .slice(-CHAT_CACHE_MESSAGE_LIMIT);
  }

  function roomCachePayload(room, cache) {
    return {
      room,
      messages: trimMessagesForPersistentCache(cache?.messages || []),
      hasMore: Boolean(cache?.hasMore),
      scrollTop: Number(cache?.scrollTop) || 0,
      savedAt: Date.now(),
    };
  }

  function applyRoomCachePayload(payload) {
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

  async function persistRoomCache(room) {
    const cache = cacheFor(room);
    if (!cache?.loaded) return;
    await writePersistentCache(
      persistentCacheKey(`room:${roomKey(room)}`),
      roomCachePayload(room, cache)
    );
  }

  async function hydrateRoomFromPersistentCache(room) {
    const payload = await readPersistentCache(persistentCacheKey(`room:${roomKey(room)}`));
    return applyRoomCachePayload(payload);
  }

  async function persistBootstrapCache() {
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

  async function hydrateFromPersistentCache() {
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
    await startRealtimeServices();

    const room = payload.activeRoom || (state.channels[0] && { type: "channel", id: state.channels[0].id });
    if (room) {
      await hydrateRoomFromPersistentCache(room);
      state.hydratedFromPersistentCache = true;
      await selectRoom(room, { fromCacheHydration: true, quiet: true });
    }
    return true;
  }

  function schedulePersistentBootstrapSave() {
    window.setTimeout(() => {
      void persistBootstrapCache();
    }, 0);
  }

  function schedulePersistentRoomSave(room) {
    window.setTimeout(() => {
      void persistRoomCache(room);
    }, 0);
  }

  function cacheFor(room) {
    const key = roomKey(room);
    if (!key) return null;
    if (!state.roomCache.has(key)) {
      state.roomCache.set(key, {
        messages: [],
        oldestCursor: null,
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

  function updateCacheCursors(cache) {
    if (!cache || !cache.messages.length) {
      cache.oldestCursor = null;
      cache.latestCursor = null;
      cache.latestMessageId = null;
      return;
    }
    cache.messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    cache.oldestCursor = cache.messages[0].created_at || null;
    const latest = cache.messages[cache.messages.length - 1];
    cache.latestCursor = latest.created_at || null;
    cache.latestMessageId = latest.id || null;
  }

  function deltaLoadParams(cache) {
    if (!cache?.latestCursor) return {};
    const params = { after: cache.latestCursor };
    if (cache.latestMessageId) params.after_message_id = cache.latestMessageId;
    return params;
  }

  function mergeMessages(existing, incoming) {
    const byId = new Map();
    for (const message of existing || []) {
      if (message && message.id) byId.set(message.id, message);
    }
    for (const message of incoming || []) {
      if (message && message.id) byId.set(message.id, message);
    }
    return Array.from(byId.values()).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  }

  function saveActiveScroll() {
    const cache = cacheFor(state.activeRoom);
    if (cache && els.messages) {
      cache.scrollTop = els.messages.scrollTop;
      schedulePersistentRoomSave(state.activeRoom);
    }
  }

  function restoreScroll(cache, shouldBottom = false) {
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

  function isNearBottom() {
    if (!els.messages) return true;
    const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
    return remaining < 140;
  }

  async function fetchJson(url, options = {}) {
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

  function normalizeUnreadRoom(room = {}) {
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

  function applyChatSummary(payload = {}) {
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

  async function refreshChatSummary() {
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

  function unreadForRoom(type, id) {
    return state.roomUnread.get(unreadKey(type, id)) || { unread_count: 0, has_unread: false };
  }

  function setRoomUnread(room, unread = {}) {
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

  function incrementRoomUnread(room) {
    if (!room?.type || !room?.id) return;
    if (String(room.actor_id || "") === currentUserId()) return;
    const current = unreadForRoom(room.type, room.id);
    setRoomUnread(room, {
      unread_count: Math.min(Number(current.unread_count || 0) + 1, 99),
      has_unread: true,
    });
  }

  function clearRoomUnread(room) {
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

  function latestMessageForRead(cache) {
    const messages = cache?.messages || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.id) return message;
    }
    return null;
  }

  function shouldAutoMarkRoomRead(room, cache = cacheFor(room)) {
    if (room?.type === "channel" && room.id === ANNOUNCEMENTS_CHANNEL_ID) {
      return unreadAnnouncementMessages(cache?.messages, state.roomReadState).length === 0;
    }
    return true;
  }

  function markRoomRead(room, cache = cacheFor(room)) {
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

  async function markRoomUnread(room) {
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

  function setStatus(message, tone = "info") {
    if (!els.status) return;
    if (!message) {
      els.status.hidden = true;
      els.status.textContent = "";
      els.status.dataset.tone = "";
      return;
    }
    els.status.hidden = false;
    els.status.dataset.tone = tone;
    els.status.textContent = message;
  }

  function renderMessageLoader(label = "Loading messages...") {
    if (!els.messages) return;
    const loader = window.APStudyLoader?.html
      ? window.APStudyLoader.html(label, { sizePx: 46, textToneClass: "text-on-surface" })
      : `<div class="chat-empty">${escapeHtml(label)}</div>`;
    els.messages.innerHTML = `<div class="chat-message-loader">${loader}</div>`;
  }

  function focusComposerSoon() {
    if (!els.input || els.input.disabled || els.composer?.hidden) return;
    window.setTimeout(() => els.input?.focus({ preventScroll: true }), 0);
  }

  function playChatSound(actorId) {
    if (!state.settings.chat_sound_enabled || !els.audio) return;
    if (actorId && state.user && String(actorId) === String(state.user.id)) return;
    try {
      els.audio.currentTime = 0;
      void els.audio.play();
    } catch (error) {
      void error;
      // Browsers may block sound until the user interacts with the page.
    }
  }

  function activeChannel() {
    if (state.activeRoom?.type !== "channel") return null;
    return state.channels.find((channel) => channel.id === state.activeRoom.id) || null;
  }

  function activeThread() {
    if (state.activeRoom?.type !== "thread") return null;
    return state.threads.find((thread) => thread.id === state.activeRoom.id) || null;
  }

  function threadExists(threadId) {
    return state.threads.some((thread) => thread.id === threadId);
  }

  function channelIsPending(channel) {
    return channel?.kind === "university" && !channel.approved;
  }

  function channelIsWritable(channel) {
    return Boolean(channel && !channel.read_only && channel.approved !== false);
  }

  function channelLabel(channel) {
    return channel?.label || channel?.school_name || channel?.name || "Channel";
  }

  function channelMeta(channel) {
    if (channelIsPending(channel)) {
      if (channel.university_status === "denied") return "Denied";
      return "Waiting approval";
    }
    return `${channel.active_count || 0} active`;
  }

  function channelSymbol(channel) {
    if (channel?.kind === "university") return "U";
    return "#";
  }

  function unreadBadgeMarkup(type, id) {
    const unread = unreadForRoom(type, id);
    if (!unread.has_unread || Number(unread.unread_count || 0) <= 0) return "";
    const count = Number(unread.unread_count || 0);
    const label = count >= 99 ? "99+" : String(count);
    const ariaLabel = `${label} unread ${label === "1" ? "message" : "messages"}`;
    return `<span class="chat-room-unread-badge" aria-label="${escapeHtml(ariaLabel)}">${escapeHtml(label)}</span>`;
  }

  function roomButton({ type, id, active, leading, title, meta, className = "" }) {
    const unread = unreadForRoom(type, id);
    const hasUnread = unread.has_unread && Number(unread.unread_count || 0) > 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-list-button ${className} ${active ? "is-active" : ""} ${hasUnread ? "has-unread" : ""}`.trim();
    button.dataset.roomType = type;
    button.dataset.roomId = id;
    button.innerHTML = `
      ${leading}
      <span class="chat-list-copy">
        <span class="chat-list-title">${escapeHtml(title)}</span>
        ${meta || ""}
      </span>
      ${unreadBadgeMarkup(type, id)}
    `;
    button.addEventListener("click", () => selectRoom({ type, id }));
    button.addEventListener("contextmenu", (event) => openRoomContextMenu({ type, id }, event));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      openRoomContextMenu({ type, id }, event);
    });
    return button;
  }

  function ensureRoomContextMenu() {
    let menu = document.getElementById("chat-room-context-menu");
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = "chat-room-context-menu";
    menu.className = "chat-room-context-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <button type="button" role="menuitem" data-chat-room-action="read">Mark as read</button>
      <button type="button" role="menuitem" data-chat-room-action="unread">Mark as unread</button>
    `;
    document.body.appendChild(menu);
    menu.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-chat-room-action]");
      if (!actionButton || !state.contextMenuRoom) return;
      const room = { ...state.contextMenuRoom };
      closeRoomContextMenu();
      if (actionButton.dataset.chatRoomAction === "read") {
        markRoomRead(room);
      } else if (actionButton.dataset.chatRoomAction === "unread") {
        void markRoomUnread(room);
      }
    });
    return menu;
  }

  function closeRoomContextMenu() {
    const menu = document.getElementById("chat-room-context-menu");
    if (menu) menu.hidden = true;
    state.contextMenuRoom = null;
  }

  function openRoomContextMenu(room, event) {
    if (!room?.type || !room?.id) return;
    event.preventDefault();
    state.contextMenuRoom = room;
    const menu = ensureRoomContextMenu();
    const rect = event.currentTarget?.getBoundingClientRect?.() || { left: 0, bottom: 0 };
    const x = typeof event.clientX === "number" && event.clientX > 0 ? event.clientX : rect.left + 16;
    const y = typeof event.clientY === "number" && event.clientY > 0 ? event.clientY : rect.bottom;
    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - menuRect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - menuRect.height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }

  function renderChannels() {
    if (!els.channelList) return;
    els.channelList.innerHTML = "";
    for (const channel of state.channels) {
      const active = state.activeRoom?.type === "channel" && state.activeRoom.id === channel.id;
      const leading = `<span class="chat-channel-symbol" aria-hidden="true">${escapeHtml(channelSymbol(channel))}</span>`;
      const meta = `<small>${escapeHtml(channelMeta(channel))}</small>`;
      const button = roomButton({
        type: "channel",
        id: channel.id,
        active,
        leading,
        title: channelLabel(channel),
        meta,
        className: channelIsPending(channel) ? "is-pending" : "",
      });
      els.channelList.appendChild(button);
    }
  }

  function dmPresenceStatus(thread) {
    if (thread?.presence_status) return thread.presence_status === "online" ? "online" : "offline";
    return thread?.other_user?.online ? "online" : "offline";
  }

  function dmPresenceMarkup(status) {
    const label = status === "online" ? "Online" : "Offline";
    return `
      <small class="chat-presence-line">
        <span>${label}</span>
      </small>
    `;
  }

  function renderThreads() {
    if (!els.dmList) return;
    els.dmList.innerHTML = "";
    if (!state.threads.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty chat-empty-compact";
      empty.textContent = "No direct messages yet.";
      els.dmList.appendChild(empty);
      return;
    }
    for (const thread of state.threads) {
      const other = thread.other_user || {};
      const status = dmPresenceStatus(thread);
      const active = state.activeRoom?.type === "thread" && state.activeRoom.id === thread.id;
      const leading = `
        <span class="chat-avatar-wrap">
          <img class="chat-avatar-mini" ${avatarAttrs(other.picture_url, 48, "48px")} alt="">
          <span class="chat-presence-dot chat-presence-overlay is-${status}" aria-hidden="true"></span>
        </span>
      `;
      const button = roomButton({
        type: "thread",
        id: thread.id,
        active,
        leading,
        title: other.name || other.username || "Nest User",
        meta: dmPresenceMarkup(status),
      });
      els.dmList.appendChild(button);
    }
  }

  function updateRoomLists() {
    renderChannels();
    renderThreads();
  }

  function setHistoryBanner(channel) {
    if (!els.historyLimited) return;
    const invite = root.dataset.discordInviteUrl || "";
    if (els.joinDiscord) {
      els.joinDiscord.hidden = !invite;
      if (invite) els.joinDiscord.href = invite;
    }
    if (!channel || channel.kind !== "discord" || channel.history_limited !== true) {
      els.historyLimited.hidden = true;
      delete els.historyLimited.dataset.channelId;
      return;
    }
    els.historyLimited.dataset.channelId = channel.id;
    updateHistoryBannerVisibility();
  }

  function messagePaneIsScrollable() {
    if (!els.messages) return false;
    return els.messages.scrollHeight > els.messages.clientHeight + 1;
  }

  function updateHistoryBannerVisibility() {
    if (!els.historyLimited) return;
    const channelId = els.historyLimited.dataset.channelId;
    if (!channelId) {
      els.historyLimited.hidden = true;
      return;
    }
    const channel = activeChannel();
    const shouldConsider = Boolean(
      channel
      && channel.id === channelId
      && channel.kind === "discord"
      && channel.history_limited === true
    );
    if (!shouldConsider) {
      els.historyLimited.hidden = true;
      return;
    }
    const atTop = (els.messages?.scrollTop || 0) <= 16;
    els.historyLimited.hidden = !(messagePaneIsScrollable() && atTop);
  }

  function unreadAnnouncementMessages(messages, readState) {
    const lastReadAt = readState?.last_read_at ? parseMessageDate(readState.last_read_at) : null;
    const currentUserId = String(state.user?.id || "");
    return (messages || []).filter((message) => {
      if (String(message.user_id || "") === currentUserId) return false;
      const created = parseMessageDate(message.created_at);
      if (!created) return false;
      if (!lastReadAt) return true;
      return created.getTime() > lastReadAt.getTime();
    });
  }

  function announcementUnreadFitsInPane(unreadNodes) {
    if (!els.messages || !unreadNodes.length) return true;
    const paneTop = els.messages.getBoundingClientRect().top;
    const paneBottom = paneTop + els.messages.clientHeight;
    const first = unreadNodes[0].getBoundingClientRect();
    const last = unreadNodes[unreadNodes.length - 1].getBoundingClientRect();
    return first.top >= paneTop && last.bottom <= paneBottom;
  }

  async function markAnnouncementsRead() {
    const room = state.activeRoom;
    if (!room || room.type !== "channel" || room.id !== ANNOUNCEMENTS_CHANNEL_ID) return;
    const cache = cacheFor(room);
    const latest = latestMessageForRead(cache);
    if (!latest?.id) return;
    await fetchJson("/api/chat/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_type: "channel",
        scope_id: room.id,
        message_id: latest.id,
      }),
    });
    state.roomReadState = {
      last_read_at: latest.created_at,
      last_read_message_id: latest.id,
    };
    clearRoomUnread(room);
    state.announcementsBannerVisible = false;
    if (els.announcementsUnread) els.announcementsUnread.hidden = true;
    void refreshChatSummary();
  }

  function updateAnnouncementsUnreadBanner(messages) {
    if (!els.announcementsUnread) return;
    const channel = activeChannel();
    if (!channel || channel.id !== ANNOUNCEMENTS_CHANNEL_ID) {
      els.announcementsUnread.hidden = true;
      state.announcementsBannerVisible = false;
      return;
    }
    const unread = unreadAnnouncementMessages(messages, state.roomReadState);
    if (!unread.length) {
      els.announcementsUnread.hidden = true;
      state.announcementsBannerVisible = false;
      return;
    }
    window.requestAnimationFrame(() => {
      const unreadNodes = unread
        .map((message) => els.messages?.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`))
        .filter(Boolean);
      if (!unreadNodes.length) {
        els.announcementsUnread.hidden = true;
        state.announcementsBannerVisible = false;
        return;
      }
      if (announcementUnreadFitsInPane(unreadNodes)) {
        void markAnnouncementsRead();
        return;
      }
      els.announcementsUnread.hidden = false;
      state.announcementsBannerVisible = true;
    });
  }

  function closeInlineProfilePopover() {
    if (inlineProfilePopover) {
      inlineProfilePopover.remove();
      inlineProfilePopover = null;
    }
  }

  function positionInlineProfilePopover(anchor, popover) {
    const padding = 8;
    const pane = els.messages;
    const bounds = pane?.getBoundingClientRect() || {
      left: padding,
      top: padding,
      right: window.innerWidth - padding,
      bottom: window.innerHeight - padding,
    };
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.visibility = "hidden";
    popover.style.left = "0px";
    popover.style.top = "0px";
    document.body.appendChild(popover);
    const popoverRect = popover.getBoundingClientRect();
    let left = anchorRect.right + padding;
    let top = anchorRect.top;
    if (left + popoverRect.width > bounds.right) {
      left = anchorRect.left - popoverRect.width - padding;
    }
    if (left < bounds.left) {
      left = Math.min(Math.max(bounds.left, anchorRect.left), bounds.right - popoverRect.width);
      top = anchorRect.bottom + padding;
    }
    if (top + popoverRect.height > bounds.bottom) {
      top = Math.max(bounds.top, bounds.bottom - popoverRect.height);
    }
    if (top < bounds.top) top = bounds.top;
    if (left + popoverRect.width > bounds.right) {
      left = bounds.right - popoverRect.width;
    }
    if (left < bounds.left) left = bounds.left;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.visibility = "visible";
  }

  function openInlineProfileForMessage(message, anchor) {
    if (!message || !anchor) return;
    closeInlineProfilePopover();
    const limited = !message.author_profile;
    const profileUser = message.author_profile || {
      id: message.user_id || "",
      name: message.author_name || "Nest User",
      username: message.author_username || "",
      picture_url: message.author_avatar_url,
      handle: message.author_username ? `@${message.author_username}` : `@${message.author_name || "nest-user"}`,
    };
    const popover = document.createElement("div");
    popover.className = `chat-inline-profile-popover${limited ? " is-limited" : ""}`;
    popover.innerHTML = profileMarkup(profileUser, { showBlock: false, status: "offline" });
    positionInlineProfilePopover(anchor, popover);
    inlineProfilePopover = popover;
  }

  function stickToBottom() {
    if (!els.messages) return;
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function messageStackElement() {
    if (!els.messages) return null;
    if (els.messages.querySelector(".chat-message-loader")) {
      els.messages.innerHTML = `<div class="chat-message-stack"></div>`;
    }
    let stack = els.messages.querySelector(".chat-message-stack");
    if (!stack) {
      els.messages.innerHTML = `<div class="chat-message-stack"></div>`;
      stack = els.messages.querySelector(".chat-message-stack");
    }
    return stack;
  }

  function renderedMessageIds() {
    const ids = new Set();
    if (!els.messages) return ids;
    for (const node of els.messages.querySelectorAll("[data-message-id]")) {
      const id = node.getAttribute("data-message-id");
      if (id) ids.add(id);
    }
    return ids;
  }

  function messageElementById(messageId) {
    if (!els.messages || !messageId) return null;
    return els.messages.querySelector(`[data-message-id="${String(messageId).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  }

  function appendNewMessagesToDom(newMessages, allMessages) {
    if (!newMessages?.length) return true;
    const stack = messageStackElement();
    if (!stack) return false;

    const renderedIds = renderedMessageIds();
    const unseen = newMessages.filter((message) => message?.id && !renderedIds.has(String(message.id)));
    if (!unseen.length) return true;

    const empty = stack.querySelector(".chat-empty");
    if (empty) stack.innerHTML = "";

    const articles = stack.querySelectorAll("[data-message-id]");
    const lastArticle = articles[articles.length - 1];
    let lastMessage = null;
    let lastGroupEl = stack.querySelector(".chat-message-group:last-child");
    if (lastArticle) {
      const lastId = lastArticle.getAttribute("data-message-id");
      lastMessage = (allMessages || []).find((message) => String(message.id) === String(lastId)) || null;
    }

    for (const message of unseen) {
      if (lastMessage && shouldGroupMessage(lastMessage, message) && lastGroupEl) {
        lastGroupEl.insertAdjacentHTML("beforeend", renderContinuationMessage(message));
      } else {
        stack.insertAdjacentHTML("beforeend", renderMessageGroup({ id: message.id, messages: [message] }));
        lastGroupEl = stack.querySelector(".chat-message-group:last-child");
      }
      lastMessage = message;
    }
    return true;
  }

  function patchMessageInDom(message) {
    const el = messageElementById(message.id);
    if (!el) return false;
    const contentHtml = `
      <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
      ${renderImages(message.images || [])}
      ${renderPreviews(message.previews || [])}
    `;
    const isContinuation = el.classList.contains("chat-message-continuation");
    const content = el.querySelector(".chat-message-content");
    if (!content) return false;
    if (isContinuation) {
      content.innerHTML = contentHtml;
    } else {
      const head = content.querySelector(".chat-message-head");
      content.innerHTML = head ? head.outerHTML : "";
      content.insertAdjacentHTML("beforeend", contentHtml);
    }
    const deleteButton = renderDeleteButton(message);
    const existingDelete = el.querySelector(".chat-delete");
    if (deleteButton && !existingDelete) {
      el.insertAdjacentHTML("beforeend", deleteButton);
    } else if (!deleteButton && existingDelete) {
      existingDelete.remove();
    }
    return true;
  }

  function removeMessageFromDom(messageId) {
    const el = messageElementById(messageId);
    if (!el) return false;
    const group = el.closest(".chat-message-group");
    el.remove();
    if (group && !group.querySelector("[data-message-id]")) {
      group.remove();
    }
    const stack = messageStackElement();
    if (stack && !stack.querySelector("[data-message-id]") && !stack.querySelector(".chat-empty")) {
      stack.innerHTML = `<div class="chat-empty">No messages yet.</div>`;
    }
    return true;
  }

  function syncMessagesToDom(messages, { incremental = false, incoming = [], scrollToBottom = false } = {}) {
    if (!els.messages) return;
    if (incremental && messages?.length) {
      if (appendNewMessagesToDom(incoming, messages)) {
        updateAnnouncementsUnreadBanner(messages);
        updateHistoryBannerVisibility();
        if (scrollToBottom) stickToBottom();
        return;
      }
    }
    renderMessages(messages);
    if (scrollToBottom) stickToBottom();
  }

  function applyIncomingMessages(room, messages, { toBottom = false, markRead = true } = {}) {
    const cache = cacheFor(room);
    if (!cache || !messages?.length) return [];
    const previousMessages = cache.messages;
    const wasNearBottom = toBottom || isNearBottom();
    cache.messages = mergeMessages(cache.messages, messages);
    cache.loaded = true;
    cache.stale = false;
    updateCacheCursors(cache);
    schedulePersistentRoomSave(room);
    const incoming = messages.filter((message) => message?.id && !previousMessages.some((row) => row.id === message.id));
    syncMessagesToDom(cache.messages, {
      incremental: true,
      incoming,
      scrollToBottom: wasNearBottom,
    });
    if (wasNearBottom && markRead) markRoomRead(room, cache);
    return messages;
  }

  async function fetchMessageById(messageId) {
    if (!messageId) return null;
    try {
      const payload = await fetchJson(`/api/chat/messages/${encodeURIComponent(messageId)}`);
      return payload?.message || null;
    } catch (_) {
      return null;
    }
  }

  async function ingestMessageUpdate(event) {
    const room = state.activeRoom;
    const cache = cacheFor(room);
    if (!room || !cache) return false;
    if (event.message_id) {
      const message = await fetchMessageById(event.message_id);
      if (message) {
        cache.messages = mergeMessages(cache.messages, [message]);
        updateCacheCursors(cache);
        schedulePersistentRoomSave(room);
        if (patchMessageInDom(message)) {
          updateAnnouncementsUnreadBanner(cache.messages);
          return true;
        }
      }
    }
    await loadMessages({ force: true, quiet: true, preserveScroll: true, light: true });
    return false;
  }

  async function ingestActiveRoomMessage(event) {
    const room = state.activeRoom;
    const cache = cacheFor(room);
    if (!room || !cache) return false;

    if (event.message_id && !cache.messages.some((message) => message.id === event.message_id)) {
      const message = await fetchMessageById(event.message_id);
      if (message) {
        applyIncomingMessages(room, [message]);
        playChatSound(event.actor_id);
        return true;
      }
    }

    const delta = deltaLoadParams(cache);
    const incoming = delta.after
      ? await loadMessages({ ...delta, quiet: true, force: true, light: true })
      : await loadMessages({ force: true, quiet: true });
    if (!incoming.length && event.message_id) {
      await loadMessages({ force: true, quiet: true });
    } else if (incoming.length) {
      playChatSound(event.actor_id);
      return true;
    }
    return incoming.length > 0;
  }

  function pollActiveRoomMessages() {
    const room = state.activeRoom;
    const cache = cacheFor(room);
    if (!room || !cache) return;
    const delta = deltaLoadParams(cache);
    if (delta.after) {
      void loadMessages({ ...delta, quiet: true, force: true, light: true });
    } else {
      void loadMessages({ force: true, quiet: true });
    }
  }

  function startRealtimeFallback() {
    if (realtimeFallbackTimer || state.realtimeReady) return;
    realtimeFallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (state.realtimeReady) {
        stopRealtimeFallback();
        return;
      }
      pollActiveRoomMessages();
      void refreshChatSummary();
    }, REALTIME_FALLBACK_MS);
  }

  function stopRealtimeFallback() {
    if (!realtimeFallbackTimer) return;
    window.clearInterval(realtimeFallbackTimer);
    realtimeFallbackTimer = null;
  }

  function startRealtimeHeartbeat() {
    if (realtimeHeartbeatTimer) return;
    realtimeHeartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !state.realtimeReady) return;
      pollActiveRoomMessages();
    }, REALTIME_HEARTBEAT_MS);
  }

  function stopRealtimeHeartbeat() {
    if (!realtimeHeartbeatTimer) return;
    window.clearInterval(realtimeHeartbeatTimer);
    realtimeHeartbeatTimer = null;
  }

  function resetRealtimeConnection() {
    if (chatEventSource) {
      chatEventSource.close();
      chatEventSource = null;
    }
    if (state.realtimeUnsubscribe) {
      state.realtimeUnsubscribe();
      state.realtimeUnsubscribe = null;
    }
    state.realtimeReady = false;
    state.realtimeConnecting = false;
    stopRealtimeHeartbeat();
  }

  function buildChatEventsStreamUrl() {
    const params = new URLSearchParams();
    if (chatEventCursor.since) params.set("since", chatEventCursor.since);
    if (chatEventCursor.after_id) params.set("after_id", chatEventCursor.after_id);
    const qs = params.toString();
    return qs ? `/api/chat/events/stream?${qs}` : "/api/chat/events/stream";
  }

  function scheduleRealtimeReconnect() {
    if (realtimeReconnectTimer) return;
    resetRealtimeConnection();
    startRealtimeFallback();
    realtimeReconnectTimer = window.setTimeout(() => {
      realtimeReconnectTimer = null;
      initializeChatEventStream();
    }, REALTIME_RECONNECT_MS);
  }

  function handleRealtimeDisconnect() {
    scheduleRealtimeReconnect();
  }

  async function refreshAppwriteRealtimeAuth() {
    const authed = await ensureAppwriteRealtimeAuth();
    if (!authed) return false;
    if (state.presenceUnsubscribe) {
      state.presenceUnsubscribe();
      state.presenceUnsubscribe = null;
      state.presenceReady = false;
    }
    await initializePresenceRealtime();
    return state.presenceReady;
  }

  async function ensureAppwriteRealtimeAuth() {
    if (!window.client || !root.dataset.appwriteDatabaseId) return false;
    try {
      const payload = await fetchJson("/api/chat/realtime-token");
      const jwt = payload?.jwt;
      if (!jwt) return false;
      if (typeof window.client.setJWT === "function") {
        window.client.setJWT(jwt);
      } else if (typeof window.client.setJwt === "function") {
        window.client.setJwt(jwt);
      } else {
        return false;
      }
      scheduleAppwriteJwtRefresh();
      return true;
    } catch (error) {
      console.warn("Unable to authenticate Appwrite realtime", error);
      return false;
    }
  }

  function scheduleAppwriteJwtRefresh() {
    if (appwriteJwtRefreshTimer) {
      window.clearTimeout(appwriteJwtRefreshTimer);
      appwriteJwtRefreshTimer = null;
    }
    appwriteJwtRefreshTimer = window.setTimeout(() => {
      appwriteJwtRefreshTimer = null;
      void refreshAppwriteRealtimeAuth();
    }, REALTIME_JWT_REFRESH_MS);
  }

  async function startRealtimeServices() {
    initializeChatEventStream();
    await ensureAppwriteRealtimeAuth();
    await initializePresenceRealtime();
    void loadInitialPresences();
  }

  function setComposer(enabled, placeholder) {
    if (!els.composer || !els.input || !els.sendButton) return;
    els.composer.hidden = false;
    els.input.disabled = !enabled;
    els.sendButton.disabled = !enabled;
    els.input.placeholder = placeholder || "Message";
    autosizeComposer();
  }

  function renderHeader() {
    const channel = activeChannel();
    const thread = activeThread();
    if (channel) {
      els.roomSymbol.classList.remove("is-avatar");
      els.roomSymbol.textContent = channelSymbol(channel);
      els.roomName.textContent = channelLabel(channel);
      els.roomMeta.textContent = channelIsPending(channel)
        ? "Waiting for admin approval"
        : `${channel.active_count || 0} active`;
      setHistoryBanner(channelIsPending(channel) ? null : channel);
      const placeholder = channelIsPending(channel)
        ? "Waiting for admin approval"
        : channel.read_only
          ? "Read-only channel"
          : `Message #${channelLabel(channel)}`;
      setComposer(channelIsWritable(channel), placeholder);
      return;
    }

    if (thread) {
      const other = thread.other_user || {};
      els.roomSymbol.classList.add("is-avatar");
      const status = dmPresenceStatus(thread);
      els.roomSymbol.innerHTML = `
        <span class="chat-room-avatar-wrap">
          <img ${avatarAttrs(other.picture_url, 48, "48px")} alt="">
          <span class="chat-presence-dot chat-presence-overlay is-${status}" aria-hidden="true"></span>
        </span>
      `;
      els.roomName.textContent = other.name || other.username || "Nest User";
      els.roomMeta.textContent = "";
      setHistoryBanner(null);
      setComposer(!thread.blocked, thread.blocked ? "This conversation is blocked" : `Message ${other.name || other.username || ""}`.trim());
      return;
    }

    els.roomSymbol.classList.remove("is-avatar");
    els.roomSymbol.textContent = "#";
    els.roomName.textContent = "Chat";
    els.roomMeta.textContent = "Loading...";
    setHistoryBanner(null);
    if (els.composer) els.composer.hidden = true;
  }

  function renderApprovalNotice(channel) {
    setStatus(null);
    if (els.messages) {
      const denied = channel?.university_status === "denied";
      els.messages.innerHTML = `
        <div class="chat-empty chat-approval-state">
          <strong>${denied ? "University Channel Denied." : "Waiting Admin Approval."}</strong>
          <span>Email derek.chen@emory.edu for faster approval.</span>
        </div>
      `;
    }
    renderMembers([]);
  }

  function renderMessages(messages) {
    if (!els.messages) return;
    if (!messages || !messages.length) {
      els.messages.innerHTML = `<div class="chat-message-stack"><div class="chat-empty">No messages yet.</div></div>`;
      updateAnnouncementsUnreadBanner([]);
      updateHistoryBannerVisibility();
      return;
    }
    els.messages.innerHTML = `
      <div class="chat-message-stack">
        ${groupMessages(messages).map(renderMessageGroup).join("")}
      </div>
    `;
    updateAnnouncementsUnreadBanner(messages);
    updateHistoryBannerVisibility();
  }

  function renderMessageGroup(group) {
    const [lead, ...continuations] = group.messages;
    return `
      <div class="chat-message-group" data-message-group="${escapeHtml(group.id)}">
        ${renderLeadMessage(lead)}
        ${continuations.map(renderContinuationMessage).join("")}
      </div>
    `;
  }

  function renderDeleteButton(message) {
    if (!message.can_delete) return "";
    return `
      <button class="chat-delete" type="button" data-delete-message="${escapeHtml(message.id)}" aria-label="Delete message">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;
  }

  function renderLeadMessage(message) {
    const deleteButton = message.can_delete
      ? renderDeleteButton(message)
      : "";
    return `
      <article class="chat-message" data-message-id="${escapeHtml(message.id)}">
        <button type="button" class="chat-message-avatar-button chat-author-button" data-author-message-id="${escapeHtml(message.id)}" aria-label="View ${escapeHtml(message.author_name || "author")} profile">
          <img class="chat-message-avatar" ${avatarAttrs(message.author_avatar_url, 84, "42px")} alt="">
        </button>
        <div class="chat-message-content">
          <div class="chat-message-head">
            <button type="button" class="chat-author-button" data-author-message-id="${escapeHtml(message.id)}">${escapeHtml(message.author_name || "Nest User")}</button>
            <span class="chat-message-time">${escapeHtml(formatMessageTimestamp(message.created_at))}</span>
          </div>
          <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
          ${renderImages(message.images || [])}
          ${renderPreviews(message.previews || [])}
        </div>
        ${deleteButton}
      </article>
    `;
  }

  function renderContinuationMessage(message) {
    return `
      <article class="chat-message chat-message-continuation" data-message-id="${escapeHtml(message.id)}">
        <span class="chat-message-continuation-time">${escapeHtml(formatClockTime(parseMessageDate(message.created_at)))}</span>
        <div class="chat-message-content">
          <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
          ${renderImages(message.images || [])}
          ${renderPreviews(message.previews || [])}
        </div>
        ${renderDeleteButton(message)}
      </article>
    `;
  }

  function renderImages(images) {
    if (!images.length) return "";
    return `
      <div class="chat-message-images">
        ${images.map((image) => `
          <img
            class="chat-message-image"
            src="${escapeHtml(image.proxy_url || image.url)}"
            alt="${escapeHtml(image.filename || "Discord image")}"
            loading="lazy"
            decoding="async"
            sizes="(max-width: 640px) 92vw, 520px"
          >
        `).join("")}
      </div>
    `;
  }

  function renderPreviews(previews) {
    if (!previews.length) return "";
    return previews.map((preview) => {
      const image = preview.image_url
        ? `<img src="${escapeHtml(preview.image_url)}" alt="" loading="lazy" decoding="async" sizes="(max-width: 640px) 92vw, 128px">`
        : "";
      return `
        <div class="chat-preview">
          <a href="${escapeHtml(preview.url || "#")}" target="_blank" rel="noopener noreferrer nofollow">
            <span class="chat-preview-copy">
              <strong>${escapeHtml(preview.title || preview.site_name || preview.url || "Link")}</strong>
              ${preview.site_name ? `<span>${escapeHtml(preview.site_name)}</span>` : ""}
              ${preview.description ? `<p>${escapeHtml(preview.description)}</p>` : ""}
            </span>
            ${image}
          </a>
        </div>
      `;
    }).join("");
  }

  function renderMembers(users) {
    if (!els.members || !els.memberList || !els.profilePanel) return;
    els.members.classList.remove("is-dm-profile");
    const activeUsers = users || [];
    els.membersCount.textContent = plural(activeUsers.length, "user", "users");
    els.membersRestoreCount.textContent = String(activeUsers.length);
    els.profilePanel.hidden = true;
    els.profilePanel.innerHTML = "";
    if (!activeUsers.length) {
      els.memberList.innerHTML = `<div class="chat-empty chat-empty-compact">No active users.</div>`;
      return;
    }
    els.memberList.innerHTML = activeUsers.map((user) => `
      <button class="chat-member" type="button" data-profile-id="${escapeHtml(user.id)}">
        <img ${avatarAttrs(user.picture_url, 72, "36px")} alt="">
        <span>
          <strong>${escapeHtml(user.name || user.username || "Nest User")}</strong>
          <small>${escapeHtml(user.school || user.username || "Active now")}</small>
        </span>
      </button>
    `).join("");
  }

  function renderDmProfile(thread) {
    if (!els.members || !els.memberList || !els.profilePanel) return;
    const other = thread?.other_user || {};
    const status = dmPresenceStatus(thread);
    els.members.classList.add("is-dm-profile");
    els.membersCount.textContent = "Profile";
    els.membersRestoreCount.textContent = status === "online" ? "1" : "0";
    els.memberList.innerHTML = "";
    els.profilePanel.hidden = false;
    els.profilePanel.innerHTML = profileMarkup(other, {
      status,
      blocked: Boolean(thread?.blocked),
      showBlock: Boolean(other.id),
    });
  }

  function normalizeHexColor(value) {
    const candidate = String(value || "").trim();
    const normalized = candidate.startsWith("#") ? candidate : `#${candidate}`;
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : "#fecae1";
  }

  function profileDetail(label, value, className = "") {
    return `
      <div class="${className}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "Not set")}</strong>
      </div>
    `;
  }

  function profileMarkup(user, options = {}) {
    const status = options.status || (user?.online ? "online" : "offline");
    const handle = user?.handle || (user?.username ? `@${user.username}` : `@${user?.id || "apstudy-user"}`);
    const graduation = user?.graduation_year || user?.class_year || "";
    const memberSince = user?.member_since || "";
    const bannerColor = normalizeHexColor(user?.banner_color);
    const blockLabel = options.blocked ? "Unblock" : "Block";
    const blockAction = options.showBlock
      ? `<button type="button" data-block-user="${escapeHtml(user.id)}" data-blocked="${options.blocked ? "true" : "false"}">${blockLabel}</button>`
      : "";
    return `
      <div class="chat-profile-card">
        <div class="profile-tile" style="--profile-banner-color: ${escapeHtml(bannerColor)};">
          <div class="profile-tile-banner" aria-hidden="true"></div>
          <div class="profile-tile-body">
            <div class="profile-tile-avatar-frame">
              <img class="profile-tile-avatar" ${avatarAttrs(user?.picture_url, 150, "(max-width: 640px) 96px, 150px")} alt="${escapeHtml(user?.name || "Nest User")} avatar" width="150" height="150">
            </div>
            <div class="profile-tile-heading">
              <h3>${escapeHtml(user?.name || user?.username || "Nest User")}</h3>
              <p>${escapeHtml(handle)}</p>
              <p class="chat-presence-line chat-profile-presence">
                <span class="chat-presence-dot is-${status}" aria-hidden="true"></span>
                <span>${status === "online" ? "Online" : "Offline"}</span>
              </p>
            </div>
            <div class="profile-tile-details">
              ${profileDetail("School", user?.school, user?.is_emory_school ? "profile-tile-detail-emory" : "")}
              ${profileDetail("Major", user?.major)}
              ${profileDetail("Graduation", graduation)}
              ${profileDetail("Education", user?.education_level)}
              ${profileDetail("Member Since", memberSince, user?.is_early_member ? "profile-tile-detail-early-member" : "")}
            </div>
          </div>
        </div>
      </div>
      <div class="chat-profile-actions">
        ${user?.profile_url ? `<a href="${escapeHtml(user.profile_url)}">View profile</a>` : ""}
        ${blockAction}
      </div>
    `;
  }

  function updateCurrentMembersFromPayload(payload) {
    if (payload.thread && state.activeRoom?.type === "thread" && state.activeRoom.id === payload.thread.id) {
      renderDmProfile(payload.thread);
    }
    renderPresenceDrivenUi();
  }

  function updateChannel(payload) {
    if (!payload?.id) return;
    const index = state.channels.findIndex((channel) => channel.id === payload.id);
    if (index >= 0) {
      state.channels[index] = { ...state.channels[index], ...payload };
    } else {
      state.channels.push(payload);
    }
  }

  function updateThread(payload) {
    if (!payload?.id) return;
    registerKnownUser(payload.other_user);
    const index = state.threads.findIndex((thread) => thread.id === payload.id);
    if (index >= 0) {
      state.threads[index] = { ...state.threads[index], ...payload };
    } else {
      state.threads.unshift(payload);
    }
    state.threads.sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
  }

  async function fetchThread(threadId) {
    if (!threadId) return null;
    try {
      const payload = await fetchJson(`/api/chat/dm/threads/${encodeURIComponent(threadId)}`);
      if (payload.thread) {
        updateThread(payload.thread);
        updateRoomLists();
        renderPresenceDrivenUi();
        schedulePersistentBootstrapSave();
        return payload.thread;
      }
    } catch (error) {
      setStatus(error.message || "Unable to load direct message.", "error");
    }
    return null;
  }

  function normalizePresenceMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === "string") {
      try {
        return JSON.parse(metadata);
      } catch (_) {
        return {};
      }
    }
    return metadata;
  }

  function presenceUserId(record) {
    return String(record?.userId || record?.user_id || record?.userInternalId || "");
  }

  function presenceExpiresAt(record) {
    return parseMessageDate(record?.expiresAt || record?.expires_at);
  }

  function presenceIsExpired(record) {
    const expiresAt = presenceExpiresAt(record);
    return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
  }

  function normalizePresenceRecord(record) {
    if (!record) return null;
    const metadata = normalizePresenceMetadata(record.metadata);
    if (metadata.app !== PRESENCE_APP_ID) return null;
    const scopeKey = presenceScopeKey(metadata);
    if (!scopeKey || !knownPresenceScopeKeys().has(scopeKey)) return null;
    const userId = presenceUserId(record);
    if (!userId || presenceIsExpired(record)) return null;
    return {
      ...record,
      userId,
      status: record.status || "",
      metadata,
    };
  }

  function presenceAction(response) {
    const events = response?.events || [];
    if (events.some((event) => String(event).endsWith(".delete") || String(event).includes(".delete"))) return "delete";
    if (events.some((event) => String(event).endsWith(".update") || String(event).includes(".update"))) return "update";
    if (events.some((event) => String(event).endsWith(".upsert") || String(event).includes(".upsert"))) return "upsert";
    return "upsert";
  }

  function applyPresenceRecord(record, action = "upsert") {
    const presenceId = String(record?.$id || record?.id || "");
    if (!presenceId) return;
    if (action === "delete") {
      state.presenceRecords.delete(presenceId);
      return;
    }
    const normalized = normalizePresenceRecord(record);
    if (normalized) {
      state.presenceRecords.set(presenceId, normalized);
    } else {
      state.presenceRecords.delete(presenceId);
    }
  }

  function pruneExpiredPresences() {
    for (const [presenceId, record] of state.presenceRecords.entries()) {
      if (presenceIsExpired(record)) state.presenceRecords.delete(presenceId);
    }
  }

  function presenceRecordsForScope(scopeType, scopeId, kind = "viewing") {
    pruneExpiredPresences();
    const key = `${scopeType}:${scopeId}`;
    return Array.from(state.presenceRecords.values()).filter((record) => {
      const metadata = record.metadata || {};
      if (presenceScopeKey(metadata) !== key) return false;
      if (kind === "viewing") return metadata.kind === "viewing" && record.status === "online";
      if (kind === "typing") return metadata.kind === "typing" && record.status === "typing";
      return false;
    });
  }

  function presenceUserIdsForScope(scopeType, scopeId, kind = "viewing") {
    const ids = [];
    for (const record of presenceRecordsForScope(scopeType, scopeId, kind)) {
      const userId = presenceUserId(record);
      if (userId && !ids.includes(userId)) ids.push(userId);
    }
    return ids;
  }

  function onlineUserIds() {
    pruneExpiredPresences();
    const ids = new Set();
    for (const record of state.presenceRecords.values()) {
      if (record.status === "online" && record.metadata?.kind === "viewing") {
        ids.add(presenceUserId(record));
      }
    }
    return ids;
  }

  function usersForPresenceScope(scopeType, scopeId) {
    return presenceUserIdsForScope(scopeType, scopeId, "viewing")
      .map((userId) => state.knownUsers.get(userId) || { id: userId, name: "Nest User" });
  }

  function typingUsersForActiveRoom() {
    const scope = roomPresenceScope(state.activeRoom);
    if (!scope) return [];
    return presenceUserIdsForScope(scope.scope_type, scope.scope_id, "typing")
      .filter((userId) => userId !== currentUserId())
      .map((userId) => state.knownUsers.get(userId) || { id: userId, name: "Someone" });
  }

  function renderTypingIndicator() {
    if (!els.typing) return;
    const users = typingUsersForActiveRoom();
    if (!users.length) {
      els.typing.hidden = true;
      els.typing.textContent = "";
      return;
    }
    const names = users.map((user) => user.name || user.username || "Someone");
    let label = "Several people are typing...";
    if (names.length === 1) label = `${names[0]} is typing...`;
    if (names.length === 2) label = `${names[0]} and ${names[1]} are typing...`;
    els.typing.hidden = false;
    els.typing.textContent = label;
  }

  function renderPresenceDrivenUi() {
    registerKnownUsersFromState();
    const onlineIds = onlineUserIds();
    for (const channel of state.channels) {
      const scope = channel.presence_scope || { scope_type: "channel", scope_id: channel.id };
      const users = usersForPresenceScope(scope.scope_type, scope.scope_id);
      channel.active_users = users;
      channel.active_count = users.length;
      for (const user of users) registerKnownUser(user);
    }
    for (const thread of state.threads) {
      const other = thread.other_user || {};
      const isOnline = Boolean(other.id && onlineIds.has(String(other.id)));
      thread.presence_status = isOnline ? "online" : "offline";
      other.online = isOnline;
      const scope = thread.presence_scope || { scope_type: "thread", scope_id: thread.id };
      thread.active_count = presenceUserIdsForScope(scope.scope_type, scope.scope_id, "viewing").length;
    }
    updateRoomLists();
    renderHeader();
    const channel = activeChannel();
    const thread = activeThread();
    if (thread) {
      renderDmProfile(thread);
    } else if (channel && !channelIsPending(channel)) {
      renderMembers(channel.active_users || []);
    }
    renderTypingIndicator();
    void resolvePresenceUsersForActiveRoom();
  }

  async function resolvePresenceUsersForActiveRoom() {
    const room = state.activeRoom;
    const target = roomTarget(room);
    const scope = roomPresenceScope(room);
    if (!room || !target?.presence_profile_resolve_allowed || !scope) return;
    const unknownIds = presenceUserIdsForScope(scope.scope_type, scope.scope_id, "viewing")
      .concat(presenceUserIdsForScope(scope.scope_type, scope.scope_id, "typing"))
      .filter((userId, index, all) => all.indexOf(userId) === index)
      .filter((userId) => !state.knownUsers.has(userId));
    if (!unknownIds.length) return;
    const resolveKey = `${scope.scope_type}:${scope.scope_id}:${unknownIds.sort().join(",")}`;
    if (state.resolvingPresenceUsers.has(resolveKey)) return;
    state.resolvingPresenceUsers.add(resolveKey);
    try {
      const payload = await fetchJson("/api/chat/presence/users", {
        method: "POST",
        body: JSON.stringify({
          scope_type: scope.scope_type,
          scope_id: scope.scope_id,
          user_ids: unknownIds,
        }),
      });
      for (const user of payload.users || []) registerKnownUser(user);
      if (roomKey(state.activeRoom) === roomKey(room)) renderPresenceDrivenUi();
    } catch (error) {
      void error;
      // Profile resolution is best-effort; presence counts can still render.
    } finally {
      state.resolvingPresenceUsers.delete(resolveKey);
    }
  }

  function currentRoomUrl(room, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) query.set(key, value);
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    if (room.type === "channel") {
      return `/api/chat/channels/${encodeURIComponent(room.id)}/messages${suffix}`;
    }
    return `/api/chat/dm/threads/${encodeURIComponent(room.id)}/messages${suffix}`;
  }

  async function loadMessages({ before = null, after = null, after_message_id = null, force = false, preserveScroll = false, quiet = false, light = false } = {}) {
    const room = state.activeRoom;
    if (!room) return [];
    const cache = cacheFor(room);
    if (!cache) return [];
    if (state.loadingMessages && !force) return [];

    const channel = activeChannel();
    if (channelIsPending(channel)) {
      renderApprovalNotice(channel);
      return [];
    }

    const wasNearBottom = isNearBottom();
    const previousHeight = els.messages.scrollHeight;
    const previousTop = els.messages.scrollTop;
    const isDelta = Boolean(after || after_message_id);
    const useLight = light || (quiet && isDelta && !before);
    state.loadingMessages = true;
    if (!quiet && !before && !after && !after_message_id && !cache.loaded) renderMessageLoader();

    try {
      const payload = await fetchJson(currentRoomUrl(room, { before, after, after_message_id }));
      if (!state.activeRoom || roomKey(state.activeRoom) !== roomKey(room)) return [];

      const messages = payload.messages || [];
      const previousMessages = cache.messages;
      if (isDelta || before) {
        cache.messages = mergeMessages(cache.messages, messages);
      } else {
        cache.messages = mergeMessages([], messages);
      }
      cache.loaded = true;
      cache.stale = false;
      cache.hasMore = Boolean(payload.has_more);
      updateCacheCursors(cache);
      schedulePersistentRoomSave(room);
      if (!useLight) {
        if (payload.channel) updateChannel(payload.channel);
        if (payload.thread) updateThread(payload.thread);
        if (payload.read_state) state.roomReadState = payload.read_state;
        renderHeader();
        updateRoomLists();
        updateCurrentMembersFromPayload(payload);
        schedulePersistentBootstrapSave();
      }

      const incoming = messages.filter((message) => message?.id && !previousMessages.some((row) => row.id === message.id));
      const canIncremental = useLight && isDelta && !before;
      if (canIncremental) {
        if (incoming.length) {
          syncMessagesToDom(cache.messages, {
            incremental: true,
            incoming,
            scrollToBottom: wasNearBottom,
          });
        }
      } else {
        syncMessagesToDom(cache.messages, {
          scrollToBottom: !before && !isDelta && !preserveScroll && wasNearBottom,
        });
        if (before) {
          const delta = els.messages.scrollHeight - previousHeight;
          els.messages.scrollTop = previousTop + delta;
        } else if (!isDelta) {
          restoreScroll(cache, !preserveScroll);
        } else if (wasNearBottom) {
          stickToBottom();
        }
      }

      setStatus(null);

      if (!before && (wasNearBottom || !isDelta)) {
        markRoomRead(room, cache);
      }
      return messages;
    } catch (error) {
      setStatus(error.message || "Unable to load messages.", "error");
      return [];
    } finally {
      state.loadingMessages = false;
    }
  }

  async function prefetchRoomMessages(room) {
    const key = roomKey(room);
    if (!key || state.prefetchingRooms.has(key)) return;
    const cache = cacheFor(room);
    if (cache?.loaded && !cache.stale) return;
    state.prefetchingRooms.add(key);
    try {
      await hydrateRoomFromPersistentCache(room);
      const roomCache = cacheFor(room);
      const params = deltaLoadParams(roomCache);
      const payload = await fetchJson(currentRoomUrl(room, params));
      if (payload.channel) updateChannel(payload.channel);
      if (payload.thread) updateThread(payload.thread);
      const messages = payload.messages || [];
      roomCache.messages = params.after
        ? mergeMessages(roomCache.messages, messages)
        : mergeMessages([], messages);
      roomCache.loaded = true;
      roomCache.stale = false;
      roomCache.hasMore = Boolean(payload.has_more);
      updateCacheCursors(roomCache);
      schedulePersistentRoomSave(room);
      schedulePersistentBootstrapSave();
    } catch (_) {
      const roomCache = cacheFor(room);
      if (roomCache) roomCache.stale = true;
    } finally {
      state.prefetchingRooms.delete(key);
    }
  }

  function scheduleRoomPrefetches() {
    const rooms = [
      ...state.channels.map((channel) => ({ type: "channel", id: channel.id })),
      ...state.threads.slice(0, CHAT_PREFETCH_ROOM_LIMIT).map((thread) => ({ type: "thread", id: thread.id })),
    ]
      .filter((room) => room.id)
      .filter((room) => roomKey(room) !== roomKey(state.activeRoom))
      .slice(0, CHAT_PREFETCH_ROOM_LIMIT);
    if (!rooms.length) return;
    const run = () => {
      for (const room of rooms) {
        void prefetchRoomMessages(room);
      }
    };
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(run, { timeout: 2500 });
    } else {
      window.setTimeout(run, 700);
    }
  }

  function renderCachedRoom(room, options = {}) {
    const cache = cacheFor(room);
    if (!cache) return false;
    if (!cache.loaded) return false;
    renderMessages(cache.messages);
    restoreScroll(cache, Boolean(options.toBottom));
    return true;
  }

  function markRoomStale(room) {
    const cache = cacheFor(room);
    if (cache) cache.stale = true;
  }

  function removeMessageFromCaches(messageId) {
    if (!messageId) return;
    for (const [key, cache] of state.roomCache.entries()) {
      cache.messages = cache.messages.filter((message) => message.id !== messageId);
      updateCacheCursors(cache);
      const [type, id] = key.split(":");
      if (type && id) schedulePersistentRoomSave({ type, id });
    }
    const activeCache = cacheFor(state.activeRoom);
    if (activeCache) {
      if (!removeMessageFromDom(messageId)) {
        renderMessages(activeCache.messages);
      } else {
        updateAnnouncementsUnreadBanner(activeCache.messages);
        updateHistoryBannerVisibility();
      }
    }
  }

  async function selectRoom(room, options = {}) {
    const previousRoom = state.activeRoom;
    saveActiveScroll();
    closeInlineProfilePopover();
    state.activeRoom = room;
    state.activeProfile = null;
    updateRoomLists();
    renderHeader();
    if (!options.suppressFocus) focusComposerSoon();
    setStatus(null);
    handleActiveRoomPresenceChange(previousRoom);

    const channel = activeChannel();
    const thread = activeThread();
    if (channelIsPending(channel)) {
      renderApprovalNotice(channel);
      schedulePersistentBootstrapSave();
      return;
    }

    if (thread) {
      renderDmProfile(thread);
    } else {
      renderMembers(channel?.active_users || []);
    }

    const cache = cacheFor(room);
    if (!cache.loaded) {
      await hydrateRoomFromPersistentCache(room);
    }
    if (renderCachedRoom(room)) {
      if (!cache.stale || latestMessageForRead(cache)) {
        markRoomRead(room, cache);
      }
      if (cache.latestCursor) {
        const delta = deltaLoadParams(cache);
        await loadMessages({ ...delta, quiet: true, force: true, light: true });
        markRoomRead(room);
      } else if (cache.stale) {
        await loadMessages({ force: true, quiet: true });
        markRoomRead(room);
      }
    } else {
      await loadMessages({ force: true });
      markRoomRead(room);
    }
    renderPresenceDrivenUi();
    schedulePersistentBootstrapSave();
  }

  async function bootstrap({ preserveActive = false } = {}) {
    const payload = await fetchJson("/api/chat/bootstrap");
    state.user = payload.user || state.user;
    state.settings = { ...state.settings, ...(payload.settings || {}) };
    state.channels = (payload.sections?.nest || []).map(staleChannelPresence);
    state.threads = (payload.sections?.direct_messages || []).map(staleThreadPresence);
    state.university = payload.university || null;
    registerKnownUsersFromState();
    if (payload.discord_invite_url) root.dataset.discordInviteUrl = payload.discord_invite_url;
    state.serverBootstrapped = true;
    updateRoomLists();
    await startRealtimeServices();
    setMembersCollapsed(state.membersCollapsed);
    schedulePersistentBootstrapSave();
    await refreshChatSummary();

    const requestedRoom = requestedRoomFromLocation();
    if (requestedRoom) {
      const requestedExists = requestedRoom.type === "channel"
        ? state.channels.some((channel) => channel.id === requestedRoom.id)
        : state.threads.some((thread) => thread.id === requestedRoom.id);
      if (requestedExists) {
        await selectRoom(requestedRoom, { suppressFocus: preserveActive });
        scheduleRoomPrefetches();
        return;
      }
    }

    const activeKey = roomKey(state.activeRoom);
    if (activeKey) {
      const [type, id] = activeKey.split(":");
      const stillExists = type === "channel"
        ? state.channels.some((channel) => channel.id === id)
        : state.threads.some((thread) => thread.id === id);
      if (stillExists) {
        await selectRoom({ type, id }, { suppressFocus: preserveActive });
        scheduleRoomPrefetches();
        return;
      }
    }

    const firstChannel = state.channels[0];
    const firstThread = state.threads[0];
    if (firstChannel) {
      await selectRoom({ type: "channel", id: firstChannel.id });
    } else if (firstThread) {
      await selectRoom({ type: "thread", id: firstThread.id });
    } else {
      renderHeader();
      renderMessages([]);
    }
    scheduleRoomPrefetches();
  }

  function initializeChatEventStream() {
    if (state.realtimeReady || chatEventSource || state.realtimeConnecting) return;
    if (typeof window.EventSource !== "function") {
      startRealtimeFallback();
      return;
    }
    state.realtimeConnecting = true;
    try {
      const source = new EventSource(buildChatEventsStreamUrl());
      chatEventSource = source;
      source.onopen = () => {
        state.realtimeReady = true;
        state.realtimeConnecting = false;
        state.realtimeUnsubscribe = () => {
          if (chatEventSource) {
            chatEventSource.close();
            chatEventSource = null;
          }
        };
        stopRealtimeFallback();
        startRealtimeHeartbeat();
        pollActiveRoomMessages();
      };
      source.onmessage = (messageEvent) => {
        let payload;
        try {
          payload = JSON.parse(messageEvent.data);
        } catch {
          return;
        }
        const eventId = payload?.$id || payload?.id;
        if (eventId && seenChatEventIds.has(eventId)) return;
        if (eventId) seenChatEventIds.add(eventId);
        if (payload?.created_at) {
          chatEventCursor = { since: payload.created_at, after_id: eventId || null };
        }
        void handleRealtimePayload({ payload });
      };
      source.onerror = () => {
        handleRealtimeDisconnect();
      };
    } catch (error) {
      console.warn("Chat event stream unavailable", error);
      state.realtimeConnecting = false;
      handleRealtimeDisconnect();
    }
  }

  function presenceChannelName() {
    const Channel = window.Channel || (window.Appwrite && window.Appwrite.Channel);
    if (Channel?.presences) return Channel.presences();
    return "presences";
  }

  function normalizeRealtimeUnsubscribe(subscription) {
    if (typeof subscription === "function") return subscription;
    if (subscription && typeof subscription.unsubscribe === "function") {
      return () => subscription.unsubscribe();
    }
    if (subscription && typeof subscription.close === "function") {
      return () => subscription.close();
    }
    return null;
  }

  async function subscribeRealtime(channel, callback) {
    const realtime = window.realtime || (window.Appwrite?.Realtime && window.client ? new window.Appwrite.Realtime(window.client) : null);
    if (realtime?.subscribe) {
      const subscription = await realtime.subscribe(channel, callback);
      return normalizeRealtimeUnsubscribe(subscription);
    }
    if (typeof window.client?.subscribe === "function") {
      const subscription = window.client.subscribe(channel, callback);
      return normalizeRealtimeUnsubscribe(subscription);
    }
    return null;
  }

  async function initializePresenceRealtime() {
    if (state.presenceReady || state.presenceUnsubscribe || state.presenceConnecting) return;
    if (!window.presences && !window.realtime) return;
    state.presenceConnecting = true;
    try {
      const unsubscribe = await subscribeRealtime(presenceChannelName(), handlePresenceRealtimePayload);
      if (typeof unsubscribe === "function") {
        state.presenceUnsubscribe = unsubscribe;
        state.presenceReady = true;
      }
    } catch (error) {
      console.warn("Appwrite presence realtime unavailable", error);
    } finally {
      state.presenceConnecting = false;
    }
  }

  function normalizeChatEvent(response) {
    const raw = response?.payload ?? response?.row ?? response;
    if (!raw || typeof raw !== "object") return null;
    const nested = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : null;
    if (!nested) return raw;
    return {
      ...nested,
      ...raw,
      scope_type: raw.scope_type || nested.scope_type,
      scope_id: raw.scope_id || nested.scope_id,
      event_type: raw.event_type || nested.event_type,
      message_id: raw.message_id || nested.message_id,
      thread_id: raw.thread_id || nested.thread_id,
      channel_id: raw.channel_id || nested.channel_id,
      actor_id: raw.actor_id || nested.actor_id,
    };
  }

  function eventIsRelevant(event) {
    if (!event) return false;
    if (event.scope_type === "channel") {
      return state.channels.some((channel) => channel.id === event.scope_id);
    }
    if (event.scope_type === "thread") {
      return state.threads.some((thread) => thread.id === event.scope_id) || event.thread_id;
    }
    if (event.scope_type === "university") {
      return Boolean(state.university?.school_key && state.university.school_key === event.scope_id);
    }
    return false;
  }

  async function handleRealtimePayload(response) {
    const event = normalizeChatEvent(response);
    if (!eventIsRelevant(event)) return;
    const active = state.activeRoom;
    const eventRoom = event.scope_type === "channel"
      ? { type: "channel", id: event.scope_id || event.channel_id }
      : event.scope_type === "thread"
        ? { type: "thread", id: event.scope_id || event.thread_id }
        : null;

    if (event.event_type === "message_deleted") {
      removeMessageFromCaches(event.message_id);
      void refreshChatSummary();
      return;
    }

    if (event.event_type === "message_created") {
      if (eventRoom?.type === "thread" && !threadExists(eventRoom.id)) {
        const thread = await fetchThread(eventRoom.id);
        if (!thread) {
          await bootstrap({ preserveActive: true });
        }
      }
      if (eventRoom && active && roomKey(eventRoom) === roomKey(active)) {
        await ingestActiveRoomMessage(event);
      } else if (eventRoom) {
        markRoomStale(eventRoom);
        incrementRoomUnread({ ...eventRoom, actor_id: event.actor_id });
        void refreshChatSummary();
        playChatSound(event.actor_id);
      }
      return;
    }

    if (event.event_type === "message_updated") {
      if (eventRoom && active && roomKey(eventRoom) === roomKey(active)) {
        await ingestMessageUpdate(event);
      } else if (eventRoom) {
        markRoomStale(eventRoom);
      }
      return;
    }

    if (["thread_updated", "block_updated", "university_approved", "university_denied"].includes(event.event_type)) {
      if (eventRoom) markRoomStale(eventRoom);
      if (event.event_type === "thread_updated" && eventRoom?.type === "thread") {
        const thread = await fetchThread(eventRoom.id);
        if (thread) {
          void refreshChatSummary();
          return;
        }
      }
      await bootstrap({ preserveActive: true });
    }
  }

  async function handlePresenceRealtimePayload(response) {
    applyPresenceRecord(response?.payload || response?.presence || response, presenceAction(response));
    renderPresenceDrivenUi();
  }

  async function loadInitialPresences() {
    if (!window.presences?.list || !window.Query) {
      renderPresenceDrivenUi();
      return;
    }
    try {
      const payload = await window.presences.list({
        queries: [window.Query.equal("status", ["online", "typing"])],
        total: false,
        ttl: 0,
      });
      state.presenceRecords.clear();
      for (const record of payload.presences || payload.rows || payload.documents || []) {
        applyPresenceRecord(record, "upsert");
      }
      renderPresenceDrivenUi();
    } catch (error) {
      console.warn("Unable to load Appwrite presences", error);
      renderPresenceDrivenUi();
    }
  }

  function activePresencePayload(kind, room = state.activeRoom) {
    const scope = roomPresenceScope(room);
    const permissions = roomPresencePermissions(room);
    const userId = currentUserId();
    if (!userId || !scope || !permissions.length) return null;
    const status = kind === "typing" ? "typing" : "online";
    const prefix = kind === "typing" ? "ct" : "cv";
    const presenceId = `${prefix}_${compactHash(`${userId}:${currentTabId()}:${kind}:${scope.scope_type}:${scope.scope_id}`)}`;
    return {
      presenceId,
      status,
      permissions,
      expiresAt: new Date(Date.now() + (kind === "typing" ? TYPING_PRESENCE_TTL_MS : VIEWING_PRESENCE_TTL_MS)).toISOString(),
      metadata: {
        app: PRESENCE_APP_ID,
        kind,
        scopeType: scope.scope_type,
        scopeId: scope.scope_id,
        roomKey: scope.room_key || `${scope.scope_type}:${scope.scope_id}`,
        tabId: currentTabId(),
      },
    };
  }

  async function upsertPresence(kind, room = state.activeRoom) {
    const payload = activePresencePayload(kind, room);
    if (!payload || document.visibilityState === "hidden") return null;
    try {
      if (window.presences?.upsert) {
        const presence = await window.presences.upsert(payload);
        applyPresenceRecord({
          ...(presence || {}),
          $id: presence?.$id || presence?.id || payload.presenceId,
          id: presence?.id || presence?.$id || payload.presenceId,
          userId: presence?.userId || currentUserId(),
          status: presence?.status || payload.status,
          expiresAt: presence?.expiresAt || payload.expiresAt,
          metadata: presence?.metadata || payload.metadata,
        });
        renderPresenceDrivenUi();
      } else {
        const realtime = window.realtime;
        if (!realtime?.upsertPresence) return null;
        const { expiresAt, ...realtimePayload } = payload;
        await realtime.upsertPresence(realtimePayload);
        applyPresenceRecord({
          $id: payload.presenceId,
          id: payload.presenceId,
          userId: currentUserId(),
          status: payload.status,
          expiresAt: payload.expiresAt,
          metadata: payload.metadata,
        });
        renderPresenceDrivenUi();
      }
      if (kind === "typing") state.lastTypingPresenceId = payload.presenceId;
      else state.lastViewingPresenceId = payload.presenceId;
      return payload.presenceId;
    } catch (error) {
      console.warn("Unable to update chat presence", error);
      return null;
    }
  }

  async function deletePresence(presenceId) {
    if (!presenceId || !window.presences?.delete) return;
    try {
      await window.presences.delete({ presenceId });
      state.presenceRecords.delete(presenceId);
      renderPresenceDrivenUi();
    } catch (error) {
      void error;
      // Expiration will clean this up if the delete races navigation or reconnects.
    }
  }

  function presenceIdFor(kind, room) {
    return activePresencePayload(kind, room)?.presenceId || null;
  }

  function clearTypingPresence(room = state.activeRoom) {
    window.clearTimeout(state.typingInputTimer);
    window.clearTimeout(state.typingClearTimer);
    const presenceId = presenceIdFor("typing", room) || state.lastTypingPresenceId;
    state.lastTypingPresenceId = null;
    void deletePresence(presenceId);
  }

  function refreshViewingPresence() {
    void upsertPresence("viewing");
  }

  function handleActiveRoomPresenceChange(previousRoom) {
    if (previousRoom && roomKey(previousRoom) !== roomKey(state.activeRoom)) {
      clearTypingPresence(previousRoom);
      const previousViewingId = presenceIdFor("viewing", previousRoom) || state.lastViewingPresenceId;
      state.lastViewingPresenceId = null;
      void deletePresence(previousViewingId);
    }
    refreshViewingPresence();
  }

  function scheduleTypingPresence() {
    const channel = activeChannel();
    const thread = activeThread();
    if (!els.input || !els.input.value.trim()) {
      clearTypingPresence();
      return;
    }
    if ((channel && !channelIsWritable(channel)) || thread?.blocked) return;
    window.clearTimeout(state.typingInputTimer);
    state.typingInputTimer = window.setTimeout(() => {
      void upsertPresence("typing");
      window.clearTimeout(state.typingClearTimer);
      state.typingClearTimer = window.setTimeout(() => clearTypingPresence(), TYPING_PRESENCE_TTL_MS + 400);
    }, 150);
  }

  function startPresenceRefreshTimer() {
    window.clearInterval(state.presenceRefreshTimer);
    state.presenceRefreshTimer = window.setInterval(refreshViewingPresence, VIEWING_PRESENCE_REFRESH_MS);
  }

  async function sendActiveMessage(event) {
    event.preventDefault();
    const room = state.activeRoom;
    if (!room || !els.input) return;
    const content = els.input.value.trim();
    if (!content) return;
    const channel = activeChannel();
    const thread = activeThread();
    if (channel && !channelIsWritable(channel)) return;
    if (thread?.blocked) return;

    els.sendButton.disabled = true;
    clearTypingPresence(room);
    try {
      const url = currentRoomUrl(room);
      const payload = await fetchJson(url, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      els.input.value = "";
      autosizeComposer();
      const cache = cacheFor(room);
      if (cache && payload.message) {
        applyIncomingMessages(room, [payload.message], { toBottom: true });
      }
      refreshViewingPresence();
      schedulePersistentBootstrapSave();
    } catch (error) {
      setStatus(error.message || "Unable to send message.", "error");
    } finally {
      const writable = channel ? channelIsWritable(channel) : !activeThread()?.blocked;
      els.sendButton.disabled = !writable;
    }
  }

  function handleComposerKeydown(event) {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey) {
      window.setTimeout(() => {
        autosizeComposer();
        scheduleTypingPresence();
      }, 0);
      return;
    }
    event.preventDefault();
    if (els.composer?.requestSubmit) {
      els.composer.requestSubmit();
    } else {
      void sendActiveMessage(event);
    }
  }

  async function deleteMessage(messageId) {
    if (!messageId) return;
    const ok = window.APStudyConfirm
      ? await window.APStudyConfirm.request({
        title: "Delete message?",
        message: "Messages can only be deleted within 5 minutes of sending.",
        acceptLabel: "Delete",
        danger: true,
      })
      : window.confirm("Delete this message?");
    if (!ok) return;
    try {
      await fetchJson(`/api/chat/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
      removeMessageFromCaches(messageId);
    } catch (error) {
      setStatus(error.message || "Unable to delete message.", "error");
    }
  }

  function autosizeComposer() {
    if (!els.input) return;
    els.input.style.height = "auto";
    const nextHeight = Math.min(112, Math.max(24, els.input.scrollHeight));
    els.input.style.height = `${nextHeight}px`;
  }

  async function searchPeople() {
    const query = els.dmSearchInput.value.trim();
    if (query.length < 2) {
      els.dmResults.innerHTML = "";
      return;
    }
    try {
      const payload = await fetchJson(`/api/chat/dm/search?q=${encodeURIComponent(query)}`);
      const results = payload.results || [];
      els.dmResults.innerHTML = results.length
        ? results.map((user) => `
          <button type="button" class="chat-member chat-dm-result" data-start-dm="${escapeHtml(user.id)}">
            <img ${avatarAttrs(user.picture_url, 72, "36px")} alt="">
            <span>
              <strong>${escapeHtml(user.name || user.username || "Nest User")}</strong>
              <small>${escapeHtml([user.school, user.major].filter(Boolean).join(" · ") || user.username || "User")}</small>
            </span>
          </button>
        `).join("")
        : `<div class="chat-empty chat-empty-compact">No users found.</div>`;
    } catch (error) {
      els.dmResults.innerHTML = `<div class="chat-empty chat-empty-compact">${escapeHtml(error.message)}</div>`;
    }
  }

  async function startDm(userId) {
    try {
      const payload = await fetchJson("/api/chat/dm/threads", {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      });
      updateThread(payload.thread);
      if (payload.thread?.id) {
        setRoomUnread({ type: "thread", id: payload.thread.id }, { unread_count: 0, has_unread: false });
      }
      renderThreads();
      els.dmSearch.hidden = true;
      els.dmSearchInput.value = "";
      els.dmResults.innerHTML = "";
      await selectRoom({ type: "thread", id: payload.thread.id });
      schedulePersistentBootstrapSave();
    } catch (error) {
      setStatus(error.message || "Unable to start direct message.", "error");
    }
  }

  async function toggleBlock(userId, currentlyBlocked) {
    try {
      const payload = await fetchJson(`/api/chat/blocks/${encodeURIComponent(userId)}`, {
        method: currentlyBlocked ? "DELETE" : "POST",
      });
      const thread = activeThread();
      if (thread) {
        thread.blocked = Boolean(payload.blocked);
        renderHeader();
        renderDmProfile(thread);
        schedulePersistentBootstrapSave();
      }
    } catch (error) {
      setStatus(error.message || "Unable to update block.", "error");
    }
  }

  function setMembersCollapsed(collapsed) {
    state.membersCollapsed = Boolean(collapsed);
    sessionStorage.setItem("apstudy-chat-members-collapsed", String(state.membersCollapsed));
    root.classList.toggle("members-collapsed", state.membersCollapsed);
    els.profileToggle?.classList.toggle("is-active", !state.membersCollapsed);
    els.profileToggle?.setAttribute("aria-pressed", String(!state.membersCollapsed));
    const label = state.membersCollapsed ? "Show user profile" : "Hide user profile";
    els.profileToggle?.setAttribute("aria-label", label);
    els.profileToggle?.setAttribute("title", label);
    if (state.persistentCacheReady || state.serverBootstrapped) {
      schedulePersistentBootstrapSave();
    }
  }

  function bindEvents() {
    els.composer?.addEventListener("submit", sendActiveMessage);
    els.input?.addEventListener("keydown", handleComposerKeydown);
    els.input?.addEventListener("input", () => {
      autosizeComposer();
      scheduleTypingPresence();
    });
    els.messages?.addEventListener("scroll", () => {
      const cache = cacheFor(state.activeRoom);
      if (cache) cache.scrollTop = els.messages.scrollTop;
      updateHistoryBannerVisibility();
      window.clearTimeout(state.scrollSaveTimer);
      state.scrollSaveTimer = window.setTimeout(() => {
        schedulePersistentRoomSave(state.activeRoom);
      }, 350);
      if (els.messages.scrollTop <= 16 && cache?.hasMore && cache.oldestCursor && !state.loadingMessages) {
        void loadMessages({ before: cache.oldestCursor, preserveScroll: true, quiet: true });
      }
      closeInlineProfilePopover();
    });
    els.messages?.addEventListener("click", (event) => {
      const authorButton = event.target.closest("[data-author-message-id]");
      if (authorButton) {
        event.preventDefault();
        const messageId = authorButton.dataset.authorMessageId;
        const cache = cacheFor(state.activeRoom);
        const message = cache?.messages?.find((candidate) => candidate.id === messageId);
        if (message) openInlineProfileForMessage(message, authorButton);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-message]");
      if (deleteButton) void deleteMessage(deleteButton.dataset.deleteMessage);
    });
    els.memberList?.addEventListener("click", (event) => {
      const profileButton = event.target.closest("[data-profile-id]");
      if (!profileButton) return;
      const channel = activeChannel();
      const user = (channel?.active_users || []).find((candidate) => candidate.id === profileButton.dataset.profileId);
      if (user) {
        els.profilePanel.hidden = false;
        els.profilePanel.innerHTML = profileMarkup(user, { showBlock: false, status: "online" });
      }
    });
    els.profilePanel?.addEventListener("click", (event) => {
      const blockButton = event.target.closest("[data-block-user]");
      if (!blockButton) return;
      void toggleBlock(blockButton.dataset.blockUser, blockButton.dataset.blocked === "true");
    });
    els.announcementsRead?.addEventListener("click", () => {
      void markAnnouncementsRead();
    });
    els.dmNew?.addEventListener("click", () => {
      els.dmSearch.hidden = !els.dmSearch.hidden;
      if (!els.dmSearch.hidden) els.dmSearchInput.focus();
    });
    els.dmSearchInput?.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(searchPeople, 180);
    });
    els.dmResults?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-start-dm]");
      if (button) void startDm(button.dataset.startDm);
    });
    document.addEventListener("click", (event) => {
      const menu = document.getElementById("chat-room-context-menu");
      if (menu && !menu.hidden && !menu.contains(event.target)) closeRoomContextMenu();
      if (inlineProfilePopover && !event.target.closest(".chat-inline-profile-popover") && !event.target.closest(".chat-author-button")) {
        closeInlineProfilePopover();
      }
    });
    els.profileToggle?.addEventListener("click", () => setMembersCollapsed(!state.membersCollapsed));
    document.querySelector("[data-restore-members]")?.addEventListener("click", () => setMembersCollapsed(false));
    const rail = document.getElementById("chat-rail");
    const backdrop = document.getElementById("chat-drawer-backdrop");
    const closeChatDrawers = () => {
      rail?.classList.remove("is-open");
      els.members?.classList.remove("is-open");
      if (backdrop) backdrop.hidden = true;
      document.body.classList.remove("chat-drawer-open");
    };
    const openChatDrawer = (drawer) => {
      if (!drawer) return;
      if (drawer === rail) els.members?.classList.remove("is-open");
      else rail?.classList.remove("is-open");
      drawer.classList.add("is-open");
      if (backdrop) backdrop.hidden = false;
      document.body.classList.add("chat-drawer-open");
    };
    document.querySelector("[data-open-rail]")?.addEventListener("click", () => openChatDrawer(rail));
    document.querySelector("[data-close-rail]")?.addEventListener("click", closeChatDrawers);
    document.querySelector("[data-open-members]")?.addEventListener("click", () => openChatDrawer(els.members));
    document.querySelector("[data-close-members]")?.addEventListener("click", closeChatDrawers);
    backdrop?.addEventListener("click", closeChatDrawers);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeRoomContextMenu();
        closeChatDrawers();
        closeInlineProfilePopover();
      }
    });
    els.channelList?.addEventListener("scroll", closeRoomContextMenu);
    els.dmList?.addEventListener("scroll", closeRoomContextMenu);
    window.addEventListener("resize", () => {
      closeRoomContextMenu();
      closeInlineProfilePopover();
      if (window.innerWidth > 1100) closeChatDrawers();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const room = state.activeRoom;
        const cache = cacheFor(room);
        if (cache?.loaded) {
          if (cache.latestCursor) {
            const delta = deltaLoadParams(cache);
            void loadMessages({ ...delta, quiet: true, force: true, light: true })
              .finally(() => {
                markRoomRead(room, cache);
                void refreshChatSummary();
              });
          } else if (cache.stale) {
            void loadMessages({ force: true, quiet: true })
              .finally(() => {
                markRoomRead(room, cache);
                void refreshChatSummary();
              });
          } else {
            markRoomRead(room, cache);
            void refreshChatSummary();
          }
        } else {
          void refreshChatSummary();
        }
        void loadInitialPresences();
        refreshViewingPresence();
      } else {
        clearTypingPresence();
        const presenceId = state.lastViewingPresenceId;
        state.lastViewingPresenceId = null;
        void deletePresence(presenceId);
      }
    });
    window.addEventListener("beforeunload", () => {
      saveActiveScroll();
      clearTypingPresence();
      const presenceId = state.lastViewingPresenceId;
      state.lastViewingPresenceId = null;
      void deletePresence(presenceId);
      if (state.realtimeUnsubscribe) state.realtimeUnsubscribe();
      if (state.presenceUnsubscribe) state.presenceUnsubscribe();
      stopRealtimeFallback();
      stopRealtimeHeartbeat();
      if (appwriteJwtRefreshTimer) {
        window.clearTimeout(appwriteJwtRefreshTimer);
        appwriteJwtRefreshTimer = null;
      }
    });
  }

  async function startChat() {
    setMembersCollapsed(state.membersCollapsed);
    renderMessageLoader();
    const cachePromise = hydrateFromPersistentCache().catch((error) => {
      console.warn("Unable to hydrate chat cache", error);
      state.persistentCacheReady = true;
      return false;
    });
    const bootstrapPromise = bootstrap().catch((error) => {
      setStatus(error.message || "Unable to load chat.", "error");
      throw error;
    });
    await Promise.allSettled([cachePromise, bootstrapPromise]);
  }

  bindEvents();
  startPresenceRefreshTimer();
  void startChat();
})();
