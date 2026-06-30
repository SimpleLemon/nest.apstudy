import {
  CHAT_TAB_ID_KEY,
  DEFAULT_AVATAR,
  MESSAGE_GROUP_WINDOW_MS,
  root,
  state,
} from "./context.js";

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function avatarUrl(url, size = 64) {
  const candidate = url || DEFAULT_AVATAR;
  if (typeof window.APSTUDY_AVATAR_URL_FOR_SIZE === "function") {
    return window.APSTUDY_AVATAR_URL_FOR_SIZE(candidate, size);
  }
  return candidate;
}

export function avatarAttrs(url, size = 64, sizes = `${size}px`) {
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

export function parseMessageDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localDateKey(date) {
  if (!date) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function calendarDayDifference(date, now = new Date()) {
  if (!date) return 0;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((start - target) / 86400000);
}

export function formatClockTime(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatMessageTimestamp(value, now = new Date()) {
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

export function messageAuthorKey(message) {
  return String(message?.user_id || message?.author_username || message?.author_name || "");
}

export function shouldGroupMessage(previous, next) {
  const previousDate = parseMessageDate(previous?.created_at);
  const nextDate = parseMessageDate(next?.created_at);
  if (!previousDate || !nextDate) return false;
  if (messageAuthorKey(previous) !== messageAuthorKey(next)) return false;
  if (localDateKey(previousDate) !== localDateKey(nextDate)) return false;
  return nextDate - previousDate <= MESSAGE_GROUP_WINDOW_MS;
}

export function groupMessages(messages) {
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

export function plural(value, singular, pluralLabel) {
  const number = Number(value) || 0;
  return `${number} ${number === 1 ? singular : pluralLabel}`;
}

export function roomKey(room) {
  if (!room || !room.id || !room.type) return "";
  return `${room.type}:${room.id}`;
}

export function unreadKey(type, id) {
  return roomKey({ type, id });
}

export function requestedRoomFromLocation() {
  const params = new URLSearchParams(window.location.search || "");
  const channelId = params.get("channel");
  if (channelId) return { type: "channel", id: channelId };
  const threadId = params.get("thread");
  if (threadId) return { type: "thread", id: threadId };
  return null;
}

export function currentUserId() {
  return String(state.user?.id || root.dataset.currentUserId || "");
}

export function currentTabId() {
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

export function compactHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function registerKnownUser(user) {
  if (!user?.id) return;
  state.knownUsers.set(String(user.id), { ...(state.knownUsers.get(String(user.id)) || {}), ...user });
}

export function registerKnownUsersFromState() {
  registerKnownUser(state.user);
  for (const channel of state.channels || []) {
    for (const user of channel.active_users || []) registerKnownUser(user);
  }
  for (const thread of state.threads || []) {
    registerKnownUser(thread.other_user);
  }
}

export function staleChannelPresence(channel) {
  return {
    ...channel,
    active_count: 0,
    active_users: [],
  };
}

export function staleThreadPresence(thread) {
  const other = thread?.other_user ? { ...thread.other_user, online: false } : thread?.other_user;
  return {
    ...thread,
    other_user: other,
    active_count: 0,
    presence_status: "offline",
  };
}

export function roomTarget(room) {
  if (!room) return null;
  if (room.type === "channel") return state.channels.find((channel) => channel.id === room.id) || null;
  if (room.type === "thread") return state.threads.find((thread) => thread.id === room.id) || null;
  return null;
}

export function roomPresenceScope(room) {
  const target = roomTarget(room);
  if (target?.presence_scope?.scope_type && target?.presence_scope?.scope_id) return target.presence_scope;
  if (!room?.type || !room?.id) return null;
  return {
    scope_type: room.type,
    scope_id: room.id,
    room_key: `${room.type}:${room.id}`,
  };
}

export function roomPresencePermissions(room) {
  const target = roomTarget(room);
  return Array.isArray(target?.presence_read_permissions) ? target.presence_read_permissions : [];
}

export function presenceScopeKey(scopeOrMetadata) {
  const scopeType = scopeOrMetadata?.scope_type || scopeOrMetadata?.scopeType;
  const scopeId = scopeOrMetadata?.scope_id || scopeOrMetadata?.scopeId;
  return scopeType && scopeId ? `${scopeType}:${scopeId}` : "";
}

export function knownPresenceScopeKeys() {
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
