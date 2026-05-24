(function () {
  const root = document.querySelector(".chat-app");
  if (!root) return;

  const DEFAULT_AVATAR = "https://resources.apstudy.org/images/AP-Resources-Logo.png";
  const PRESENCE_INTERVAL_MS = 30000;
  const ROOM_SCROLL_RESTORE_DELAY = 0;

  const state = {
    user: null,
    settings: { chat_sound_enabled: true },
    channels: [],
    threads: [],
    university: null,
    activeRoom: null,
    activeProfile: null,
    roomCache: new Map(),
    presenceTimer: null,
    searchTimer: null,
    realtimeUnsubscribe: null,
    realtimeReady: false,
    loadingMessages: false,
    membersCollapsed: sessionStorage.getItem("apstudy-chat-members-collapsed") === "true",
  };

  window.NestChat = state;

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
    joinDiscord: document.getElementById("chat-join-discord"),
    messages: document.getElementById("chat-messages"),
    composer: document.getElementById("chat-composer"),
    input: document.getElementById("chat-message-input"),
    sendButton: document.querySelector(".chat-send-button"),
    members: document.getElementById("chat-members"),
    memberList: document.getElementById("chat-member-list"),
    membersCount: document.getElementById("chat-members-count"),
    membersRestoreCount: document.getElementById("chat-members-restore-count"),
    profilePanel: document.getElementById("chat-profile-panel"),
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

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function plural(value, singular, pluralLabel) {
    const number = Number(value) || 0;
    return `${number} ${number === 1 ? singular : pluralLabel}`;
  }

  function roomKey(room) {
    if (!room || !room.id || !room.type) return "";
    return `${room.type}:${room.id}`;
  }

  function cacheFor(room) {
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

  function updateCacheCursors(cache) {
    if (!cache || !cache.messages.length) {
      cache.oldestCursor = null;
      cache.latestCursor = null;
      return;
    }
    cache.messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    cache.oldestCursor = cache.messages[0].created_at || null;
    cache.latestCursor = cache.messages[cache.messages.length - 1].created_at || null;
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
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Something went wrong.");
    }
    return payload;
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

  function playChatSound(actorId) {
    if (!state.settings.chat_sound_enabled || !els.audio) return;
    if (actorId && state.user && String(actorId) === String(state.user.id)) return;
    try {
      els.audio.currentTime = 0;
      void els.audio.play();
    } catch (_) {
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

  function roomButton({ type, id, active, leading, title, meta, className = "" }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-list-button ${className} ${active ? "is-active" : ""}`.trim();
    button.dataset.roomType = type;
    button.dataset.roomId = id;
    button.innerHTML = `
      ${leading}
      <span class="chat-list-copy">
        <span class="chat-list-title">${escapeHtml(title)}</span>
        ${meta || ""}
      </span>
    `;
    button.addEventListener("click", () => selectRoom({ type, id }));
    return button;
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
        <span class="chat-presence-dot is-${status}" aria-hidden="true"></span>
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
          <img class="chat-avatar-mini" src="${escapeHtml(avatarUrl(other.picture_url, 48))}" alt="">
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
    const shouldShow = Boolean(channel?.history_limited);
    els.historyLimited.hidden = !shouldShow;
    if (els.joinDiscord) {
      const invite = root.dataset.discordInviteUrl || "";
      els.joinDiscord.hidden = !invite;
      if (invite) els.joinDiscord.href = invite;
    }
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
      els.roomSymbol.innerHTML = `<img src="${escapeHtml(avatarUrl(other.picture_url, 48))}" alt="">`;
      els.roomName.textContent = other.name || other.username || "Nest User";
      els.roomMeta.textContent = dmPresenceStatus(thread) === "online" ? "Online" : "Offline";
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
      els.messages.innerHTML = `<div class="chat-empty">No messages yet.</div>`;
      return;
    }
    els.messages.innerHTML = messages.map(renderMessage).join("");
  }

  function renderMessage(message) {
    const deleteButton = message.can_delete
      ? `<button class="chat-delete" type="button" data-delete-message="${escapeHtml(message.id)}" aria-label="Delete message">
          <span class="material-symbols-outlined">delete</span>
        </button>`
      : "";
    return `
      <article class="chat-message" data-message-id="${escapeHtml(message.id)}">
        <img class="chat-message-avatar" src="${escapeHtml(avatarUrl(message.author_avatar_url, 84))}" alt="">
        <div class="chat-message-content">
          <div class="chat-message-head">
            <span class="chat-message-author">${escapeHtml(message.author_name || "Nest User")}</span>
            <span class="chat-message-time">${escapeHtml(formatTime(message.created_at))}</span>
          </div>
          <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
          ${renderPreviews(message.previews || [])}
        </div>
        ${deleteButton}
      </article>
    `;
  }

  function renderPreviews(previews) {
    if (!previews.length) return "";
    return previews.map((preview) => {
      const image = preview.image_url
        ? `<img src="${escapeHtml(preview.image_url)}" alt="" loading="lazy">`
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
        <img src="${escapeHtml(avatarUrl(user.picture_url, 72))}" alt="">
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

  function profileMarkup(user, options = {}) {
    const status = options.status || (user?.online ? "online" : "offline");
    const schoolLine = [user?.school, user?.major, user?.graduation_year].filter(Boolean).join(" · ");
    const blockLabel = options.blocked ? "Unblock" : "Block";
    const blockAction = options.showBlock
      ? `<button type="button" data-block-user="${escapeHtml(user.id)}" data-blocked="${options.blocked ? "true" : "false"}">${blockLabel}</button>`
      : "";
    return `
      <div class="chat-profile-card">
        <img src="${escapeHtml(avatarUrl(user?.picture_url, 128))}" alt="">
        <div>
          <h3>${escapeHtml(user?.name || user?.username || "Nest User")}</h3>
          ${user?.username ? `<p>@${escapeHtml(user.username)}</p>` : ""}
          <p class="chat-presence-line chat-profile-presence">
            <span class="chat-presence-dot is-${status}" aria-hidden="true"></span>
            <span>${status === "online" ? "Online" : "Offline"}</span>
          </p>
          ${schoolLine ? `<p>${escapeHtml(schoolLine)}</p>` : ""}
        </div>
      </div>
      <div class="chat-profile-actions">
        ${user?.profile_url ? `<a href="${escapeHtml(user.profile_url)}">View profile</a>` : ""}
        ${blockAction}
      </div>
    `;
  }

  function updateCurrentMembersFromPayload(payload) {
    if (payload.channel && state.activeRoom?.type === "channel" && state.activeRoom.id === payload.channel.id) {
      renderMembers(payload.channel.active_users || []);
    }
    if (payload.thread && state.activeRoom?.type === "thread" && state.activeRoom.id === payload.thread.id) {
      renderDmProfile(payload.thread);
    }
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
    const index = state.threads.findIndex((thread) => thread.id === payload.id);
    if (index >= 0) {
      state.threads[index] = { ...state.threads[index], ...payload };
    } else {
      state.threads.unshift(payload);
    }
    state.threads.sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
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

  async function loadMessages({ before = null, after = null, force = false, preserveScroll = false, quiet = false } = {}) {
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
    state.loadingMessages = true;
    if (!quiet && !before && !after) setStatus("Loading messages...");

    try {
      const payload = await fetchJson(currentRoomUrl(room, { before, after }));
      if (!state.activeRoom || roomKey(state.activeRoom) !== roomKey(room)) return [];

      if (payload.channel) updateChannel(payload.channel);
      if (payload.thread) updateThread(payload.thread);

      const messages = payload.messages || [];
      if (after || before) {
        cache.messages = mergeMessages(cache.messages, messages);
      } else {
        cache.messages = mergeMessages([], messages);
      }
      cache.loaded = true;
      cache.stale = false;
      cache.hasMore = Boolean(payload.has_more);
      updateCacheCursors(cache);
      renderHeader();
      updateRoomLists();
      renderMessages(cache.messages);
      updateCurrentMembersFromPayload(payload);
      setStatus(null);

      if (before) {
        const delta = els.messages.scrollHeight - previousHeight;
        els.messages.scrollTop = previousTop + delta;
      } else if (after) {
        if (wasNearBottom) restoreScroll(cache, true);
      } else {
        restoreScroll(cache, !preserveScroll);
      }
      return messages;
    } catch (error) {
      setStatus(error.message || "Unable to load messages.", "error");
      return [];
    } finally {
      state.loadingMessages = false;
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
    for (const cache of state.roomCache.values()) {
      cache.messages = cache.messages.filter((message) => message.id !== messageId);
      updateCacheCursors(cache);
    }
    const activeCache = cacheFor(state.activeRoom);
    if (activeCache) renderMessages(activeCache.messages);
  }

  async function selectRoom(room) {
    saveActiveScroll();
    state.activeRoom = room;
    state.activeProfile = null;
    updateRoomLists();
    renderHeader();
    setStatus(null);

    const channel = activeChannel();
    const thread = activeThread();
    if (channelIsPending(channel)) {
      renderApprovalNotice(channel);
      sendPresence();
      return;
    }

    if (thread) {
      renderDmProfile(thread);
    } else {
      renderMembers(channel?.active_users || []);
    }

    const cache = cacheFor(room);
    if (renderCachedRoom(room)) {
      if (cache.stale && cache.latestCursor) {
        await loadMessages({ after: cache.latestCursor, quiet: true });
      }
    } else {
      await loadMessages({ force: true });
    }
    sendPresence();
  }

  async function bootstrap({ preserveActive = false } = {}) {
    const activeKey = roomKey(state.activeRoom);
    const payload = await fetchJson("/api/chat/bootstrap");
    state.user = payload.user || state.user;
    state.settings = { ...state.settings, ...(payload.settings || {}) };
    state.channels = payload.sections?.nest || [];
    state.threads = payload.sections?.direct_messages || [];
    state.university = payload.university || null;
    if (payload.discord_invite_url) root.dataset.discordInviteUrl = payload.discord_invite_url;
    updateRoomLists();
    initializeRealtime();
    setMembersCollapsed(state.membersCollapsed);

    if (preserveActive && activeKey) {
      const [type, id] = activeKey.split(":");
      const stillExists = type === "channel"
        ? state.channels.some((channel) => channel.id === id)
        : state.threads.some((thread) => thread.id === id);
      if (stillExists) {
        await selectRoom({ type, id });
        return;
      }
    }

    if (!state.activeRoom) {
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
    }
  }

  function realtimeChannelName() {
    const databaseId = root.dataset.appwriteDatabaseId || "";
    const tableId = root.dataset.chatEventsTableId || "chat_events";
    const Channel = window.Appwrite && window.Appwrite.Channel;
    if (Channel?.tablesdb) return Channel.tablesdb(databaseId).table(tableId).row();
    if (Channel?.tablesDB) return Channel.tablesDB(databaseId).table(tableId).row();
    return `tablesdb.${databaseId}.tables.${tableId}.rows`;
  }

  function initializeRealtime() {
    if (state.realtimeReady || state.realtimeUnsubscribe) return;
    if (!root.dataset.appwriteDatabaseId || !root.dataset.chatEventsTableId) return;
    if (!window.Appwrite || !window.client) return;

    const channel = realtimeChannelName();
    try {
      let unsubscribe = null;
      if (window.Appwrite.Realtime) {
        const realtime = new window.Appwrite.Realtime(window.client);
        unsubscribe = realtime.subscribe(channel, handleRealtimePayload);
      } else if (typeof window.client.subscribe === "function") {
        unsubscribe = window.client.subscribe(channel, handleRealtimePayload);
      }
      if (typeof unsubscribe === "function") {
        state.realtimeUnsubscribe = unsubscribe;
        state.realtimeReady = true;
      }
    } catch (error) {
      console.warn("Chat realtime unavailable", error);
    }
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
    const event = response?.payload || response?.row || response;
    if (!eventIsRelevant(event)) return;
    const active = state.activeRoom;
    const eventRoom = event.scope_type === "channel"
      ? { type: "channel", id: event.scope_id || event.channel_id }
      : event.scope_type === "thread"
        ? { type: "thread", id: event.scope_id || event.thread_id }
        : null;

    if (event.event_type === "message_deleted") {
      removeMessageFromCaches(event.message_id);
      return;
    }

    if (event.event_type === "message_created") {
      if (eventRoom && active && roomKey(eventRoom) === roomKey(active)) {
        const cache = cacheFor(active);
        const incoming = cache?.latestCursor
          ? await loadMessages({ after: cache.latestCursor, quiet: true })
          : await loadMessages({ force: true, quiet: true });
        if (incoming.length) playChatSound(event.actor_id);
      } else if (eventRoom) {
        markRoomStale(eventRoom);
        playChatSound(event.actor_id);
      }
      return;
    }

    if (["thread_updated", "block_updated", "university_approved", "university_denied"].includes(event.event_type)) {
      if (eventRoom) markRoomStale(eventRoom);
      await bootstrap({ preserveActive: true });
    }
  }

  async function sendPresence() {
    const room = state.activeRoom;
    if (!room) return;
    try {
      const payload = await fetchJson("/api/chat/presence", {
        method: "POST",
        body: JSON.stringify({ scope_type: room.type, scope_id: room.id }),
      });
      updateDmPresenceStatuses(payload.dm_statuses || {});
      if (room.type === "channel") {
        const channel = activeChannel();
        if (channel) {
          channel.active_users = payload.users || [];
          channel.active_count = channel.active_users.length;
          renderHeader();
          renderChannels();
          renderMembers(channel.active_users);
        }
      }
    } catch (_) {
      // Presence is opportunistic; the message view should keep working.
    }
  }

  function updateDmPresenceStatuses(statuses) {
    if (!statuses || typeof statuses !== "object") return;
    let changed = false;
    for (const thread of state.threads) {
      const other = thread.other_user || {};
      if (!other.id || !statuses[other.id]) continue;
      const nextStatus = statuses[other.id] === "online" ? "online" : "offline";
      if (thread.presence_status !== nextStatus || Boolean(other.online) !== (nextStatus === "online")) {
        thread.presence_status = nextStatus;
        other.online = nextStatus === "online";
        changed = true;
      }
    }
    if (changed) {
      renderThreads();
      if (state.activeRoom?.type === "thread") {
        const thread = activeThread();
        renderHeader();
        renderDmProfile(thread);
      }
    }
  }

  function startPresenceTimer() {
    window.clearInterval(state.presenceTimer);
    state.presenceTimer = window.setInterval(sendPresence, PRESENCE_INTERVAL_MS);
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
      }
      await sendPresence();
    } catch (error) {
      setStatus(error.message || "Unable to send message.", "error");
    } finally {
      const writable = channel ? channelIsWritable(channel) : !activeThread()?.blocked;
      els.sendButton.disabled = !writable;
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
            <img src="${escapeHtml(avatarUrl(user.picture_url, 72))}" alt="">
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
      renderThreads();
      els.dmSearch.hidden = true;
      els.dmSearchInput.value = "";
      els.dmResults.innerHTML = "";
      await selectRoom({ type: "thread", id: payload.thread.id });
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
      }
    } catch (error) {
      setStatus(error.message || "Unable to update block.", "error");
    }
  }

  function setMembersCollapsed(collapsed) {
    state.membersCollapsed = Boolean(collapsed);
    sessionStorage.setItem("apstudy-chat-members-collapsed", String(state.membersCollapsed));
    root.classList.toggle("members-collapsed", state.membersCollapsed);
  }

  function bindEvents() {
    els.composer?.addEventListener("submit", sendActiveMessage);
    els.input?.addEventListener("input", autosizeComposer);
    els.messages?.addEventListener("scroll", () => {
      const cache = cacheFor(state.activeRoom);
      if (cache) cache.scrollTop = els.messages.scrollTop;
      if (els.messages.scrollTop <= 16 && cache?.hasMore && cache.oldestCursor && !state.loadingMessages) {
        void loadMessages({ before: cache.oldestCursor, preserveScroll: true, quiet: true });
      }
    });
    els.messages?.addEventListener("click", (event) => {
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
    document.querySelector("[data-collapse-members]")?.addEventListener("click", () => setMembersCollapsed(true));
    document.querySelector("[data-restore-members]")?.addEventListener("click", () => setMembersCollapsed(false));
    document.querySelector("[data-open-rail]")?.addEventListener("click", () => document.getElementById("chat-rail")?.classList.add("is-open"));
    document.querySelector("[data-close-rail]")?.addEventListener("click", () => document.getElementById("chat-rail")?.classList.remove("is-open"));
    document.querySelector("[data-open-members]")?.addEventListener("click", () => els.members?.classList.add("is-open"));
    document.querySelector("[data-close-members]")?.addEventListener("click", () => els.members?.classList.remove("is-open"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const cache = cacheFor(state.activeRoom);
        if (cache?.loaded && cache.latestCursor) {
          void loadMessages({ after: cache.latestCursor, quiet: true });
        }
        void sendPresence();
      }
    });
    window.addEventListener("beforeunload", () => {
      if (state.realtimeUnsubscribe) state.realtimeUnsubscribe();
    });
  }

  bindEvents();
  startPresenceTimer();
  bootstrap().catch((error) => {
    setStatus(error.message || "Unable to load chat.", "error");
  });
})();
