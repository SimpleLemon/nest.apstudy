import {
  ANNOUNCEMENTS_CHANNEL_ID,
  REALTIME_FALLBACK_MS,
  els,
  root,
  state,
} from "./context.js";
import {
  avatarAttrs,
  escapeHtml,
  parseMessageDate,
} from "./utils.js";
import {
  cacheFor,
  clearRoomUnread,
  fetchJson,
  latestMessageForRead,
  markRoomRead,
  markRoomUnread,
  refreshChatSummary,
  unreadForRoom,
} from "./cache.js";
import {
  profileMarkup,
} from "./render-messages.js";
import {
  loadMessages,
  selectRoom,
} from "./load.js";
import {
  autosizeComposer,
} from "./actions.js";

export let realtimeFallbackTimer = null;

export let inlineProfilePopover = null;

export function setStatus(message, tone = "info") {
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

export function renderMessageLoader(label = "Loading messages...") {
  if (!els.messages) return;
  const loader = window.APStudyLoader?.html
    ? window.APStudyLoader.html(label, { sizePx: 46, textToneClass: "text-on-surface" })
    : `<div class="chat-empty">${escapeHtml(label)}</div>`;
  els.messages.innerHTML = `<div class="chat-message-loader">${loader}</div>`;
}

export function focusComposerSoon() {
  if (!els.input || els.input.disabled || els.composer?.hidden) return;
  window.setTimeout(() => els.input?.focus({ preventScroll: true }), 0);
}

export function playChatSound(actorId) {
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

export function activeChannel() {
  if (state.activeRoom?.type !== "channel") return null;
  return state.channels.find((channel) => channel.id === state.activeRoom.id) || null;
}

export function activeThread() {
  if (state.activeRoom?.type !== "thread") return null;
  return state.threads.find((thread) => thread.id === state.activeRoom.id) || null;
}

export function threadExists(threadId) {
  return state.threads.some((thread) => thread.id === threadId);
}

export function channelIsPending(channel) {
  return channel?.kind === "university" && !channel.approved;
}

export function channelIsWritable(channel) {
  return Boolean(channel && !channel.read_only && channel.approved !== false);
}

export function channelLabel(channel) {
  return channel?.label || channel?.school_name || channel?.name || "Channel";
}

export function channelMeta(channel) {
  if (channelIsPending(channel)) {
    if (channel.university_status === "denied") return "Denied";
    return "Waiting approval";
  }
  return `${channel.active_count || 0} active`;
}

export function channelSymbol(channel) {
  if (channel?.kind === "university") return "U";
  return "#";
}

export function unreadBadgeMarkup(type, id) {
  const unread = unreadForRoom(type, id);
  if (!unread.has_unread || Number(unread.unread_count || 0) <= 0) return "";
  const count = Number(unread.unread_count || 0);
  const label = count >= 99 ? "99+" : String(count);
  const ariaLabel = `${label} unread ${label === "1" ? "message" : "messages"}`;
  return `<span class="chat-room-unread-badge" aria-label="${escapeHtml(ariaLabel)}">${escapeHtml(label)}</span>`;
}

export function roomButton({ type, id, active, leading, title, meta, className = "" }) {
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

export function ensureRoomContextMenu() {
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

export function closeRoomContextMenu() {
  const menu = document.getElementById("chat-room-context-menu");
  if (menu) menu.hidden = true;
  state.contextMenuRoom = null;
}

export function openRoomContextMenu(room, event) {
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

export function renderChannels() {
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

export function dmPresenceStatus(thread) {
  if (thread?.presence_status) return thread.presence_status === "online" ? "online" : "offline";
  return thread?.other_user?.online ? "online" : "offline";
}

export function dmPresenceMarkup(status) {
  const label = status === "online" ? "Online" : "Offline";
  return `
    <small class="chat-presence-line">
      <span>${label}</span>
    </small>
  `;
}

export function renderThreads() {
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

export function updateRoomLists() {
  renderChannels();
  renderThreads();
}

export function setHistoryBanner(channel) {
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

export function messagePaneIsScrollable() {
  if (!els.messages) return false;
  return els.messages.scrollHeight > els.messages.clientHeight + 1;
}

export function updateHistoryBannerVisibility() {
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

export function unreadAnnouncementMessages(messages, readState) {
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

export function announcementUnreadFitsInPane(unreadNodes) {
  if (!els.messages || !unreadNodes.length) return true;
  const paneTop = els.messages.getBoundingClientRect().top;
  const paneBottom = paneTop + els.messages.clientHeight;
  const first = unreadNodes[0].getBoundingClientRect();
  const last = unreadNodes[unreadNodes.length - 1].getBoundingClientRect();
  return first.top >= paneTop && last.bottom <= paneBottom;
}

export async function markAnnouncementsRead() {
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

export function updateAnnouncementsUnreadBanner(messages) {
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

export function closeInlineProfilePopover() {
  if (inlineProfilePopover) {
    inlineProfilePopover.remove();
    inlineProfilePopover = null;
  }
}

export function positionInlineProfilePopover(anchor, popover) {
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

export function openInlineProfileForMessage(message, anchor) {
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

export function startRealtimeFallback() {
  if (realtimeFallbackTimer || state.realtimeReady) return;
  realtimeFallbackTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (state.realtimeReady) {
      stopRealtimeFallback();
      return;
    }
    const room = state.activeRoom;
    const cache = cacheFor(room);
    if (room && cache) {
      if (cache.latestCursor) {
        void loadMessages({ after: cache.latestCursor, quiet: true });
      } else {
        void loadMessages({ force: true, quiet: true });
      }
    }
    void refreshChatSummary();
  }, REALTIME_FALLBACK_MS);
}

export function stopRealtimeFallback() {
  if (!realtimeFallbackTimer) return;
  window.clearInterval(realtimeFallbackTimer);
  realtimeFallbackTimer = null;
}

export function setComposer(enabled, placeholder) {
  if (!els.composer || !els.input || !els.sendButton) return;
  els.composer.hidden = false;
  els.input.disabled = !enabled;
  els.sendButton.disabled = !enabled;
  els.input.placeholder = placeholder || "Message";
  autosizeComposer();
}
