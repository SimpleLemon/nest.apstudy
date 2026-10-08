import { staleChannelPresence, staleThreadPresence } from "./presentation.js";

import { CHAT_CACHE_SCHEMA } from "./cache.js";

/**
 * @typedef {import("./store.js").ChatRoomRef} ChatRoomRef
 * @typedef {import("./store.js").ChatRoomRecord} ChatRoomRecord
 * @typedef {Object} ChatBootstrapCache
 * @property {{id: string} | null} [user]
 * @property {Record<string, unknown>} [settings]
 * @property {Record<string, unknown>} [capabilities]
 * @property {ChatRoomRecord[]} [channels]
 * @property {ChatRoomRecord[]} [threads]
 * @property {ChatRoomRef | null} [activeRoom]
 * @property {({school_key?: string} & Record<string, unknown>) | null} [university]
 * @property {string} [discordInviteUrl]
 * @property {boolean} [membersCollapsed]
 * @property {number} [savedAt]
 */

/**
 * Starts disk hydration and server loading concurrently. Once server state is
 * committed, disk hydration cannot choose a room or replace bootstrap metadata.
 * @param {{
 *   root: HTMLElement,
 *   state: ChatBootstrapCache & {serverBootstrapped: boolean, persistentCacheReady: boolean,
 *     hydratedFromPersistentCache: boolean},
 *   extensions: {attachments?: {configure?: (capabilities: Record<string, unknown>) => void},
 *     mediaPicker?: {configure?: (capabilities: Record<string, unknown>) => void}},
 *   persistence: Pick<ReturnType<typeof import("./store.js").createChatStore>, "hydrateRoomFromPersistentCache">,
 *   rooms: {selectRoom: (room: ChatRoomRef, options?: {fromCacheHydration?: boolean, quiet?: boolean, suppressFocus?: boolean}) => Promise<void>,
 *     setMembersCollapsed: (collapsed: boolean) => void, updateRoomLists: () => void,
 *     registerKnownUsersFromState: () => void, renderHeader: () => void},
 *   readState: Pick<ReturnType<typeof import("./read-state.js").createChatReadState>, "refreshChatSummary">,
 *   realtime: {startRealtimeServices: () => Promise<void>},
 *   view: {renderMessages: (messages: import("./store.js").ChatMessage[]) => void, renderMessageLoader: () => void},
 *   scheduler: {schedulePersistentBootstrapSave: () => void, scheduleRoomPrefetches: () => void},
 *   feedback: {setStatus: (message: string, tone: "error") => void},
 *   identity: {currentUserId: () => string, requestedRoomFromLocation: () => ChatRoomRef | null,
 *     roomKey: (room: ChatRoomRef | null | undefined) => string},
 *   fetchJson: (url: string) => Promise<ChatBootstrapCache & {sections?: {nest?: ChatRoomRecord[],
 *     direct_messages?: ChatRoomRecord[]}, discord_invite_url?: string}>,
 *   persistentCache: import("./store.js").PersistentChatCache
 * }} context
 */
export function createChatBootstrap({ readState, root, state, extensions, persistence, rooms, realtime, view, scheduler, feedback, identity, fetchJson, persistentCache }) {
  let bootstrapGeneration = 0;
  let serverGeneration = 0;
  const persistentCacheKey = (suffix) => {
    const userId = identity.currentUserId();
    return userId ? `${CHAT_CACHE_SCHEMA}:user:${userId}:${suffix}` : "";
  };

  async function persistBootstrapCache() {
    if (!identity.currentUserId()) return;
    await persistentCache.write(persistentCacheKey("bootstrap"), {
      user: state.user,
      settings: state.settings,
      channels: (state.channels || []).map(staleChannelPresence),
      threads: (state.threads || []).map(staleThreadPresence),
      university: state.university,
      activeRoom: state.activeRoom,
      discordInviteUrl: root.dataset.discordInviteUrl || "",
      membersCollapsed: state.membersCollapsed,
      savedAt: Date.now(),
    });
  }

  async function hydrateFromPersistentCache() {
    const generation = serverGeneration;
    const initialRoom = state.activeRoom;
    const canHydrate = () => !state.serverBootstrapped && generation === serverGeneration;
    const canSelectCachedRoom = () => canHydrate() && state.activeRoom === initialRoom;
    /** @type {ChatBootstrapCache | null} */
    const payload = /** @type {ChatBootstrapCache | null} */ (
      await persistentCache.read(persistentCacheKey("bootstrap"))
    );
    state.persistentCacheReady = true;
    if (!payload) return false;
    if (!canSelectCachedRoom()) return false;

    state.user = payload.user || state.user;
    state.settings = { ...state.settings, ...(payload.settings || {}) };
    state.capabilities = payload.capabilities || {};
    extensions.attachments?.configure?.(state.capabilities);
    extensions.mediaPicker?.configure?.(state.capabilities);
    state.channels = Array.isArray(payload.channels) ? payload.channels.map(staleChannelPresence) : [];
    state.threads = Array.isArray(payload.threads) ? payload.threads.map(staleThreadPresence) : [];
    state.university = payload.university || null;
    rooms.registerKnownUsersFromState();
    if (payload.discordInviteUrl) root.dataset.discordInviteUrl = payload.discordInviteUrl;
    if (typeof payload.membersCollapsed === "boolean") rooms.setMembersCollapsed(payload.membersCollapsed);
    rooms.updateRoomLists();
    await realtime.startRealtimeServices();
    if (!canSelectCachedRoom()) return false;

    const room = payload.activeRoom || (state.channels[0] && { type: "channel", id: state.channels[0].id });
    if (room) {
      await persistence.hydrateRoomFromPersistentCache(room);
      if (!canSelectCachedRoom()) return false;
      await rooms.selectRoom(room, { fromCacheHydration: true, quiet: true });
      if (!canHydrate()) return false;
      state.hydratedFromPersistentCache = true;
    }
    return true;
  }

  async function bootstrap({ preserveActive = false } = {}) {
    const generation = ++bootstrapGeneration;
    const isCurrentBootstrap = () => generation === bootstrapGeneration;
    const payload = await fetchJson("/api/chat/bootstrap");
    if (!isCurrentBootstrap()) return;
    state.user = payload.user || state.user;
    state.settings = { ...state.settings, ...(payload.settings || {}) };
    state.capabilities = payload.capabilities || {};
    extensions.attachments?.configure?.(state.capabilities);
    extensions.mediaPicker?.configure?.(state.capabilities);
    state.channels = (payload.sections?.nest || []).map(staleChannelPresence);
    state.threads = (payload.sections?.direct_messages || []).map(staleThreadPresence);
    state.university = payload.university || null;
    rooms.registerKnownUsersFromState();
    if (payload.discord_invite_url) root.dataset.discordInviteUrl = payload.discord_invite_url;
    state.serverBootstrapped = true;
    serverGeneration += 1;
    rooms.updateRoomLists();
    await realtime.startRealtimeServices();
    if (!isCurrentBootstrap()) return;
    rooms.setMembersCollapsed(state.membersCollapsed);
    scheduler.schedulePersistentBootstrapSave();
    await readState.refreshChatSummary();
    if (!isCurrentBootstrap()) return;

    const requestedRoom = identity.requestedRoomFromLocation();
    if (requestedRoom) {
      const requestedExists = requestedRoom.type === "channel"
        ? state.channels.some((channel) => channel.id === requestedRoom.id)
        : state.threads.some((thread) => thread.id === requestedRoom.id);
      if (requestedExists) {
        await rooms.selectRoom(requestedRoom, { suppressFocus: preserveActive });
        if (!isCurrentBootstrap()) return;
        scheduler.scheduleRoomPrefetches();
        return;
      }
    }

    const activeKey = identity.roomKey(state.activeRoom);
    if (activeKey) {
      const [type, id] = activeKey.split(":");
      const stillExists = type === "channel"
        ? state.channels.some((channel) => channel.id === id)
        : state.threads.some((thread) => thread.id === id);
      if (stillExists) {
        await rooms.selectRoom({ type, id }, { suppressFocus: preserveActive });
        if (!isCurrentBootstrap()) return;
        scheduler.scheduleRoomPrefetches();
        return;
      }
    }

    const firstChannel = state.channels[0];
    const firstThread = state.threads[0];
    if (firstChannel) {
      await rooms.selectRoom({ type: "channel", id: firstChannel.id });
    } else if (firstThread) {
      await rooms.selectRoom({ type: "thread", id: firstThread.id });
    } else {
      rooms.renderHeader();
      view.renderMessages([]);
    }
    if (!isCurrentBootstrap()) return;
    scheduler.scheduleRoomPrefetches();
  }

  async function startChat() {
    rooms.setMembersCollapsed(state.membersCollapsed);
    view.renderMessageLoader();
    const cachePromise = hydrateFromPersistentCache().catch((error) => {
      if (error?.name === "AbortError") return false;
      console.warn("Unable to hydrate chat cache", error);
      state.persistentCacheReady = true;
      return false;
    });
    const bootstrapPromise = bootstrap().catch((error) => {
      if (error?.name === "AbortError") return false;
      feedback.setStatus(error.message || "Unable to load chat.", "error");
      throw error;
    });
    await Promise.allSettled([cachePromise, bootstrapPromise]);
  }

  return { bootstrap, startChat, persistBootstrapCache };
}
