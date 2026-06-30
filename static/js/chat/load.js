import {
  CHAT_PREFETCH_ROOM_LIMIT,
  els,
  root,
  state,
} from "./context.js";
import {
  registerKnownUsersFromState,
  requestedRoomFromLocation,
  roomKey,
  staleChannelPresence,
  staleThreadPresence,
} from "./utils.js";
import {
  cacheFor,
  fetchJson,
  hydrateRoomFromPersistentCache,
  isNearBottom,
  latestMessageForRead,
  markRoomRead,
  mergeMessages,
  refreshChatSummary,
  restoreScroll,
  saveActiveScroll,
  schedulePersistentBootstrapSave,
  schedulePersistentRoomSave,
  updateCacheCursors,
} from "./cache.js";
import {
  activeChannel,
  activeThread,
  channelIsPending,
  closeInlineProfilePopover,
  focusComposerSoon,
  renderMessageLoader,
  setStatus,
  updateRoomLists,
} from "./render-ui.js";
import {
  renderApprovalNotice,
  renderDmProfile,
  renderHeader,
  renderMembers,
  renderMessages,
  updateChannel,
  updateCurrentMembersFromPayload,
  updateThread,
} from "./render-messages.js";
import {
  currentRoomUrl,
  renderPresenceDrivenUi,
} from "./presence.js";
import {
  handleActiveRoomPresenceChange,
  initializePresenceRealtime,
  initializeRealtime,
  loadInitialPresences,
} from "./realtime.js";
import {
  setMembersCollapsed,
} from "./actions.js";

export async function loadMessages({ before = null, after = null, force = false, preserveScroll = false, quiet = false } = {}) {
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
  if (!quiet && !before && !after && !cache.loaded) renderMessageLoader();

  try {
    const payload = await fetchJson(currentRoomUrl(room, { before, after }));
    if (!state.activeRoom || roomKey(state.activeRoom) !== roomKey(room)) return [];

    if (payload.channel) updateChannel(payload.channel);
    if (payload.thread) updateThread(payload.thread);
    if (payload.read_state) state.roomReadState = payload.read_state;

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
    schedulePersistentRoomSave(room);
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
    if (!before && (wasNearBottom || !after)) {
      markRoomRead(room, cache);
    }
    schedulePersistentBootstrapSave();
    return messages;
  } catch (error) {
    setStatus(error.message || "Unable to load messages.", "error");
    return [];
  } finally {
    state.loadingMessages = false;
  }
}

export async function prefetchRoomMessages(room) {
  const key = roomKey(room);
  if (!key || state.prefetchingRooms.has(key)) return;
  const cache = cacheFor(room);
  if (cache?.loaded && !cache.stale) return;
  state.prefetchingRooms.add(key);
  try {
    await hydrateRoomFromPersistentCache(room);
    const roomCache = cacheFor(room);
    const params = roomCache?.latestCursor ? { after: roomCache.latestCursor } : {};
    const payload = await fetchJson(currentRoomUrl(room, params));
    if (payload.channel) updateChannel(payload.channel);
    if (payload.thread) updateThread(payload.thread);
    const messages = payload.messages || [];
    roomCache.messages = params.after
      ? mergeMessages(roomCache.messages, messages)
      : mergeMessages([], messages);
    roomCache.loaded = true;
    roomCache.stale = false;
    roomCache.hasMore = Boolean(payload.has_more);
    updateCacheCursors(roomCache);
    schedulePersistentRoomSave(room);
    schedulePersistentBootstrapSave();
  } catch (_) {
    const roomCache = cacheFor(room);
    if (roomCache) roomCache.stale = true;
  } finally {
    state.prefetchingRooms.delete(key);
  }
}

export function scheduleRoomPrefetches() {
  const rooms = [
    ...state.channels.map((channel) => ({ type: "channel", id: channel.id })),
    ...state.threads.slice(0, CHAT_PREFETCH_ROOM_LIMIT).map((thread) => ({ type: "thread", id: thread.id })),
  ]
    .filter((room) => room.id)
    .filter((room) => roomKey(room) !== roomKey(state.activeRoom))
    .slice(0, CHAT_PREFETCH_ROOM_LIMIT);
  if (!rooms.length) return;
  const run = () => {
    for (const room of rooms) {
      void prefetchRoomMessages(room);
    }
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 2500 });
  } else {
    window.setTimeout(run, 700);
  }
}

export function renderCachedRoom(room, options = {}) {
  const cache = cacheFor(room);
  if (!cache) return false;
  if (!cache.loaded) return false;
  renderMessages(cache.messages);
  restoreScroll(cache, Boolean(options.toBottom));
  return true;
}

export function markRoomStale(room) {
  const cache = cacheFor(room);
  if (cache) cache.stale = true;
}

export function removeMessageFromCaches(messageId) {
  if (!messageId) return;
  for (const [key, cache] of state.roomCache.entries()) {
    cache.messages = cache.messages.filter((message) => message.id !== messageId);
    updateCacheCursors(cache);
    const [type, id] = key.split(":");
    if (type && id) schedulePersistentRoomSave({ type, id });
  }
  const activeCache = cacheFor(state.activeRoom);
  if (activeCache) renderMessages(activeCache.messages);
}

export async function selectRoom(room, options = {}) {
  const previousRoom = state.activeRoom;
  saveActiveScroll();
  closeInlineProfilePopover();
  state.activeRoom = room;
  state.activeProfile = null;
  updateRoomLists();
  renderHeader();
  if (!options.suppressFocus) focusComposerSoon();
  setStatus(null);
  handleActiveRoomPresenceChange(previousRoom);

  const channel = activeChannel();
  const thread = activeThread();
  if (channelIsPending(channel)) {
    renderApprovalNotice(channel);
    schedulePersistentBootstrapSave();
    return;
  }

  if (thread) {
    renderDmProfile(thread);
  } else {
    renderMembers(channel?.active_users || []);
  }

  const cache = cacheFor(room);
  if (!cache.loaded) {
    await hydrateRoomFromPersistentCache(room);
  }
  if (renderCachedRoom(room)) {
    if (!cache.stale || latestMessageForRead(cache)) {
      markRoomRead(room, cache);
    }
    if (cache.stale && cache.latestCursor) {
      await loadMessages({ after: cache.latestCursor, quiet: true });
      markRoomRead(room);
    } else if (cache.stale) {
      await loadMessages({ force: true, quiet: true });
      markRoomRead(room);
    }
  } else {
    await loadMessages({ force: true });
    markRoomRead(room);
  }
  renderPresenceDrivenUi();
  schedulePersistentBootstrapSave();
}

export async function bootstrap({ preserveActive = false } = {}) {
  const payload = await fetchJson("/api/chat/bootstrap");
  state.user = payload.user || state.user;
  state.settings = { ...state.settings, ...(payload.settings || {}) };
  state.channels = (payload.sections?.nest || []).map(staleChannelPresence);
  state.threads = (payload.sections?.direct_messages || []).map(staleThreadPresence);
  state.university = payload.university || null;
  registerKnownUsersFromState();
  if (payload.discord_invite_url) root.dataset.discordInviteUrl = payload.discord_invite_url;
  state.serverBootstrapped = true;
  updateRoomLists();
  initializeRealtime();
  initializePresenceRealtime();
  void loadInitialPresences();
  setMembersCollapsed(state.membersCollapsed);
  schedulePersistentBootstrapSave();
  await refreshChatSummary();

  const requestedRoom = requestedRoomFromLocation();
  if (requestedRoom) {
    const requestedExists = requestedRoom.type === "channel"
      ? state.channels.some((channel) => channel.id === requestedRoom.id)
      : state.threads.some((thread) => thread.id === requestedRoom.id);
    if (requestedExists) {
      await selectRoom(requestedRoom, { suppressFocus: preserveActive });
      scheduleRoomPrefetches();
      return;
    }
  }

  const activeKey = roomKey(state.activeRoom);
  if (activeKey) {
    const [type, id] = activeKey.split(":");
    const stillExists = type === "channel"
      ? state.channels.some((channel) => channel.id === id)
      : state.threads.some((thread) => thread.id === id);
    if (stillExists) {
      await selectRoom({ type, id }, { suppressFocus: preserveActive });
      scheduleRoomPrefetches();
      return;
    }
  }

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
  scheduleRoomPrefetches();
}
