// Shared chat state and constants. Loaded only by the chat page.
export const root = document.querySelector(".chat-app");

export const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2096%2096'%3E%3Crect%20width='96'%20height='96'%20rx='24'%20fill='%23e5e7eb'/%3E%3Ccircle%20cx='48'%20cy='35'%20r='17'%20fill='%239ca3af'/%3E%3Cpath%20d='M20%2082c4-18%2017-28%2028-28s24%2010%2028%2028'%20fill='%239ca3af'/%3E%3C/svg%3E";

export const PRESENCE_APP_ID = "nest-chat";

export const VIEWING_PRESENCE_REFRESH_MS = 45000;

export const VIEWING_PRESENCE_TTL_MS = 90000;

export const TYPING_PRESENCE_TTL_MS = 8000;

export const CHAT_TAB_ID_KEY = "apstudy-chat-tab-id";

export const ROOM_SCROLL_RESTORE_DELAY = 0;

export const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;

export const DISCORD_HISTORY_CHANNEL_IDS = new Set(["nest_announcements", "nest_chat"]);

export const CHAT_CACHE_DB_NAME = "apstudy-chat-cache";

export const CHAT_CACHE_DB_VERSION = 1;

export const CHAT_CACHE_STORE = "items";

export const CHAT_CACHE_SCHEMA = "v1";

export const CHAT_CACHE_MESSAGE_LIMIT = 50;

export const CHAT_PREFETCH_ROOM_LIMIT = 8;

export const REALTIME_FALLBACK_MS = 5000;

export const ANNOUNCEMENTS_CHANNEL_ID = "nest_announcements";

export const state = {
  user: root.dataset.currentUserId ? { id: root.dataset.currentUserId } : null,
  settings: { chat_sound_enabled: true },
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
  presenceUnsubscribe: null,
  presenceReady: false,
  presenceConnecting: false,
  presenceRecords: new Map(),
  knownUsers: new Map(),
  resolvingPresenceUsers: new Set(),
  lastViewingPresenceId: null,
  lastTypingPresenceId: null,
  tabId: null,
  searchTimer: null,
  scrollSaveTimer: null,
  realtimeUnsubscribe: null,
  realtimeReady: false,
  realtimeConnecting: false,
  chatSummaryLoading: false,
  localReadSeq: 0,
  contextMenuRoom: null,
  loadingMessages: false,
  roomReadState: null,
  announcementsBannerVisible: false,
  membersCollapsed: sessionStorage.getItem("apstudy-chat-members-collapsed") === "true",
  hydratedFromPersistentCache: false,
  persistentCacheReady: false,
  serverBootstrapped: false,
  prefetchingRooms: new Set(),
};

window.NestChat = state;

export const els = {
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
  members: document.getElementById("chat-members"),
  memberList: document.getElementById("chat-member-list"),
  membersCount: document.getElementById("chat-members-count"),
  membersRestoreCount: document.getElementById("chat-members-restore-count"),
  profilePanel: document.getElementById("chat-profile-panel"),
  profileToggle: document.querySelector("[data-toggle-members]"),
  audio: document.getElementById("chat-audio"),
};
