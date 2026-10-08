import {
  avatarAttrs,
  escapeHtml,
  formatMessageTimestamp,
  groupMessages,
  localDateKey,
  parseMessageDate,
  shouldGroupMessage,
} from "./presentation.js";

export function messageBodyMarkup(message) {
  return message?.rendered_html || escapeHtml(message?.content || "");
}

export function messageTimestampMarkup(value) {
  return escapeHtml(formatMessageTimestamp(value));
}

export function createChatMessagesDom({ readState, root, state, els, extensions, config, fetchJson, composer, feedback, identity, loading, profiles, rooms, scheduler, store, view }) {
  const { ANNOUNCEMENTS_CHANNEL_ID, GRAMMARLY_DISABLED_ATTRS } = config;
  let inlineProfilePopover = null;

  function isActiveRoom(room) {
    return Boolean(
      room
      && state.activeRoom
      && identity.roomKey(state.activeRoom) === identity.roomKey(room)
    );
  }

  function renderMessageLoader(label = "Loading messages...") {
    if (!els.messages) return;
    const loader = window.APStudyLoader?.html
      ? window.APStudyLoader.html(label, { sizePx: 46, textToneClass: "text-on-surface" })
      : `<div class="chat-empty">${escapeHtml(label)}</div>`;
    els.messages.innerHTML = `<div class="chat-message-loader" ${GRAMMARLY_DISABLED_ATTRS}>${loader}</div>`;
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
    const channel = rooms.activeChannel();
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

  function unreadAnnouncementMessages(messages, roomReadState) {
    const lastReadAt = roomReadState?.last_read_at ? parseMessageDate(roomReadState.last_read_at) : null;
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
    const cache = store.cacheFor(room);
    const latest = identity.latestMessageForRead(cache);
    if (!latest?.id) return;
    return readState.markRoomRead(room, cache, { announcements: true });
  }

  function updateAnnouncementsUnreadBanner(messages) {
    if (!els.announcementsUnread) return;
    const channel = rooms.activeChannel();
    if (!channel || channel.id !== ANNOUNCEMENTS_CHANNEL_ID) {
      els.announcementsUnread.hidden = true;
      state.announcementsBannerVisible = false;
      return;
    }
    const unread = unreadAnnouncementMessages(messages, state.roomReadState);
    const room = state.activeRoom;
    const readBoundary = state.roomReadState;
    const latest = identity.latestMessageForRead({ messages });
    if (!unread.length) {
      els.announcementsUnread.hidden = true;
      state.announcementsBannerVisible = false;
      return;
    }
    scheduler.scheduleTransientFrame(() => {
      if (!isActiveRoom(room) || state.roomReadState !== readBoundary
        || identity.latestMessageForRead(store.cacheFor(room))?.id !== latest?.id) return;
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
    popover.innerHTML = `
      <button class="chat-inline-profile-close" type="button" data-close-inline-profile aria-label="Close profile">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
      ${profiles.profileMarkup(profileUser, { showBlock: false, status: "offline" })}
    `;
    positionInlineProfilePopover(anchor, popover);
    inlineProfilePopover = popover;
    popover.querySelector("[data-close-inline-profile]")?.focus({ preventScroll: true });
  }

  function stickToBottom() {
    if (!els.messages) return;
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function messageStackElement() {
    if (!els.messages) return null;
    if (els.messages.querySelector(".chat-message-loader")) {
      els.messages.innerHTML = `<div class="chat-message-stack" ${GRAMMARLY_DISABLED_ATTRS}></div>`;
    }
    let stack = els.messages.querySelector(".chat-message-stack");
    if (!stack) {
      els.messages.innerHTML = `<div class="chat-message-stack" ${GRAMMARLY_DISABLED_ATTRS}></div>`;
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
    const unseen = [];
    for (const message of newMessages) {
      const id = String(message?.id || "");
      if (!id || renderedIds.has(id)) continue;
      renderedIds.add(id);
      unseen.push(message);
    }
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
    const isContinuation = el.classList.contains("chat-message-continuation");
    const contentHtml = renderMessageContent(message, { inlineDelivery: isContinuation });
    const content = el.querySelector(".chat-message-content");
    if (!content) return false;
    if (isContinuation) {
      content.innerHTML = contentHtml;
    } else {
      const head = content.querySelector(".chat-message-head");
      content.innerHTML = head ? head.outerHTML : "";
      content.insertAdjacentHTML("beforeend", contentHtml);
      const nextHead = content.querySelector(".chat-message-head");
      nextHead?.querySelector(".chat-delivery-state, .chat-message-retry")?.remove();
      nextHead?.insertAdjacentHTML("beforeend", renderDeliveryState(message));
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
      stack.innerHTML = `<div class="chat-empty" ${GRAMMARLY_DISABLED_ATTRS}>No messages yet.</div>`;
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

  function renderIncomingMessages(change, { toBottom = false, markRead = true } = {}) {
    if (!change) return;
    const { room, cache, messages, incoming } = change;
    if (!isActiveRoom(room)) return;
    const wasNearBottom = toBottom || view.isNearBottom();
    syncMessagesToDom(messages, {
      incremental: true,
      incoming,
      scrollToBottom: wasNearBottom,
    });
    if (wasNearBottom && markRead) readState.markRoomRead(room, cache);
    if (!wasNearBottom && incoming.length && els.newMessages) els.newMessages.hidden = false;
  }

  function renderRemovedMessage(messageId) {
    const cache = store.cacheFor(state.activeRoom);
    if (!cache) return;
    if (!removeMessageFromDom(messageId)) {
      renderMessages(cache.messages);
    } else {
      updateAnnouncementsUnreadBanner(cache.messages);
      updateHistoryBannerVisibility();
    }
  }

  function restoreDeletedMessages(removed) {
    const cache = store.restoreMessagesToCaches(removed);
    if (cache) renderMessages(cache.messages);
  }

  function renderApprovalNotice(channel) {
    feedback.setStatus(null);
    if (els.messages) {
      const denied = channel?.university_status === "denied";
      els.messages.innerHTML = `
        <div class="chat-empty chat-approval-state" ${GRAMMARLY_DISABLED_ATTRS}>
          <strong>${denied ? "University Channel Denied." : "Waiting Admin Approval."}</strong>
          <span>Email derek.chen@emory.edu for faster approval.</span>
        </div>
      `;
    }
    profiles.renderMembers([]);
  }

  function renderMessages(messages) {
    if (!els.messages) return;
    if (!messages || !messages.length) {
      els.messages.innerHTML = `<div class="chat-message-stack" ${GRAMMARLY_DISABLED_ATTRS}><div class="chat-empty" ${GRAMMARLY_DISABLED_ATTRS}>No messages yet.</div></div>`;
      updateAnnouncementsUnreadBanner([]);
      updateHistoryBannerVisibility();
      return;
    }
    els.messages.innerHTML = `
      <div class="chat-message-stack" ${GRAMMARLY_DISABLED_ATTRS}>
        ${renderMessageGroupsWithDays(groupMessages(messages))}
      </div>
    `;
    updateAnnouncementsUnreadBanner(messages);
    updateHistoryBannerVisibility();
  }

  function renderMessageGroupsWithDays(groups) {
    let previousDay = "";
    return groups.map((group) => {
      const date = parseMessageDate(group.messages?.[0]?.created_at);
      const day = localDateKey(date);
      const separator = day && day !== previousDay
        ? `<div class="chat-day-separator" role="separator"><span>${escapeHtml(date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }))}</span></div>`
        : "";
      previousDay = day;
      return `${separator}${renderMessageGroup(group)}`;
    }).join("");
  }

  function renderMessageGroup(group) {
    const [lead, ...continuations] = group.messages;
    return `
      <div class="chat-message-group" data-message-group="${escapeHtml(group.id)}" ${GRAMMARLY_DISABLED_ATTRS}>
        ${renderLeadMessage(lead)}
        ${continuations.map(renderContinuationMessage).join("")}
      </div>
    `;
  }

  function renderDeleteButton(message) {
    if (!message.can_delete) return "";
    return `
      <button class="chat-delete" type="button" data-delete-message="${escapeHtml(message.id)}" aria-label="Delete message" ${GRAMMARLY_DISABLED_ATTRS}>
        <span class="material-symbols-outlined" aria-hidden="true">delete</span>
      </button>
    `;
  }

  function renderDeliveryState(message) {
    if (message.delivery_state === "sending") return `<span class="chat-delivery-state">Sending…</span>`;
    if (message.delivery_state === "failed") return `<button class="chat-message-retry" type="button" data-retry-message="${escapeHtml(message.id)}">Not sent · Retry</button>`;
    return "";
  }

  function renderLeadMessage(message) {
    const deleteButton = message.can_delete
      ? renderDeleteButton(message)
      : "";
    return `
      <article class="chat-message" data-message-id="${escapeHtml(message.id)}" ${GRAMMARLY_DISABLED_ATTRS}>
        <button type="button" class="chat-message-avatar-button chat-author-button" data-author-message-id="${escapeHtml(message.id)}" aria-label="View ${escapeHtml(message.author_name || "author")} profile" ${GRAMMARLY_DISABLED_ATTRS}>
          <img class="chat-message-avatar" ${avatarAttrs(message.author_avatar_url, 84, "42px")} alt="">
        </button>
        <div class="chat-message-content" ${GRAMMARLY_DISABLED_ATTRS}>
          <div class="chat-message-head" ${GRAMMARLY_DISABLED_ATTRS}>
            <button type="button" class="chat-author-button" data-author-message-id="${escapeHtml(message.id)}" ${GRAMMARLY_DISABLED_ATTRS}>${escapeHtml(message.author_name || "Nest User")}</button>
            <span class="chat-message-time">${messageTimestampMarkup(message.created_at)}</span>
            ${renderDeliveryState(message)}
          </div>
          ${renderMessageContent(message)}
        </div>
        ${deleteButton}
      </article>
    `;
  }

  function renderContinuationMessage(message) {
    return `
      <article class="chat-message chat-message-continuation" data-message-id="${escapeHtml(message.id)}" ${GRAMMARLY_DISABLED_ATTRS}>
        <span class="chat-message-continuation-time">${messageTimestampMarkup(message.created_at)}</span>
        <div class="chat-message-content" ${GRAMMARLY_DISABLED_ATTRS}>
          ${renderMessageContent(message, { inlineDelivery: true })}
        </div>
        ${renderDeleteButton(message)}
      </article>
    `;
  }

  function renderMessageContent(message, { inlineDelivery = false } = {}) {
    return `
      <div class="chat-message-body" ${GRAMMARLY_DISABLED_ATTRS}>${messageBodyMarkup(message)}</div>
      ${inlineDelivery ? renderDeliveryState(message) : ""}
      ${renderImages(message.images || [])}
      ${extensions.messageMedia?.renderAttachments?.(message.attachments || []) || ""}
      ${extensions.messageMedia?.renderGif?.(message.gif) || ""}
      ${renderPreviews(message.previews || [])}
    `;
  }

  function renderImages(images) {
    if (!images.length) return "";
    return `
      <div class="chat-message-images" ${GRAMMARLY_DISABLED_ATTRS}>
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
        <div class="chat-preview" ${GRAMMARLY_DISABLED_ATTRS}>
          <a href="${escapeHtml(preview.url || "#")}" target="_blank" rel="noopener noreferrer nofollow">
            <span class="chat-preview-copy" ${GRAMMARLY_DISABLED_ATTRS}>
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
    const removed = store.removeMessageFromCaches(messageId);
    renderRemovedMessage(messageId);
    if (window.APStudyUndo?.stage) {
      window.APStudyUndo.stage({
        message: "Message deleted.",
        duration: 8_000,
        commit: ({ reason }) => {
          const keepalive = reason === "pagehide";
          // The confirmed Undo deletion outlives pane disposal on pagehide.
          // Other chat requests retain the lifecycle's cancellable signal.
          return fetchJson(`/api/chat/messages/${encodeURIComponent(messageId)}`, {
            method: "DELETE",
            keepalive,
            ...(keepalive ? { signal: new AbortController().signal } : {}),
          });
        },
        restore: () => restoreDeletedMessages(removed),
        errorTitle: "Couldn’t delete message",
      });
      return;
    }
    try {
      await fetchJson(`/api/chat/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
    } catch (error) {
      restoreDeletedMessages(removed);
      feedback.setStatus(error.message || "Unable to delete message.", "error");
    }
  }

  function bindPaneEvents() {
    els.messages?.addEventListener("scroll", () => {
      const cache = store.cacheFor(state.activeRoom);
      store.saveRoomScroll(state.activeRoom, els.messages.scrollTop, { persist: false });
      updateHistoryBannerVisibility();
      window.clearTimeout(state.scrollSaveTimer);
      state.scrollSaveTimer = window.setTimeout(() => {
        store.schedulePersistentRoomSave(state.activeRoom);
      }, 350);
      if (els.messages.scrollTop <= 16 && cache?.hasMore && cache.oldestCursor && !state.loadingMessages) {
        void loading.loadMessages({ before: cache.oldestCursor, before_message_id: cache.oldestMessageId, preserveScroll: true, quiet: true }).catch(() => {});
      }
      closeInlineProfilePopover();
      if (view.isNearBottom() && els.newMessages) els.newMessages.hidden = true;
    });
    els.messages?.addEventListener("click", (event) => {
      const authorButton = event.target.closest("[data-author-message-id]");
      if (authorButton) {
        event.preventDefault();
        const messageId = authorButton.dataset.authorMessageId;
        const cache = store.cacheFor(state.activeRoom);
        const message = cache?.messages?.find((candidate) => candidate.id === messageId);
        if (message) openInlineProfileForMessage(message, authorButton);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-message]");
      if (deleteButton) void deleteMessage(deleteButton.dataset.deleteMessage);
      const retryButton = event.target.closest("[data-retry-message]");
      if (retryButton) void composer.retryMessage(retryButton.dataset.retryMessage);
    });
    els.newMessages?.addEventListener("click", () => {
      els.messages?.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
      els.newMessages.hidden = true;
    });
    els.memberList?.addEventListener("click", (event) => {
      const profileButton = event.target.closest("[data-profile-id]");
      if (!profileButton) return;
      const channel = rooms.activeChannel();
      const user = (channel?.online_users || channel?.active_users || []).find((candidate) => candidate.id === profileButton.dataset.profileId);
      if (user) {
        profiles.showMemberProfile(user);
      }
    });
    els.profileBack?.addEventListener("click", () => {
      const profileId = state.activeProfile?.id;
      state.activeProfile = null;
      const channel = rooms.activeChannel();
      profiles.renderMembers(channel?.online_users || channel?.active_users || []);
      if (!profileId) return;
      window.requestAnimationFrame(() => {
        els.memberList?.querySelector(`[data-profile-id="${CSS.escape(profileId)}"]`)?.focus({ preventScroll: true });
      });
    });
    els.profilePanel?.addEventListener("click", (event) => {
      const blockButton = event.target.closest("[data-block-user]");
      if (!blockButton) return;
      void rooms.toggleBlock(blockButton.dataset.blockUser, blockButton.dataset.blocked === "true");
    });
    els.announcementsRead?.addEventListener("click", () => {
      void markAnnouncementsRead();
    });
  }

  function bindDocumentEvents() {
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-inline-profile]")) {
        closeInlineProfilePopover();
        return;
      }
      const menu = document.getElementById("chat-room-context-menu");
      if (menu && !menu.hidden && !menu.contains(event.target)) rooms.closeRoomContextMenu();
      if (inlineProfilePopover && !event.target.closest(".chat-inline-profile-popover") && !event.target.closest(".chat-author-button")) {
        closeInlineProfilePopover();
      }
    });
  }

  return {
    renderIncomingMessages,
    renderRemovedMessage,
    bindDocumentEvents,
    bindPaneEvents,
    closeInlineProfilePopover,
    patchMessageInDom,
    removeMessageFromDom,
    renderApprovalNotice,
    renderMessageLoader,
    renderMessages,
    setHistoryBanner,
    stickToBottom,
    syncMessagesToDom,
    unreadAnnouncementMessages,
    updateAnnouncementsUnreadBanner,
    updateHistoryBannerVisibility,
  };
}
