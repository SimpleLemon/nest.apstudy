import { deltaLoadParams } from "./cache.js";

/**
 * @typedef {import("./store.js").ChatRoomRef} ChatRoomRef
 * @typedef {import("./store.js").ChatMessage} ChatMessage
 * @typedef {import("./store.js").ChatRoomRecord} ChatRoomRecord
 * @typedef {import("./store.js").ChatRoomCache} ChatRoomCache
 * @typedef {{messages?: ChatMessage[], has_more?: boolean, channel?: ChatRoomRecord,
 *   thread?: ChatRoomRecord, read_state?: Record<string, unknown>} & Record<string, unknown>} ChatMessagesPayload
 * @typedef {{signal?: AbortSignal, isCurrent: (room: ChatRoomRef) => boolean}} ChatRoomSelection
 * @typedef {{before?: string | null, before_message_id?: string | null, after?: string | null, after_message_id?: string | null,
 *   force?: boolean, preserveScroll?: boolean, quiet?: boolean, light?: boolean,
 *   signal?: AbortSignal | null, roomSelection?: ChatRoomSelection | null}} ChatLoadOptions
 */

/**
 * Loads and prefetches snapshots, rejecting replies from a superseded room selection.
 * Active load failures reject after feedback; superseded or cancelled loads are empty.
 * @param {{
 *   state: {activeRoom: ChatRoomRef | null, loadingMessages: boolean, channels: ChatRoomRecord[],
 *     threads: ChatRoomRecord[], prefetchingRooms: Set<string>, roomReadState?: Record<string, unknown>},
 *   els: {messages: HTMLElement},
 *   scheduler: {schedulePersistentBootstrapSave: () => void,
 *     scheduleIdle: (callback: () => void, options?: IdleRequestOptions) => void,
 *     scheduleTransientTimeout: (callback: () => void, delay?: number) => number},
 *   store: Pick<ReturnType<typeof import("./store.js").createChatStore>,
 *     "cacheFor" | "hydrateRoomFromPersistentCache" | "mergeRoomMessages" | "replaceRoomMessages" | "markRoomStale">,
 *   rooms: {activeChannel: () => ChatRoomRecord | null, channelIsPending: (channel: ChatRoomRecord | null) => boolean,
 *     updateChannel: (channel: ChatRoomRecord) => void, updateThread: (thread: ChatRoomRecord) => void,
 *     renderHeader: () => void, updateRoomLists: () => void},
 *   identity: {roomKey: (room: ChatRoomRef | null) => string},
 *   readState: {markRoomRead: (room: ChatRoomRef, cache?: ChatRoomCache) => void},
 *   onRoomDetails: (payload: ChatMessagesPayload) => void,
 *   view: {isNearBottom: () => boolean, renderApprovalNotice: (channel: ChatRoomRecord | null) => void,
 *     renderMessageLoader: () => void, renderMessages: (messages: ChatMessage[]) => void,
 *     restoreScroll: (cache: ChatRoomCache, toBottom: boolean) => void, stickToBottom: () => void,
 *     syncMessagesToDom: (messages: ChatMessage[], options: {incremental?: boolean, incoming?: ChatMessage[], scrollToBottom?: boolean}) => void},
 *   feedback: {setStatus: (message: string | null, tone?: "error") => void},
 *   fetchJson: (url: string, options?: RequestInit) => Promise<ChatMessagesPayload>
 * }} context
 */
export function createChatMessageLoading({ readState, state, els, scheduler, store, rooms, identity, onRoomDetails, view, feedback, fetchJson }) {
  const CHAT_PREFETCH_ROOM_LIMIT = 8;
  let loadingMessagesToken = null;
  let messagePublicationToken = null;
  let detailsPublicationToken = null;
  const pendingSnapshots = new Set();

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

  /** Capture the selected room and viewport before starting a request. */
  function prepareMessageLoad(options) {
    const room = state.activeRoom;
    if (!room) return null;
    const cache = store.cacheFor(room);
    if (!cache || (state.loadingMessages && !options.force)) return null;
    const channel = rooms.activeChannel();
    if (rooms.channelIsPending(channel)) {
      view.renderApprovalNotice(channel);
      return null;
    }
    const isDelta = Boolean(options.after || options.after_message_id);
    return {
      room,
      cache,
      options,
      isDelta,
      useLight: options.light || (options.quiet && isDelta && !options.before && !options.before_message_id),
      wasNearBottom: view.isNearBottom(),
      previousHeight: els.messages.scrollHeight,
      previousTop: els.messages.scrollTop,
      isCurrent: () => Boolean(
        state.activeRoom
        && identity.roomKey(state.activeRoom) === identity.roomKey(room)
        && (!options.roomSelection || options.roomSelection.isCurrent?.(state.activeRoom))
      ),
    };
  }

  function applyLoadedRoomDetails(payload) {
    if (payload.channel) rooms.updateChannel(payload.channel);
    if (payload.thread) rooms.updateThread(payload.thread);
    if (payload.read_state) state.roomReadState = payload.read_state;
    rooms.renderHeader();
    rooms.updateRoomLists();
    onRoomDetails(payload);
    scheduler.schedulePersistentBootstrapSave();
  }

  /** Render a stored snapshot, preserving the appropriate history or delta anchor. */
  function renderLoadedMessages(load, change) {
    const { options, isDelta, useLight, wasNearBottom, previousHeight, previousTop } = load;
    const { preserveScroll } = options;
    const before = Boolean(options.before || options.before_message_id);
    if (useLight && isDelta && !before) {
      if (change.incoming.length) {
        view.syncMessagesToDom(change.messages, {
          incremental: true,
          incoming: change.incoming,
          scrollToBottom: wasNearBottom,
        });
      }
      return;
    }
    view.syncMessagesToDom(change.messages, {
      scrollToBottom: !before && !isDelta && !preserveScroll && wasNearBottom,
    });
    if (before) {
      els.messages.scrollTop = previousTop + els.messages.scrollHeight - previousHeight;
    } else if (!isDelta) {
      view.restoreScroll(change.cache, !preserveScroll);
    } else if (wasNearBottom) {
      view.stickToBottom();
    }
  }

  /** @param {ChatLoadOptions} options @returns {Promise<ChatMessage[]>} */
  async function loadMessages(options = {}) {
    const load = prepareMessageLoad(options);
    if (!load) return [];
    const { room, cache, isDelta, useLight, wasNearBottom, isCurrent } = load;
    const { before, before_message_id, after, after_message_id, quiet, signal, roomSelection } = options;
    const isHistory = Boolean(before || before_message_id);
    state.loadingMessages = true;
    const requestToken = Symbol("chat-message-load");
    loadingMessagesToken = requestToken;
    detailsPublicationToken = requestToken;
    // History pages are additive; a newer refresh must not discard their reply.
    if (!isHistory) messagePublicationToken = requestToken;
    const canPublishMessages = () => isCurrent() && (isHistory || messagePublicationToken === requestToken);
    const canPublishDetails = () => isCurrent() && detailsPublicationToken === requestToken;
    const snapshot = !isHistory && !isDelta ? { cache, historyPages: [] } : null;
    if (snapshot) pendingSnapshots.add(snapshot);
    if (!quiet && !isHistory && !isDelta && !cache.loaded) view.renderMessageLoader();
    try {
      const requestSignal = signal || roomSelection?.signal || null;
      const payload = await fetchJson(currentRoomUrl(room, { before, before_message_id, after, after_message_id }),
        requestSignal ? { signal: requestSignal } : {});
      if (!canPublishMessages()) return [];
      const messages = payload.messages || [];
      if (isHistory) {
        for (const pending of pendingSnapshots) {
          if (pending.cache === cache) pending.historyPages.push({ messages, hasMore: Boolean(payload.has_more) });
        }
      }
      // A full refresh must retain history fetched while its request was pending.
      const snapshotMessages = snapshot ? [...messages, ...snapshot.historyPages.flatMap((page) => page.messages)] : messages;
      const snapshotHasMore = snapshot?.historyPages.at(-1)?.hasMore ?? Boolean(payload.has_more);
      // Delta has_more describes no backward page; retain the history boundary.
      const change = isDelta || isHistory
        ? store.mergeRoomMessages(room, messages, isHistory ? { hasMore: Boolean(payload.has_more) } : {})
        : store.replaceRoomMessages(room, snapshotMessages, { hasMore: snapshotHasMore });
      if (!useLight && canPublishDetails()) applyLoadedRoomDetails(payload);
      renderLoadedMessages(load, change);
      if (canPublishDetails()) {
        feedback.setStatus(null);
        if (!isHistory && (wasNearBottom || !isDelta)) readState.markRoomRead(room, change.cache);
      }
      return messages;
    } catch (error) {
      if (error?.name === "AbortError" || !canPublishMessages()) return [];
      store.markRoomStale(room);
      if (canPublishDetails()) {
        feedback.setStatus(error.message || "Unable to load messages.", "error");
      }
      throw error;
    } finally {
      if (snapshot) pendingSnapshots.delete(snapshot);
      if (loadingMessagesToken === requestToken) {
        state.loadingMessages = false;
        loadingMessagesToken = null;
      }
    }
  }

  async function prefetchRoomMessages(room) {
    const key = identity.roomKey(room);
    if (!key || state.prefetchingRooms.has(key)) return;
    const cache = store.cacheFor(room);
    if (cache?.loaded && !cache.stale) return;
    state.prefetchingRooms.add(key);
    try {
      await store.hydrateRoomFromPersistentCache(room);
      const roomCache = store.cacheFor(room);
      const params = deltaLoadParams(roomCache);
      const payload = await fetchJson(currentRoomUrl(room, params));
      if (payload.channel) rooms.updateChannel(payload.channel);
      if (payload.thread) rooms.updateThread(payload.thread);
      const messages = payload.messages || [];
      if (params.after) {
        store.mergeRoomMessages(room, messages);
      } else {
        store.replaceRoomMessages(room, messages, { hasMore: payload.has_more || false });
      }
      scheduler.schedulePersistentBootstrapSave();
    } catch {
      store.markRoomStale(room);
    } finally {
      state.prefetchingRooms.delete(key);
    }
  }

  function scheduleRoomPrefetches() {
    const candidates = [
      ...state.channels.map((channel) => ({ type: "channel", id: channel.id })),
      ...state.threads.slice(0, CHAT_PREFETCH_ROOM_LIMIT).map((thread) => ({ type: "thread", id: thread.id })),
    ]
      .filter((room) => room.id)
      .filter((room) => identity.roomKey(room) !== identity.roomKey(state.activeRoom))
      .slice(0, CHAT_PREFETCH_ROOM_LIMIT);
    if (!candidates.length) return;
    const run = () => {
      for (const room of candidates) {
        void prefetchRoomMessages(room);
      }
    };
    if ("requestIdleCallback" in window) {
      scheduler.scheduleIdle(run, { timeout: 2500 });
    } else {
      scheduler.scheduleTransientTimeout(run, 700);
    }
  }

  function renderCachedRoom(room, options = {}) {
    const cache = store.cacheFor(room);
    if (!cache) return false;
    if (!cache.loaded) return false;
    view.renderMessages(cache.messages);
    view.restoreScroll(cache, Boolean(options.toBottom));
    return true;
  }

  return { loadMessages, prefetchRoomMessages, scheduleRoomPrefetches, renderCachedRoom, currentRoomUrl };
}
