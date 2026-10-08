import { createChatReadState } from "./read-state.js";
import { createChatLifecycle } from "./lifecycle.js";
import { createPersistentChatCache, deltaLoadParams } from "./cache.js";
import { createChatBootstrap } from "./bootstrap.js";
import { createChatMessageLoading } from "./message-loading.js";
import { createChatProfiles } from "./profiles.js";
import { createChatStore } from "./store.js";
import { createChatComposer } from "./composer.js";
import { createChatMessagesDom } from "./messages-dom.js";
import { createChatPresence } from "./presence.js";
import { createChatRealtime } from "./realtime.js";
import { createChatRooms } from "./rooms.js";

export function startChatRuntime(extensions = {}) {
  const root = document.querySelector(".chat-app");
  if (!root) return;

  const PRESENCE_REFRESH_MS = 5000;
  const TYPING_PRESENCE_TTL_MS = 8000;
  const PRESENCE_TAB_ID_KEY = "apstudy-presence-tab-id";
  const REALTIME_FALLBACK_MS = 3000;
  const REALTIME_RECONNECT_MS = 1500;
  const ANNOUNCEMENTS_CHANNEL_ID = "nest_announcements";
  const GRAMMARLY_DISABLED_ATTRS = 'data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" spellcheck="false"';

  const state = {
    user: root.dataset.currentUserId ? { id: root.dataset.currentUserId } : null,
    settings: { chat_sound_enabled: true },
    capabilities: {},
    channels: [],
    threads: [],
    university: null,
    activeRoom: null,
    activeProfile: null,
    roomCache: new Map(),
    roomUnread: new Map(),
    presenceRefreshTimer: null,
    typingInputTimer: null,
    typingClearTimer: null,
    presenceRecords: new Map(),
    knownUsers: new Map(),
    tabId: null,
    searchTimer: null,
    scrollSaveTimer: null,
    realtimeUnsubscribe: null,
    realtimeReady: false,
    realtimeConnecting: false,
    chatSummaryLoading: false,
    localReadSeq: 0,
    clearedReadRooms: new Set(),
    messageSendInFlight: false,
    contextMenuRoom: null,
    contextMenuAnchor: null,
    loadingMessages: false,
    roomReadState: null,
    announcementsBannerVisible: false,
    membersCollapsed: sessionStorage.getItem("apstudy-chat-members-collapsed") === null
      ? window.innerWidth < 1440
      : sessionStorage.getItem("apstudy-chat-members-collapsed") === "true",
    hydratedFromPersistentCache: false,
    persistentCacheReady: false,
    serverBootstrapped: false,
    prefetchingRooms: new Set(),
    failedMessages: new Map(),
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
    announcementsUnread: document.getElementById("chat-announcements-unread"),
    announcementsRead: document.getElementById("chat-announcements-read"),
    joinDiscord: document.getElementById("chat-join-discord"),
    messages: document.getElementById("chat-messages"),
    typing: document.getElementById("chat-typing-indicator"),
    composer: document.getElementById("chat-composer"),
    input: document.getElementById("chat-message-input"),
    sendButton: document.querySelector(".chat-send-button"),
    pendingFiles: document.getElementById("chat-pending-files"),
    newMessages: document.getElementById("chat-new-messages"),
    members: document.getElementById("chat-members"),
    memberList: document.getElementById("chat-member-list"),
    membersContext: document.getElementById("chat-members-context"),
    membersCount: document.getElementById("chat-members-count"),
    membersRestoreCount: document.getElementById("chat-members-restore-count"),
    profilePanel: document.getElementById("chat-profile-panel"),
    profileBack: document.querySelector("[data-profile-back]"),
    profileToggle: document.querySelector("[data-toggle-members]"),
    audio: document.getElementById("chat-audio"),
  };

  const mediaExtensions = [extensions.attachments, extensions.mediaPicker, extensions.messageMedia];
  const lifecycle = createChatLifecycle({
    readState: {
      cancelUnreadSummaryRefresh: () => readState.cancelUnreadSummaryRefresh(),
      refreshChatSummary: () => readState.refreshChatSummary(),
    },
    state,
    audio: els.audio,
    store: {
      cacheFor: (...args) => store.cacheFor(...args),
      persistRoomCache: (...args) => store.persistRoomCache(...args),
      saveRoomScroll: (...args) => store.saveRoomScroll(...args),
    },
    rooms: {
      cancelRoomSelection: () => rooms.cancelRoomSelection(),
      closeRoomContextMenu: () => rooms.closeRoomContextMenu(),
    },
    presence: {
      clearTypingPresence: () => presence.clearTypingPresence(),
      refreshViewingPresence: () => presence.refreshViewingPresence(),
      startPresenceRefreshTimer: () => presence.startPresenceRefreshTimer(),
      stopPresenceRefreshTimer: () => presence.stopPresenceRefreshTimer(),
    },
    realtime: {
      clearReconnectTimer: () => realtime.clearReconnectTimer(),
      resetRealtimeConnection: () => realtime.resetRealtimeConnection(),
      startRealtimeServices: () => realtime.startRealtimeServices(),
      stopRealtimeFallback: () => realtime.stopRealtimeFallback(),
    },
    view: {
      messages: els.messages,
      closeInlineProfilePopover: () => messagesDom.closeInlineProfilePopover(),
    },
    bootstrap: { startChat: () => bootstrap.startChat() },
    media: {
      pause: () => mediaExtensions.forEach((extension) => extension?.pause?.()),
      resume: () => mediaExtensions.forEach((extension) => extension?.resume?.()),
      dispose: () => mediaExtensions.forEach((extension) => extension?.dispose?.()),
    },
  });
  const { fetchJson, scheduleTransientTimeout, scheduleTransientFrame, scheduleIdle, playChatSound } = lifecycle;

  const extensionContext = {
    state,
    els,
    setStatus: (...args) => setStatus(...args),
    onComposerChange: () => {
      if (els.pendingFiles) {
        els.pendingFiles.hidden = !extensions.attachments?.hasContent?.() && !extensions.mediaPicker?.hasSelection?.();
      }
      composer.updateComposerSubmitState();
    },
  };
  extensions.attachments?.init?.(extensionContext);
  extensions.mediaPicker?.init?.(extensionContext);
  extensions.messageMedia?.init?.();

  function roomKey(room) {
    if (!room || !room.id || !room.type) return "";
    return `${room.type}:${room.id}`;
  }

  function requestedRoomFromLocation() {
    const params = new URLSearchParams(window.location.search || "");
    const channelId = params.get("channel");
    if (channelId) return { type: "channel", id: channelId };
    const threadId = params.get("thread");
    if (threadId) return { type: "thread", id: threadId };
    return null;
  }

  function currentUserId() {
    return String(state.user?.id || root.dataset.currentUserId || "");
  }

  function saveActiveScroll() {
    const cache = store.cacheFor(state.activeRoom);
    if (cache && els.messages) {
      store.saveRoomScroll(state.activeRoom, els.messages.scrollTop);
    }
  }

  function restoreScroll(cache, shouldBottom = false) {
    scheduleTransientTimeout(() => {
      if (!els.messages) return;
      if (shouldBottom) {
        els.messages.scrollTop = els.messages.scrollHeight;
        return;
      }
      if (typeof cache?.scrollTop === "number") {
        els.messages.scrollTop = cache.scrollTop;
      }
    }, 0);
  }

  function isNearBottom() {
    if (!els.messages) return true;
    const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
    return remaining < 140;
  }

  function latestMessageForRead(cache) {
    const messages = cache?.messages || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.id) return message;
    }
    return null;
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

  function focusComposerSoon() {
    if (!els.input || els.input.disabled || els.composer?.hidden) return;
    scheduleTransientTimeout(() => els.input?.focus({ preventScroll: true }), 0);
  }

  function bindEvents() {
    composer.bindEvents();
    messagesDom.bindPaneEvents();
    rooms.bindDmEvents();
    messagesDom.bindDocumentEvents();
    rooms.bindShellEvents();
    realtime.bindEvents();
  }


  const persistentCache = createPersistentChatCache();
  function schedulePersistentBootstrapSave() {
    scheduleTransientTimeout(() => { void bootstrap.persistBootstrapCache(); }, 0);
  }

  const store = createChatStore({
    state,
    identity: {
      currentUserId,
      roomKey,
    },
    scheduler: {
      scheduleTransientTimeout,
    },
    persistentCache,
  });
  const readState = createChatReadState({
    state,
    els: { announcementsUnread: els.announcementsUnread },
    config: { ANNOUNCEMENTS_CHANNEL_ID },
    fetchJson,
    feedback: { setStatus },
    identity: { roomKey, latestMessageForRead },
    store: { cacheFor: store.cacheFor },
    view: { unreadAnnouncementMessages: (...args) => messagesDom.unreadAnnouncementMessages(...args) },
    getSelectionRevision: () => rooms.selectionRevision,
    onChange: () => rooms.updateRoomLists(),
  });

  function renderPresenceDrivenUi(update) {
    rooms.applyPresenceRecords(state.presenceRecords, update);
    rooms.updateRoomLists();
    rooms.renderHeader();
    const channel = rooms.activeChannel();
    const thread = rooms.activeThread();
    if (thread) {
      profiles.renderDmProfile(thread);
    } else if (channel && !rooms.channelIsPending(channel)) {
      const users = channel.online_users || channel.active_users || [];
      const activeProfile = state.activeProfile?.id ? users.find((user) => user.id === state.activeProfile.id) : null;
      if (activeProfile) profiles.showMemberProfile(activeProfile, { preserveFocus: true });
      else profiles.renderMembers(users);
    }
    presence.renderTypingIndicator();
  }

  const messagesDom = createChatMessagesDom({
    readState: { markRoomRead: readState.markRoomRead },
    root,
    state,
    els: { announcementsRead: els.announcementsRead, announcementsUnread: els.announcementsUnread, historyLimited: els.historyLimited, joinDiscord: els.joinDiscord, memberList: els.memberList, messages: els.messages, newMessages: els.newMessages, profileBack: els.profileBack, profilePanel: els.profilePanel },
    extensions,
    config: { ANNOUNCEMENTS_CHANNEL_ID, GRAMMARLY_DISABLED_ATTRS },
    fetchJson,
    composer: {
      retryMessage: (...args) => composer.retryMessage(...args),
    },
    feedback: {
      setStatus,
    },
    identity: {
      latestMessageForRead,
      roomKey,
    },
    loading: {
      loadMessages: (...args) => loading.loadMessages(...args),
    },
    profiles: {
      profileMarkup: (...args) => profiles.profileMarkup(...args),
      renderMembers: (...args) => profiles.renderMembers(...args),
      showMemberProfile: (...args) => profiles.showMemberProfile(...args),
    },
    rooms: {
      activeChannel: (...args) => rooms.activeChannel(...args),
      closeRoomContextMenu: (...args) => rooms.closeRoomContextMenu(...args),
      toggleBlock: (...args) => rooms.toggleBlock(...args),
    },
    scheduler: {
      scheduleTransientFrame,
    },
    store: {
      cacheFor: store.cacheFor,
      removeMessageFromCaches: store.removeMessageFromCaches,
      restoreMessagesToCaches: store.restoreMessagesToCaches,
      schedulePersistentRoomSave: store.schedulePersistentRoomSave,
      saveRoomScroll: store.saveRoomScroll,
    },
    view: {
      isNearBottom,
    },
  });
  const presence = createChatPresence({
    state,
    els: { input: els.input, typing: els.typing },
    config: { PRESENCE_REFRESH_MS, PRESENCE_TAB_ID_KEY, TYPING_PRESENCE_TTL_MS },
    lifecycle: lifecycle.status,
    fetchJson,
    identity: {
      currentUserId,
      roomKey,
    },
    onUpdate: renderPresenceDrivenUi,
  });
  const profiles = createChatProfiles({
    state,
    els: { memberList: els.memberList, members: els.members, membersContext: els.membersContext, membersCount: els.membersCount, membersRestoreCount: els.membersRestoreCount, profileBack: els.profileBack, profilePanel: els.profilePanel },
    config: { GRAMMARLY_DISABLED_ATTRS },
  });
  const loading = createChatMessageLoading({
    readState: { markRoomRead: readState.markRoomRead },
    state,
    els: { messages: els.messages },
    scheduler: {
      scheduleIdle,
      schedulePersistentBootstrapSave,
      scheduleTransientTimeout,
    },
    store: {
      cacheFor: store.cacheFor,
      hydrateRoomFromPersistentCache: store.hydrateRoomFromPersistentCache,
      mergeRoomMessages: store.mergeRoomMessages,
      replaceRoomMessages: store.replaceRoomMessages,
      markRoomStale: store.markRoomStale,
    },
    rooms: {
      activeChannel: (...args) => rooms.activeChannel(...args),
      channelIsPending: (...args) => rooms.channelIsPending(...args),
      renderHeader: (...args) => rooms.renderHeader(...args),
      updateChannel: (...args) => rooms.updateChannel(...args),
      updateRoomLists: (...args) => rooms.updateRoomLists(...args),
      updateThread: (...args) => rooms.updateThread(...args),
    },
    identity: {
      roomKey,
    },
    onRoomDetails: () => renderPresenceDrivenUi(),
    view: {
      isNearBottom,
      renderApprovalNotice: messagesDom.renderApprovalNotice,
      renderMessageLoader: messagesDom.renderMessageLoader,
      renderMessages: messagesDom.renderMessages,
      restoreScroll,
      stickToBottom: messagesDom.stickToBottom,
      syncMessagesToDom: messagesDom.syncMessagesToDom,
    },
    feedback: {
      setStatus,
    },
    fetchJson,
  });
  const rooms = createChatRooms({
    readState: { unreadForRoom: readState.unreadForRoom, markRoomRead: readState.markRoomRead, setRoomUnread: readState.setRoomUnread },
    onRoomChange: presence.handleActiveRoomPresenceChange,
    onRecordsChange: () => renderPresenceDrivenUi(),
    root,
    state,
    els: { channelList: els.channelList, composer: els.composer, dmList: els.dmList, dmNew: els.dmNew, dmResults: els.dmResults, dmSearch: els.dmSearch, dmSearchInput: els.dmSearchInput, members: els.members, profileToggle: els.profileToggle, roomMeta: els.roomMeta, roomName: els.roomName, roomSymbol: els.roomSymbol },
    extensions,
    config: { ANNOUNCEMENTS_CHANNEL_ID, GRAMMARLY_DISABLED_ATTRS },
    fetchJson,
    composer: {
      setComposer: (...args) => composer.setComposer(...args),
    },
    feedback: {
      setStatus,
    },
    identity: {
      latestMessageForRead,
      roomKey,
    },
    loading: {
      loadMessages: loading.loadMessages,
      renderCachedRoom: loading.renderCachedRoom,
    },
    messageCache: {
      deltaLoadParams,
    },
    profiles: {
      memberTierBadgeMarkup: profiles.memberTierBadgeMarkup,
      renderDmProfile: profiles.renderDmProfile,
      renderMembers: profiles.renderMembers,
    },
    scheduler: {
      schedulePersistentBootstrapSave,
    },
    store: {
      cacheFor: store.cacheFor,
      hydrateRoomFromPersistentCache: store.hydrateRoomFromPersistentCache,
    },
    view: {
      closeInlineProfilePopover: messagesDom.closeInlineProfilePopover,
      focusComposerSoon,
      renderApprovalNotice: messagesDom.renderApprovalNotice,
      renderMessageLoader: messagesDom.renderMessageLoader,
      saveActiveScroll,
      setHistoryBanner: messagesDom.setHistoryBanner,
    },
  });
  const composer = createChatComposer({
    state,
    els: { composer: els.composer, input: els.input, sendButton: els.sendButton },
    extensions,
    fetchJson,
    feedback: {
      setStatus,
    },
    identity: {
      roomKey,
    },
    loading: {
      currentRoomUrl: loading.currentRoomUrl,
    },
    presence: {
      clearTypingPresence: presence.clearTypingPresence,
      refreshViewingPresence: presence.refreshViewingPresence,
      scheduleTypingPresence: presence.scheduleTypingPresence,
    },
    rooms: {
      channelIsWritable: rooms.channelIsWritable,
    },
    scheduler: {
      schedulePersistentBootstrapSave,
      scheduleTransientTimeout,
    },
    store: {
      cacheFor: store.cacheFor,
      removeMessageFromCaches: store.removeMessageFromCaches,
      mergeRoomMessages: store.mergeRoomMessages,
      updateMessageDelivery: store.updateMessageDelivery,
    },
    view: {
      renderIncomingMessages: messagesDom.renderIncomingMessages,
      renderRemovedMessage: messagesDom.renderRemovedMessage,
      patchMessageInDom: messagesDom.patchMessageInDom,
    },
  });
  const realtime = createChatRealtime({
    readState: { markRoomRead: readState.markRoomRead, refreshChatSummary: readState.refreshChatSummary, scheduleUnreadSummaryRefresh: readState.scheduleUnreadSummaryRefresh },
    state,
    config: { REALTIME_FALLBACK_MS, REALTIME_RECONNECT_MS },
    lifecycle: lifecycle.status,
    fetchJson,
    bootstrap: {
      bootstrap: (...args) => bootstrap.bootstrap(...args),
    },
    feedback: {
      playChatSound,
    },
    identity: {
      roomKey,
    },
    loading: {
      loadMessages: loading.loadMessages,
    },
    presence: {
      clearTypingPresence: presence.clearTypingPresence,
      loadInitialPresences: presence.loadInitialPresences,
      refreshViewingPresence: presence.refreshViewingPresence,
    },
    rooms: {
      fetchThread: rooms.fetchThread,
      threadExists: rooms.threadExists,
    },
    store: {
      cacheFor: store.cacheFor,
      markRoomStale: store.markRoomStale,
      removeMessageFromCaches: store.removeMessageFromCaches,
      mergeRoomMessages: store.mergeRoomMessages,
    },
    view: {
      renderIncomingMessages: messagesDom.renderIncomingMessages,
      renderRemovedMessage: messagesDom.renderRemovedMessage,
      patchMessageInDom: messagesDom.patchMessageInDom,
      updateAnnouncementsUnreadBanner: messagesDom.updateAnnouncementsUnreadBanner,
    },
  });
  const bootstrap = createChatBootstrap({
    readState: { refreshChatSummary: readState.refreshChatSummary },
    root,
    state,
    extensions,
    persistence: {
      hydrateRoomFromPersistentCache: store.hydrateRoomFromPersistentCache,
    },
    rooms: {
      registerKnownUsersFromState: rooms.registerKnownUsersFromState,
      renderHeader: rooms.renderHeader,
      selectRoom: rooms.selectRoom,
      setMembersCollapsed: rooms.setMembersCollapsed,
      updateRoomLists: rooms.updateRoomLists,
    },
    realtime: {
      startRealtimeServices: realtime.startRealtimeServices,
    },
    view: {
      renderMessageLoader: messagesDom.renderMessageLoader,
      renderMessages: messagesDom.renderMessages,
    },
    scheduler: {
      schedulePersistentBootstrapSave,
      scheduleRoomPrefetches: loading.scheduleRoomPrefetches,
    },
    feedback: {
      setStatus,
    },
    identity: {
      currentUserId,
      requestedRoomFromLocation,
      roomKey,
    },
    fetchJson,
    persistentCache,
  });

  bindEvents();
  lifecycle.register();
  presence.startPresenceRefreshTimer();
  void bootstrap.startChat();
}
