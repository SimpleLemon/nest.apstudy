import {
  els,
  root,
  state,
} from "./context.js";
import {
  activeChannel,
  activeThread,
  channelIsWritable,
  closeInlineProfilePopover,
  closeRoomContextMenu,
  inlineProfilePopover,
  markAnnouncementsRead,
  openInlineProfileForMessage,
  renderThreads,
  setStatus,
  stopRealtimeFallback,
  updateHistoryBannerVisibility,
} from "./render-ui.js";
import {
  avatarAttrs,
  escapeHtml,
} from "./utils.js";
import {
  cacheFor,
  fetchJson,
  markRoomRead,
  mergeMessages,
  refreshChatSummary,
  restoreScroll,
  saveActiveScroll,
  schedulePersistentBootstrapSave,
  schedulePersistentRoomSave,
  setRoomUnread,
  updateCacheCursors,
} from "./cache.js";
import {
  profileMarkup,
  renderDmProfile,
  renderHeader,
  renderMessages,
  updateThread,
} from "./render-messages.js";
import {
  currentRoomUrl,
} from "./presence.js";
import {
  loadMessages,
  removeMessageFromCaches,
  selectRoom,
} from "./load.js";
import {
  clearTypingPresence,
  deletePresence,
  loadInitialPresences,
  refreshViewingPresence,
  scheduleTypingPresence,
} from "./realtime.js";

export async function sendActiveMessage(event) {
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
      cache.messages = mergeMessages(cache.messages, [payload.message]);
      cache.loaded = true;
      updateCacheCursors(cache);
      renderMessages(cache.messages);
      restoreScroll(cache, true);
      schedulePersistentRoomSave(room);
      markRoomRead(room, cache);
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

export function handleComposerKeydown(event) {
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

export async function deleteMessage(messageId) {
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

export function autosizeComposer() {
  if (!els.input) return;
  els.input.style.height = "auto";
  const nextHeight = Math.min(112, Math.max(24, els.input.scrollHeight));
  els.input.style.height = `${nextHeight}px`;
}

export async function searchPeople() {
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

export async function startDm(userId) {
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

export async function toggleBlock(userId, currentlyBlocked) {
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

export function setMembersCollapsed(collapsed) {
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

export function bindEvents() {
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
          void loadMessages({ after: cache.latestCursor, quiet: true })
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
  });
}
