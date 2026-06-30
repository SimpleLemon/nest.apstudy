import {
  PRESENCE_APP_ID,
  els,
  state,
} from "./context.js";
import {
  currentUserId,
  knownPresenceScopeKeys,
  parseMessageDate,
  presenceScopeKey,
  registerKnownUser,
  registerKnownUsersFromState,
  roomKey,
  roomPresenceScope,
  roomTarget,
} from "./utils.js";
import {
  fetchJson,
  schedulePersistentBootstrapSave,
} from "./cache.js";
import {
  activeChannel,
  activeThread,
  channelIsPending,
  setStatus,
  updateRoomLists,
} from "./render-ui.js";
import {
  renderDmProfile,
  renderHeader,
  renderMembers,
  updateThread,
} from "./render-messages.js";

export async function fetchThread(threadId) {
  if (!threadId) return null;
  try {
    const payload = await fetchJson(`/api/chat/dm/threads/${encodeURIComponent(threadId)}`);
    if (payload.thread) {
      updateThread(payload.thread);
      updateRoomLists();
      renderPresenceDrivenUi();
      schedulePersistentBootstrapSave();
      return payload.thread;
    }
  } catch (error) {
    setStatus(error.message || "Unable to load direct message.", "error");
  }
  return null;
}

export function normalizePresenceMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch (_) {
      return {};
    }
  }
  return metadata;
}

export function presenceUserId(record) {
  return String(record?.userId || record?.user_id || record?.userInternalId || "");
}

export function presenceExpiresAt(record) {
  return parseMessageDate(record?.expiresAt || record?.expires_at);
}

export function presenceIsExpired(record) {
  const expiresAt = presenceExpiresAt(record);
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

export function normalizePresenceRecord(record) {
  if (!record) return null;
  const metadata = normalizePresenceMetadata(record.metadata);
  if (metadata.app !== PRESENCE_APP_ID) return null;
  const scopeKey = presenceScopeKey(metadata);
  if (!scopeKey || !knownPresenceScopeKeys().has(scopeKey)) return null;
  const userId = presenceUserId(record);
  if (!userId || presenceIsExpired(record)) return null;
  return {
    ...record,
    userId,
    status: record.status || "",
    metadata,
  };
}

export function presenceAction(response) {
  const events = response?.events || [];
  if (events.some((event) => String(event).endsWith(".delete") || String(event).includes(".delete"))) return "delete";
  if (events.some((event) => String(event).endsWith(".update") || String(event).includes(".update"))) return "update";
  if (events.some((event) => String(event).endsWith(".upsert") || String(event).includes(".upsert"))) return "upsert";
  return "upsert";
}

export function applyPresenceRecord(record, action = "upsert") {
  const presenceId = String(record?.$id || record?.id || "");
  if (!presenceId) return;
  if (action === "delete") {
    state.presenceRecords.delete(presenceId);
    return;
  }
  const normalized = normalizePresenceRecord(record);
  if (normalized) {
    state.presenceRecords.set(presenceId, normalized);
  } else {
    state.presenceRecords.delete(presenceId);
  }
}

export function pruneExpiredPresences() {
  for (const [presenceId, record] of state.presenceRecords.entries()) {
    if (presenceIsExpired(record)) state.presenceRecords.delete(presenceId);
  }
}

export function presenceRecordsForScope(scopeType, scopeId, kind = "viewing") {
  pruneExpiredPresences();
  const key = `${scopeType}:${scopeId}`;
  return Array.from(state.presenceRecords.values()).filter((record) => {
    const metadata = record.metadata || {};
    if (presenceScopeKey(metadata) !== key) return false;
    if (kind === "viewing") return metadata.kind === "viewing" && record.status === "online";
    if (kind === "typing") return metadata.kind === "typing" && record.status === "typing";
    return false;
  });
}

export function presenceUserIdsForScope(scopeType, scopeId, kind = "viewing") {
  const ids = [];
  for (const record of presenceRecordsForScope(scopeType, scopeId, kind)) {
    const userId = presenceUserId(record);
    if (userId && !ids.includes(userId)) ids.push(userId);
  }
  return ids;
}

export function onlineUserIds() {
  pruneExpiredPresences();
  const ids = new Set();
  for (const record of state.presenceRecords.values()) {
    if (record.status === "online" && record.metadata?.kind === "viewing") {
      ids.add(presenceUserId(record));
    }
  }
  return ids;
}

export function usersForPresenceScope(scopeType, scopeId) {
  return presenceUserIdsForScope(scopeType, scopeId, "viewing")
    .map((userId) => state.knownUsers.get(userId) || { id: userId, name: "Nest User" });
}

export function typingUsersForActiveRoom() {
  const scope = roomPresenceScope(state.activeRoom);
  if (!scope) return [];
  return presenceUserIdsForScope(scope.scope_type, scope.scope_id, "typing")
    .filter((userId) => userId !== currentUserId())
    .map((userId) => state.knownUsers.get(userId) || { id: userId, name: "Someone" });
}

export function renderTypingIndicator() {
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

export function renderPresenceDrivenUi() {
  registerKnownUsersFromState();
  const onlineIds = onlineUserIds();
  for (const channel of state.channels) {
    const scope = channel.presence_scope || { scope_type: "channel", scope_id: channel.id };
    const users = usersForPresenceScope(scope.scope_type, scope.scope_id);
    channel.active_users = users;
    channel.active_count = users.length;
    for (const user of users) registerKnownUser(user);
  }
  for (const thread of state.threads) {
    const other = thread.other_user || {};
    const isOnline = Boolean(other.id && onlineIds.has(String(other.id)));
    thread.presence_status = isOnline ? "online" : "offline";
    other.online = isOnline;
    const scope = thread.presence_scope || { scope_type: "thread", scope_id: thread.id };
    thread.active_count = presenceUserIdsForScope(scope.scope_type, scope.scope_id, "viewing").length;
  }
  updateRoomLists();
  renderHeader();
  const channel = activeChannel();
  const thread = activeThread();
  if (thread) {
    renderDmProfile(thread);
  } else if (channel && !channelIsPending(channel)) {
    renderMembers(channel.active_users || []);
  }
  renderTypingIndicator();
  void resolvePresenceUsersForActiveRoom();
}

export async function resolvePresenceUsersForActiveRoom() {
  const room = state.activeRoom;
  const target = roomTarget(room);
  const scope = roomPresenceScope(room);
  if (!room || !target?.presence_profile_resolve_allowed || !scope) return;
  const unknownIds = presenceUserIdsForScope(scope.scope_type, scope.scope_id, "viewing")
    .concat(presenceUserIdsForScope(scope.scope_type, scope.scope_id, "typing"))
    .filter((userId, index, all) => all.indexOf(userId) === index)
    .filter((userId) => !state.knownUsers.has(userId));
  if (!unknownIds.length) return;
  const resolveKey = `${scope.scope_type}:${scope.scope_id}:${unknownIds.sort().join(",")}`;
  if (state.resolvingPresenceUsers.has(resolveKey)) return;
  state.resolvingPresenceUsers.add(resolveKey);
  try {
    const payload = await fetchJson("/api/chat/presence/users", {
      method: "POST",
      body: JSON.stringify({
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        user_ids: unknownIds,
      }),
    });
    for (const user of payload.users || []) registerKnownUser(user);
    if (roomKey(state.activeRoom) === roomKey(room)) renderPresenceDrivenUi();
  } catch (error) {
    void error;
    // Profile resolution is best-effort; presence counts can still render.
  } finally {
    state.resolvingPresenceUsers.delete(resolveKey);
  }
}

export function currentRoomUrl(room, params = {}) {
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
