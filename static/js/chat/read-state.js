export function createChatReadState({ state, els, config, fetchJson, feedback, identity, store, view, getSelectionRevision, onChange }) {
  const { ANNOUNCEMENTS_CHANNEL_ID } = config;
  let unreadSummaryRefreshTimer = null;

  function unreadKey(type, id) {
    return identity.roomKey({ type, id });
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
      const key = unreadKey(unread.type, unread.id);
      if (state.clearedReadRooms.has(key) && unread.has_unread) {
        continue;
      }
      if (!unread.has_unread) {
        state.clearedReadRooms.delete(key);
      }
      nextUnread.set(key, unread);
    }
    for (const key of state.clearedReadRooms) {
      if (nextUnread.has(key)) continue;
      const [type, id] = key.split(":");
      if (!type || !id) continue;
      nextUnread.set(key, {
        type,
        id,
        unread_count: 0,
        has_unread: false,
      });
    }
    state.roomUnread = nextUnread;
    onChange();
    const reconciledPayload = chatSummaryPayloadFromUnreadMap(payload);
    window.dispatchEvent(new CustomEvent("apstudy-chat-summary", { detail: reconciledPayload }));
    return reconciledPayload;
  }

  function chatSummaryPayloadFromUnreadMap(payload = {}) {
    const rooms = Array.from(state.roomUnread.values()).map((room) => ({
      type: room.type,
      id: room.id,
      unread_count: Math.max(0, Number(room.unread_count || 0)),
      has_unread: room.has_unread === true && Number(room.unread_count || 0) > 0,
    }));
    const totalUnread = rooms.reduce((total, room) => total + Number(room.unread_count || 0), 0);
    return {
      ...payload,
      rooms,
      total_unread: Math.min(totalUnread, 99),
      unread_capped: totalUnread >= 99 || rooms.some((room) => Number(room.unread_count || 0) >= 99),
      has_unread: totalUnread > 0,
    };
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
        return null;
      }
      return applyChatSummary(payload);
    } catch {
      return null;
    } finally {
      state.chatSummaryLoading = false;
    }
  }

  function unreadForRoom(type, id) {
    return state.roomUnread.get(unreadKey(type, id)) || { unread_count: 0, has_unread: false };
  }

  function setRoomUnread(room, unread = {}) {
    const key = identity.roomKey(room);
    if (!key) return;
    const count = Math.max(0, Number(unread.unread_count || 0));
    state.roomUnread.set(key, {
      type: room.type,
      id: room.id,
      unread_count: Math.min(count, 99),
      has_unread: unread.has_unread === true || count > 0,
    });
    onChange();
  }

  function clearRoomUnread(room) {
    const key = identity.roomKey(room);
    if (!key) return;
    state.localReadSeq += 1;
    state.clearedReadRooms.add(key);
    state.roomUnread.set(key, {
      type: room.type,
      id: room.id,
      unread_count: 0,
      has_unread: false,
    });
    onChange();
  }

  function shouldAutoMarkRoomRead(room, cache = store.cacheFor(room)) {
    if (room?.type === "channel" && room.id === ANNOUNCEMENTS_CHANNEL_ID) {
      return view.unreadAnnouncementMessages(cache?.messages, state.roomReadState).length === 0;
    }
    return true;
  }

  function markRoomRead(room, cache = store.cacheFor(room), { force = false, announcements = false } = {}) {
    if (!room?.type || !room?.id) return;
    if (!force && document.visibilityState === "hidden") return;
    if (!force && !announcements && !shouldAutoMarkRoomRead(room, cache)) return;
    const latest = identity.latestMessageForRead(cache);
    const latestId = latest?.id;
    const latestCreatedAt = latest?.created_at;
    const key = identity.roomKey(room);
    const unreadBoundary = state.roomUnread.get(key);
    const readBoundary = state.roomReadState;
    const selectionRevision = getSelectionRevision();
    const wasActive = identity.roomKey(state.activeRoom) === key;
    const boundaryIsCurrent = () => {
      const currentLatest = identity.latestMessageForRead(store.cacheFor(room));
      return currentLatest?.id === latestId
        && currentLatest?.created_at === latestCreatedAt
        && state.roomUnread.get(key) === unreadBoundary
        && (!wasActive || state.roomReadState === readBoundary)
        && (!wasActive || (identity.roomKey(state.activeRoom) === key && getSelectionRevision() === selectionRevision));
    };
    const body = {
      scope_type: room.type === "channel" ? "channel" : "thread",
      scope_id: room.id,
    };
    if (latestId) body.message_id = latestId;
    return fetchJson("/api/chat/read", {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((payload) => {
        if (!boundaryIsCurrent()) return null;
        clearRoomUnread(room);
        if (force) cancelUnreadSummaryRefresh();
        if (
          (force || announcements)
          && room.type === "channel"
          && room.id === ANNOUNCEMENTS_CHANNEL_ID
          && state.activeRoom?.type === "channel"
          && state.activeRoom.id === ANNOUNCEMENTS_CHANNEL_ID
        ) {
          state.roomReadState = {
            last_read_at: latestCreatedAt || payload?.read_state?.last_read_at || state.roomReadState?.last_read_at || null,
            last_read_message_id: latestId || payload?.read_state?.last_read_message_id || state.roomReadState?.last_read_message_id || null,
          };
          state.announcementsBannerVisible = false;
          if (els.announcementsUnread) els.announcementsUnread.hidden = true;
        }
        state.localReadSeq += 1;
        window.dispatchEvent(new CustomEvent("apstudy-chat-read-state-change", { detail: { room } }));
        return refreshChatSummary();
      })
      .catch((error) => {
        if (announcements && boundaryIsCurrent()) feedback.setStatus(error.message || "Unable to mark announcements read.", "error");
        return null;
      });
  }

  function scheduleUnreadSummaryRefresh() {
    if (unreadSummaryRefreshTimer) return;
    unreadSummaryRefreshTimer = window.setTimeout(() => {
      unreadSummaryRefreshTimer = null;
      void refreshChatSummary();
    }, 400);
  }

  function cancelUnreadSummaryRefresh() {
    if (!unreadSummaryRefreshTimer) return;
    window.clearTimeout(unreadSummaryRefreshTimer);
    unreadSummaryRefreshTimer = null;
  }

  return { unreadForRoom, setRoomUnread, clearRoomUnread, markRoomRead, refreshChatSummary, scheduleUnreadSummaryRefresh, cancelUnreadSummaryRefresh };
}
