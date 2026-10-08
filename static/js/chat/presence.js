import { normalizeLocalPresenceStatus } from "./presentation.js";

export function createChatPresence({ state, els, config, lifecycle, fetchJson, identity, onUpdate }) {
  const {
    PRESENCE_REFRESH_MS,
    TYPING_PRESENCE_TTL_MS,
    PRESENCE_TAB_ID_KEY,
  } = config;

  function currentTabId() {
    if (window.APStudyPresenceHeartbeat?.tabId) return window.APStudyPresenceHeartbeat.tabId;
    if (state.tabId) return state.tabId;
    try {
      state.tabId = sessionStorage.getItem(PRESENCE_TAB_ID_KEY);
      if (!state.tabId) {
        state.tabId = window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
        state.tabId = state.tabId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
        sessionStorage.setItem(PRESENCE_TAB_ID_KEY, state.tabId);
      }
    } catch {
      state.tabId = state.tabId || Math.random().toString(36).slice(2, 12);
    }
    return state.tabId;
  }

  function rememberPresenceUser(user) {
    if (!user?.id) return;
    const normalized = {
      ...user,
      id: String(user.id),
      presence_status: normalizeLocalPresenceStatus(user.presence_status),
      active_chat_scopes: Array.isArray(user.active_chat_scopes) ? user.active_chat_scopes.map(String) : [],
      typing_channel_ids: Array.isArray(user.typing_channel_ids) ? user.typing_channel_ids.map(String) : [],
      typing_thread_ids: Array.isArray(user.typing_thread_ids) ? user.typing_thread_ids.map(String) : [],
    };
    state.presenceRecords.set(normalized.id, normalized);
  }

  function updatePresenceStatus(userId, status) {
    const id = String(userId || "");
    if (!id) return;
    const normalizedStatus = normalizeLocalPresenceStatus(status);
    const existing = state.presenceRecords.get(id) || state.knownUsers.get(id) || { id };
    rememberPresenceUser({
      ...existing,
      id,
      presence_status: normalizedStatus,
      online: normalizedStatus !== "offline",
    });
  }

  function typingUsersForActiveRoom() {
    const room = state.activeRoom;
    if (!room?.id) return [];
    const field = room.type === "channel" ? "typing_channel_ids" : "typing_thread_ids";
    return Array.from(state.presenceRecords.values())
      .filter((user) => user.id !== identity.currentUserId())
      .filter((user) => (user[field] || []).includes(String(room.id)))
      .map((user) => state.knownUsers.get(user.id) || user);
  }

  function removePresenceScope(field, scopeId) {
    const id = String(scopeId || "");
    if (!id) return;
    for (const user of state.presenceRecords.values()) {
      if (!Array.isArray(user[field])) continue;
      user[field] = user[field].filter((value) => String(value) !== id);
    }
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

  async function loadInitialPresences() {
    try {
      const payload = await fetchJson("/api/presence/online");
      state.presenceRecords.clear();
      for (const user of payload.users || []) rememberPresenceUser(user);
      onUpdate();
    } catch (error) {
      console.warn("Unable to load presence", error);
      onUpdate();
    }
  }

  function visiblePresenceUserIds() {
    const ids = [];
    const add = (value) => {
      const id = String(value || "");
      if (id && id !== identity.currentUserId() && !ids.includes(id)) ids.push(id);
    };
    for (const thread of state.threads || []) {
      add(thread.other_user?.id);
    }
    add(state.activeProfile?.id);
    const thread = state.activeRoom?.type === "thread" ? state.threads.find((candidate) => candidate.id === state.activeRoom.id) : null;
    add(thread?.other_user?.id);
    return ids.slice(0, 200);
  }

  async function refreshPresenceStatuses() {
    const userIds = visiblePresenceUserIds();
    if (!userIds.length) return;
    try {
      const payload = await fetchJson("/api/presence/statuses", {
        method: "POST",
        body: JSON.stringify({ user_ids: userIds }),
      });
      for (const [userId, status] of Object.entries(payload.statuses || {})) {
        updatePresenceStatus(userId, status);
      }
    } catch (error) {
      console.warn("Unable to refresh presence statuses", error);
    }
  }

  async function refreshActiveRoomPresence() {
    const room = state.activeRoom;
    if (!room?.id || !["channel", "thread"].includes(room.type)) return;
    try {
      const payload = await fetchJson("/api/presence/room", {
        method: "POST",
        body: JSON.stringify({ scope_type: room.type, scope_id: room.id }),
      });
      if (!state.activeRoom || identity.roomKey(state.activeRoom) !== identity.roomKey(room)) return;
      const typingField = room.type === "channel" ? "typing_channel_ids" : "typing_thread_ids";
      removePresenceScope("active_chat_scopes", room.id);
      removePresenceScope(typingField, room.id);
      const roomUsers = payload.online_users || payload.active_users || [];
      for (const user of roomUsers) {
        const status = normalizeLocalPresenceStatus(user.presence_status || "active");
        rememberPresenceUser({
          ...user,
          presence_status: status,
          online: status !== "offline",
          active_chat_scopes: status === "active" ? [String(room.id)] : [],
        });
      }
      for (const user of payload.typing_users || []) {
        rememberPresenceUser({
          ...user,
          [typingField]: [String(room.id)],
        });
      }
      return { room, users: roomUsers };
    } catch (error) {
      console.warn("Unable to refresh room presence", error);
    }
  }

  function syncActiveRoomHeartbeat() {
    const coordinator = window.APStudyPresenceHeartbeat;
    if (!coordinator?.setChatRoom) return;
    coordinator.setChatRoom(state.activeRoom?.id || null);
  }

  async function refreshTargetedPresences() {
    syncActiveRoomHeartbeat();
    const [, update] = await Promise.all([refreshPresenceStatuses(), refreshActiveRoomPresence()]);
    onUpdate(update);
  }

  function heartbeatPayload(kind, room = state.activeRoom) {
    if (kind === "typing") {
      if (!room?.id || !["channel", "thread"].includes(room.type)) return null;
      return {
        scope_type: room.type === "channel" ? "typing_channel" : "typing_thread",
        scope_id: room.id,
        tab_id: currentTabId(),
      };
    }
    return null;
  }

  async function sendPresenceHeartbeat(kind, room = state.activeRoom) {
    if (kind === "viewing") {
      syncActiveRoomHeartbeat();
      return null;
    }
    const payload = heartbeatPayload(kind, room);
    if (!payload) return null;
    try {
      await fetchJson("/api/presence/heartbeat", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return `${payload.scope_type}:${payload.scope_id}`;
    } catch (error) {
      console.warn("Unable to update chat presence", error);
      return null;
    }
  }

  function clearTypingPresence() {
    window.clearTimeout(state.typingInputTimer);
    window.clearTimeout(state.typingClearTimer);
    state.typingInputTimer = null;
    state.typingClearTimer = null;
  }

  function refreshViewingPresence() {
    void refreshTargetedPresences();
  }

  function handleActiveRoomPresenceChange(previousRoom) {
    if (previousRoom && identity.roomKey(previousRoom) !== identity.roomKey(state.activeRoom)) {
      clearTypingPresence();
    }
    refreshViewingPresence();
  }

  function scheduleTypingPresence() {
    const channel = state.activeRoom?.type === "channel" ? state.channels.find((candidate) => candidate.id === state.activeRoom.id) : null;
    const thread = state.activeRoom?.type === "thread" ? state.threads.find((candidate) => candidate.id === state.activeRoom.id) : null;
    if (!els.input || !els.input.value.trim()) {
      clearTypingPresence();
      return;
    }
    if ((channel && (channel.read_only || channel.approved === false)) || thread?.blocked) return;
    window.clearTimeout(state.typingInputTimer);
    state.typingInputTimer = window.setTimeout(() => {
      void sendPresenceHeartbeat("typing");
      window.clearTimeout(state.typingClearTimer);
      state.typingClearTimer = window.setTimeout(() => clearTypingPresence(), TYPING_PRESENCE_TTL_MS + 400);
    }, 150);
  }

  function startPresenceRefreshTimer() {
    if (lifecycle.paused || lifecycle.disposed) return;
    window.clearInterval(state.presenceRefreshTimer);
    refreshViewingPresence();
    state.presenceRefreshTimer = window.setInterval(refreshViewingPresence, PRESENCE_REFRESH_MS);
  }

  function stopPresenceRefreshTimer() {
    window.clearInterval(state.presenceRefreshTimer);
    state.presenceRefreshTimer = null;
  }

  return {
    clearTypingPresence,
    handleActiveRoomPresenceChange,
    loadInitialPresences,
    refreshViewingPresence,
    renderTypingIndicator,
    scheduleTypingPresence,
    startPresenceRefreshTimer,
    stopPresenceRefreshTimer,
  };
}
