import {
  PRESENCE_APP_ID,
  TYPING_PRESENCE_TTL_MS,
  VIEWING_PRESENCE_REFRESH_MS,
  VIEWING_PRESENCE_TTL_MS,
  els,
  root,
  state,
} from "./context.js";
import {
  compactHash,
  currentTabId,
  currentUserId,
  roomKey,
  roomPresencePermissions,
  roomPresenceScope,
} from "./utils.js";
import {
  cacheFor,
  incrementRoomUnread,
  refreshChatSummary,
} from "./cache.js";
import {
  activeChannel,
  activeThread,
  channelIsWritable,
  playChatSound,
  startRealtimeFallback,
  stopRealtimeFallback,
  threadExists,
} from "./render-ui.js";
import {
  applyPresenceRecord,
  fetchThread,
  presenceAction,
  renderPresenceDrivenUi,
} from "./presence.js";
import {
  bootstrap,
  loadMessages,
  markRoomStale,
  removeMessageFromCaches,
} from "./load.js";

export function realtimeChannelName() {
  const databaseId = root.dataset.appwriteDatabaseId || "";
  const tableId = root.dataset.chatEventsTableId || "chat_events";
  const Channel = window.Channel || (window.Appwrite && window.Appwrite.Channel);
  if (Channel?.tablesdb) return Channel.tablesdb(databaseId).table(tableId).row();
  if (Channel?.tablesDB) return Channel.tablesDB(databaseId).table(tableId).row();
  return `tablesdb.${databaseId}.tables.${tableId}.rows`;
}

export function presenceChannelName() {
  const Channel = window.Channel || (window.Appwrite && window.Appwrite.Channel);
  if (Channel?.presences) return Channel.presences();
  return "presences";
}

export function normalizeRealtimeUnsubscribe(subscription) {
  if (typeof subscription === "function") return subscription;
  if (subscription && typeof subscription.unsubscribe === "function") {
    return () => subscription.unsubscribe();
  }
  if (subscription && typeof subscription.close === "function") {
    return () => subscription.close();
  }
  return null;
}

export async function subscribeRealtime(channel, callback) {
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

export async function initializeRealtime() {
  if (state.realtimeReady || state.realtimeUnsubscribe || state.realtimeConnecting) return;
  if (!root.dataset.appwriteDatabaseId || !root.dataset.chatEventsTableId) {
    startRealtimeFallback();
    return;
  }
  if (!window.Appwrite || !window.client) {
    startRealtimeFallback();
    return;
  }

  const channel = realtimeChannelName();
  state.realtimeConnecting = true;
  try {
    const unsubscribe = await subscribeRealtime(channel, handleRealtimePayload);
    if (typeof unsubscribe === "function") {
      state.realtimeUnsubscribe = unsubscribe;
      state.realtimeReady = true;
      stopRealtimeFallback();
    } else {
      startRealtimeFallback();
    }
  } catch (error) {
    console.warn("Chat realtime unavailable", error);
    startRealtimeFallback();
  } finally {
    state.realtimeConnecting = false;
  }
}

export async function initializePresenceRealtime() {
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

export function eventIsRelevant(event) {
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

export async function handleRealtimePayload(response) {
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
      const cache = cacheFor(active);
      const incoming = cache?.latestCursor
        ? await loadMessages({ after: cache.latestCursor, quiet: true })
        : await loadMessages({ force: true, quiet: true });
      if (incoming.length) playChatSound(event.actor_id);
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
      await loadMessages({ force: true, quiet: true, preserveScroll: true });
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

export async function handlePresenceRealtimePayload(response) {
  applyPresenceRecord(response?.payload || response?.presence || response, presenceAction(response));
  renderPresenceDrivenUi();
}

export async function loadInitialPresences() {
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

export function activePresencePayload(kind, room = state.activeRoom) {
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

export async function upsertPresence(kind, room = state.activeRoom) {
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

export async function deletePresence(presenceId) {
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

export function presenceIdFor(kind, room) {
  return activePresencePayload(kind, room)?.presenceId || null;
}

export function clearTypingPresence(room = state.activeRoom) {
  window.clearTimeout(state.typingInputTimer);
  window.clearTimeout(state.typingClearTimer);
  const presenceId = presenceIdFor("typing", room) || state.lastTypingPresenceId;
  state.lastTypingPresenceId = null;
  void deletePresence(presenceId);
}

export function refreshViewingPresence() {
  void upsertPresence("viewing");
}

export function handleActiveRoomPresenceChange(previousRoom) {
  if (previousRoom && roomKey(previousRoom) !== roomKey(state.activeRoom)) {
    clearTypingPresence(previousRoom);
    const previousViewingId = presenceIdFor("viewing", previousRoom) || state.lastViewingPresenceId;
    state.lastViewingPresenceId = null;
    void deletePresence(previousViewingId);
  }
  refreshViewingPresence();
}

export function scheduleTypingPresence() {
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

export function startPresenceRefreshTimer() {
  window.clearInterval(state.presenceRefreshTimer);
  state.presenceRefreshTimer = window.setInterval(refreshViewingPresence, VIEWING_PRESENCE_REFRESH_MS);
}
