import { deltaLoadParams } from "./cache.js";

export function createChatRealtime({ readState, state, config, lifecycle, fetchJson, bootstrap, feedback, identity, loading, presence, rooms, store, view }) {
  const {
    REALTIME_FALLBACK_MS,
    REALTIME_RECONNECT_MS,
  } = config;

  let realtimeFallbackTimer = null;
  let realtimeReconnectTimer = null;
  let chatEventSource = null;
  let chatEventCursor = { since: null, after_id: null };
  let connectionGeneration = 0;
  const seenChatEventIds = new Set();
  const seenChatMessageIds = new Set();
  const SEEN_ID_LIMIT = 5000;

  function rememberId(seenIds, value) {
    const id = String(value || "");
    if (!id) return false;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > SEEN_ID_LIMIT) {
      const oldest = seenIds.values().next().value;
      seenIds.delete(oldest);
    }
    return true;
  }

  function rememberChatEventId(eventId) {
    return rememberId(seenChatEventIds, eventId);
  }

  function rememberChatMessageId(messageId) {
    return rememberId(seenChatMessageIds, messageId);
  }

  function isActiveRoom(room) {
    return Boolean(
      room
      && state.activeRoom
      && identity.roomKey(state.activeRoom) === identity.roomKey(room)
    );
  }

  async function fetchMessageById(messageId) {
    if (!messageId) return null;
    try {
      const payload = await fetchJson(`/api/chat/messages/${encodeURIComponent(messageId)}`);
      return payload?.message || null;
    } catch {
      return null;
    }
  }

  async function ingestMessageUpdate(event, isCurrent) {
    const room = state.activeRoom;
    const cache = store.cacheFor(room);
    if (!room || !cache) return false;
    if (event.message_id) {
      const message = await fetchMessageById(event.message_id);
      if (!isCurrent()) return false;
      if (message) {
        const change = store.mergeRoomMessages(room, [message]);
        if (!isActiveRoom(room)) return false;
        if (view.patchMessageInDom(message)) {
          view.updateAnnouncementsUnreadBanner(change.messages);
          return true;
        }
      }
    }
    if (!isActiveRoom(room)) return false;
    await loading.loadMessages({ force: true, quiet: true, preserveScroll: true, light: true,
      roomSelection: { isCurrent: () => isCurrent() && isActiveRoom(room) } });
    return false;
  }

  async function ingestActiveRoomMessage(event, isCurrent) {
    const room = state.activeRoom;
    const cache = store.cacheFor(room);
    if (!room || !cache) return false;

    if (event.message_id && !cache.messages.some((message) => message.id === event.message_id)) {
      const message = await fetchMessageById(event.message_id);
      if (!isCurrent()) return false;
      if (message) {
        view.renderIncomingMessages(store.mergeRoomMessages(room, [message]));
        if (!isActiveRoom(room)) return false;
        feedback.playChatSound(event.actor_id);
        return true;
      }
    }

    if (!isActiveRoom(room)) return false;

    const delta = deltaLoadParams(cache);
    const roomSelection = { isCurrent: () => isCurrent() && isActiveRoom(room) };
    const incoming = delta.after
      ? await loading.loadMessages({ ...delta, quiet: true, force: true, light: true, roomSelection })
      : await loading.loadMessages({ force: true, quiet: true, roomSelection });
    if (!incoming.length && event.message_id) {
      await loading.loadMessages({ force: true, quiet: true, roomSelection });
    } else if (incoming.length) {
      feedback.playChatSound(event.actor_id);
      return true;
    }
    return isActiveRoom(room) && incoming.length > 0;
  }

  function pollActiveRoomMessages() {
    if (state.realtimeReady) return;
    const room = state.activeRoom;
    const cache = store.cacheFor(room);
    if (!room || !cache) return;
    const delta = deltaLoadParams(cache);
    if (delta.after) {
      void loading.loadMessages({ ...delta, quiet: true, force: true, light: true }).catch(() => {});
    } else {
      void loading.loadMessages({ force: true, quiet: true }).catch(() => {});
    }
  }

  function startRealtimeFallback() {
    if (lifecycle.paused || lifecycle.disposed || realtimeFallbackTimer || state.realtimeReady) return;
    realtimeFallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (state.realtimeReady) {
        stopRealtimeFallback();
        return;
      }
      pollActiveRoomMessages();
      void readState.refreshChatSummary();
    }, REALTIME_FALLBACK_MS);
  }

  function stopRealtimeFallback() {
    if (!realtimeFallbackTimer) return;
    window.clearInterval(realtimeFallbackTimer);
    realtimeFallbackTimer = null;
  }

  function resetRealtimeConnection() {
    connectionGeneration += 1;
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
  }

  function buildChatEventsStreamUrl() {
    const params = new URLSearchParams();
    if (chatEventCursor.since) params.set("since", chatEventCursor.since);
    if (chatEventCursor.after_id) params.set("after_id", chatEventCursor.after_id);
    const qs = params.toString();
    return qs ? `/api/chat/events/stream?${qs}` : "/api/chat/events/stream";
  }

  function scheduleRealtimeReconnect() {
    if (lifecycle.paused || lifecycle.disposed || realtimeReconnectTimer) return;
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

  async function startRealtimeServices() {
    if (lifecycle.paused || lifecycle.disposed) return;
    initializeChatEventStream();
    void presence.loadInitialPresences();
  }

  function initializeChatEventStream() {
    if (lifecycle.paused || lifecycle.disposed) return;
    if (state.realtimeReady || chatEventSource || state.realtimeConnecting) return;
    if (typeof window.EventSource !== "function") {
      startRealtimeFallback();
      return;
    }
    state.realtimeConnecting = true;
    const generation = ++connectionGeneration;
    try {
      const source = new EventSource(buildChatEventsStreamUrl());
      chatEventSource = source;
      const isCurrentConnection = () => generation === connectionGeneration
        && source === chatEventSource && !lifecycle.paused && !lifecycle.disposed;
      let reconciliation = Promise.resolve();
      source.onopen = () => {
        if (generation !== connectionGeneration || source !== chatEventSource || lifecycle.paused || lifecycle.disposed) {
          source.close();
          return;
        }
        state.realtimeReady = true;
        state.realtimeConnecting = false;
        state.realtimeUnsubscribe = () => {
          if (chatEventSource) {
            chatEventSource.close();
            chatEventSource = null;
          }
        };
        stopRealtimeFallback();
      };
      source.onmessage = (messageEvent) => {
        if (generation !== connectionGeneration || source !== chatEventSource || lifecycle.paused || lifecycle.disposed) return;
        let payload;
        try {
          payload = JSON.parse(messageEvent.data);
        } catch {
          return;
        }
        // Checkpoint only contiguous successful events. A failed event closes
        // this generation before later queued events can skip its replay.
        reconciliation = reconciliation.then(async () => {
          if (!isCurrentConnection()) return;
          const eventId = payload?.$id || payload?.id;
          if (eventId && seenChatEventIds.has(String(eventId))) return;
          await handleRealtimePayload({ payload }, isCurrentConnection);
          if (!isCurrentConnection()) return;
          if (eventId) rememberChatEventId(eventId);
          if (payload?.created_at) {
            chatEventCursor = { since: payload.created_at, after_id: eventId || null };
          }
        }).catch((error) => {
          console.warn("Unable to reconcile chat event", { eventId: payload?.$id || payload?.id, eventType: payload?.event_type }, error);
          if (isCurrentConnection()) scheduleRealtimeReconnect();
        });
      };
      source.onerror = () => {
        if (generation !== connectionGeneration || source !== chatEventSource || lifecycle.paused || lifecycle.disposed) return;
        handleRealtimeDisconnect();
      };
    } catch (error) {
      console.warn("Chat event stream unavailable", error);
      state.realtimeConnecting = false;
      handleRealtimeDisconnect();
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

  async function handleRealtimePayload(response, isCurrent = () => true) {
    const event = normalizeChatEvent(response);
    if (!eventIsRelevant(event)) return;
    const eventRoom = event.scope_type === "channel"
      ? { type: "channel", id: event.scope_id || event.channel_id }
      : event.scope_type === "thread"
        ? { type: "thread", id: event.scope_id || event.thread_id }
        : null;

    if (event.event_type === "message_deleted") {
      store.removeMessageFromCaches(event.message_id);
      view.renderRemovedMessage(event.message_id);
      void readState.refreshChatSummary();
      return;
    }

    if (event.event_type === "message_created") {
      if (event.message_id && seenChatMessageIds.has(String(event.message_id))) return;
      if (eventRoom?.type === "thread" && !rooms.threadExists(eventRoom.id)) {
        const thread = await rooms.fetchThread(eventRoom.id);
        if (!isCurrent()) return;
        if (!thread) {
          await bootstrap.bootstrap({ preserveActive: true });
        }
      }
      if (!isCurrent()) return;
      const active = state.activeRoom;
      if (eventRoom && active && identity.roomKey(eventRoom) === identity.roomKey(active)) {
        await ingestActiveRoomMessage(event, isCurrent);
      } else if (eventRoom) {
        store.markRoomStale(eventRoom);
        readState.scheduleUnreadSummaryRefresh();
        feedback.playChatSound(event.actor_id);
      }
      if (isCurrent() && event.message_id) rememberChatMessageId(event.message_id);
      return;
    }

    if (event.event_type === "message_updated") {
      const active = state.activeRoom;
      if (eventRoom && active && identity.roomKey(eventRoom) === identity.roomKey(active)) {
        await ingestMessageUpdate(event, isCurrent);
      } else if (eventRoom) {
        store.markRoomStale(eventRoom);
      }
      return;
    }

    if (["thread_updated", "block_updated", "university_approved", "university_denied"].includes(event.event_type)) {
      if (eventRoom) store.markRoomStale(eventRoom);
      if (event.event_type === "thread_updated" && eventRoom?.type === "thread") {
        const thread = await rooms.fetchThread(eventRoom.id);
        if (!isCurrent()) return;
        if (thread) {
          void readState.refreshChatSummary();
          return;
        }
      }
      await bootstrap.bootstrap({ preserveActive: true });
    }
  }

  function bindEvents() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const room = state.activeRoom;
        const cache = store.cacheFor(room);
        if (cache?.loaded) {
          if (cache.latestCursor) {
            const delta = deltaLoadParams(cache);
            void loading.loadMessages({ ...delta, quiet: true, force: true, light: true })
              .then(() => {
                readState.markRoomRead(room, cache);
                void readState.refreshChatSummary();
              }).catch(() => {});
          } else if (cache.stale) {
            void loading.loadMessages({ force: true, quiet: true })
              .then(() => {
                readState.markRoomRead(room, cache);
                void readState.refreshChatSummary();
              }).catch(() => {});
          } else {
            readState.markRoomRead(room, cache);
            void readState.refreshChatSummary();
          }
        } else {
          void readState.refreshChatSummary();
        }
        presence.refreshViewingPresence();
      } else {
        presence.clearTypingPresence();
      }
    });
  }

  function clearReconnectTimer() {
    window.clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }

  return {
    bindEvents,
    clearReconnectTimer,
    handleRealtimePayload,
    resetRealtimeConnection,
    startRealtimeFallback,
    startRealtimeServices,
    stopRealtimeFallback,
  };
}
