import {
  els,
  state,
} from "./context.js";
import {
  avatarAttrs,
  escapeHtml,
  formatClockTime,
  formatMessageTimestamp,
  groupMessages,
  parseMessageDate,
  plural,
  registerKnownUser,
} from "./utils.js";
import {
  activeChannel,
  activeThread,
  channelIsPending,
  channelIsWritable,
  channelLabel,
  channelSymbol,
  dmPresenceStatus,
  setComposer,
  setHistoryBanner,
  setStatus,
  updateAnnouncementsUnreadBanner,
  updateHistoryBannerVisibility,
} from "./render-ui.js";
import {
  renderPresenceDrivenUi,
} from "./presence.js";

export function renderHeader() {
  const channel = activeChannel();
  const thread = activeThread();
  if (channel) {
    els.roomSymbol.classList.remove("is-avatar");
    els.roomSymbol.textContent = channelSymbol(channel);
    els.roomName.textContent = channelLabel(channel);
    els.roomMeta.textContent = channelIsPending(channel)
      ? "Waiting for admin approval"
      : `${channel.active_count || 0} active`;
    setHistoryBanner(channelIsPending(channel) ? null : channel);
    const placeholder = channelIsPending(channel)
      ? "Waiting for admin approval"
      : channel.read_only
        ? "Read-only channel"
        : `Message #${channelLabel(channel)}`;
    setComposer(channelIsWritable(channel), placeholder);
    return;
  }

  if (thread) {
    const other = thread.other_user || {};
    els.roomSymbol.classList.add("is-avatar");
    const status = dmPresenceStatus(thread);
    els.roomSymbol.innerHTML = `
      <span class="chat-room-avatar-wrap">
        <img ${avatarAttrs(other.picture_url, 48, "48px")} alt="">
        <span class="chat-presence-dot chat-presence-overlay is-${status}" aria-hidden="true"></span>
      </span>
    `;
    els.roomName.textContent = other.name || other.username || "Nest User";
    els.roomMeta.textContent = "";
    setHistoryBanner(null);
    setComposer(!thread.blocked, thread.blocked ? "This conversation is blocked" : `Message ${other.name || other.username || ""}`.trim());
    return;
  }

  els.roomSymbol.classList.remove("is-avatar");
  els.roomSymbol.textContent = "#";
  els.roomName.textContent = "Chat";
  els.roomMeta.textContent = "Loading...";
  setHistoryBanner(null);
  if (els.composer) els.composer.hidden = true;
}

export function renderApprovalNotice(channel) {
  setStatus(null);
  if (els.messages) {
    const denied = channel?.university_status === "denied";
    els.messages.innerHTML = `
      <div class="chat-empty chat-approval-state">
        <strong>${denied ? "University Channel Denied." : "Waiting Admin Approval."}</strong>
        <span>Email derek.chen@emory.edu for faster approval.</span>
      </div>
    `;
  }
  renderMembers([]);
}

export function renderMessages(messages) {
  if (!els.messages) return;
  if (!messages || !messages.length) {
    els.messages.innerHTML = `<div class="chat-message-stack"><div class="chat-empty">No messages yet.</div></div>`;
    return;
  }
  els.messages.innerHTML = `
    <div class="chat-message-stack">
      ${groupMessages(messages).map(renderMessageGroup).join("")}
    </div>
  `;
  updateAnnouncementsUnreadBanner(messages);
  updateHistoryBannerVisibility();
}

export function renderMessageGroup(group) {
  const [lead, ...continuations] = group.messages;
  return `
    <div class="chat-message-group" data-message-group="${escapeHtml(group.id)}">
      ${renderLeadMessage(lead)}
      ${continuations.map(renderContinuationMessage).join("")}
    </div>
  `;
}

export function renderDeleteButton(message) {
  if (!message.can_delete) return "";
  return `
    <button class="chat-delete" type="button" data-delete-message="${escapeHtml(message.id)}" aria-label="Delete message">
      <span class="material-symbols-outlined">delete</span>
    </button>
  `;
}

export function renderLeadMessage(message) {
  const deleteButton = message.can_delete
    ? renderDeleteButton(message)
    : "";
  return `
    <article class="chat-message" data-message-id="${escapeHtml(message.id)}">
      <button type="button" class="chat-message-avatar-button chat-author-button" data-author-message-id="${escapeHtml(message.id)}" aria-label="View ${escapeHtml(message.author_name || "author")} profile">
        <img class="chat-message-avatar" ${avatarAttrs(message.author_avatar_url, 84, "42px")} alt="">
      </button>
      <div class="chat-message-content">
        <div class="chat-message-head">
          <button type="button" class="chat-author-button" data-author-message-id="${escapeHtml(message.id)}">${escapeHtml(message.author_name || "Nest User")}</button>
          <span class="chat-message-time">${escapeHtml(formatMessageTimestamp(message.created_at))}</span>
        </div>
        <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
        ${renderImages(message.images || [])}
        ${renderPreviews(message.previews || [])}
      </div>
      ${deleteButton}
    </article>
  `;
}

export function renderContinuationMessage(message) {
  return `
    <article class="chat-message chat-message-continuation" data-message-id="${escapeHtml(message.id)}">
      <span class="chat-message-continuation-time">${escapeHtml(formatClockTime(parseMessageDate(message.created_at)))}</span>
      <div class="chat-message-content">
        <div class="chat-message-body">${message.rendered_html || escapeHtml(message.content || "")}</div>
        ${renderImages(message.images || [])}
        ${renderPreviews(message.previews || [])}
      </div>
      ${renderDeleteButton(message)}
    </article>
  `;
}

export function renderImages(images) {
  if (!images.length) return "";
  return `
    <div class="chat-message-images">
      ${images.map((image) => `
        <img
          class="chat-message-image"
          src="${escapeHtml(image.proxy_url || image.url)}"
          alt="${escapeHtml(image.filename || "Discord image")}"
          loading="lazy"
          decoding="async"
          sizes="(max-width: 640px) 92vw, 520px"
        >
      `).join("")}
    </div>
  `;
}

export function renderPreviews(previews) {
  if (!previews.length) return "";
  return previews.map((preview) => {
    const image = preview.image_url
      ? `<img src="${escapeHtml(preview.image_url)}" alt="" loading="lazy" decoding="async" sizes="(max-width: 640px) 92vw, 128px">`
      : "";
    return `
      <div class="chat-preview">
        <a href="${escapeHtml(preview.url || "#")}" target="_blank" rel="noopener noreferrer nofollow">
          <span class="chat-preview-copy">
            <strong>${escapeHtml(preview.title || preview.site_name || preview.url || "Link")}</strong>
            ${preview.site_name ? `<span>${escapeHtml(preview.site_name)}</span>` : ""}
            ${preview.description ? `<p>${escapeHtml(preview.description)}</p>` : ""}
          </span>
          ${image}
        </a>
      </div>
    `;
  }).join("");
}

export function renderMembers(users) {
  if (!els.members || !els.memberList || !els.profilePanel) return;
  els.members.classList.remove("is-dm-profile");
  const activeUsers = users || [];
  els.membersCount.textContent = plural(activeUsers.length, "user", "users");
  els.membersRestoreCount.textContent = String(activeUsers.length);
  els.profilePanel.hidden = true;
  els.profilePanel.innerHTML = "";
  if (!activeUsers.length) {
    els.memberList.innerHTML = `<div class="chat-empty chat-empty-compact">No active users.</div>`;
    return;
  }
  els.memberList.innerHTML = activeUsers.map((user) => `
    <button class="chat-member" type="button" data-profile-id="${escapeHtml(user.id)}">
      <img ${avatarAttrs(user.picture_url, 72, "36px")} alt="">
      <span>
        <strong>${escapeHtml(user.name || user.username || "Nest User")}</strong>
        <small>${escapeHtml(user.school || user.username || "Active now")}</small>
      </span>
    </button>
  `).join("");
}

export function renderDmProfile(thread) {
  if (!els.members || !els.memberList || !els.profilePanel) return;
  const other = thread?.other_user || {};
  const status = dmPresenceStatus(thread);
  els.members.classList.add("is-dm-profile");
  els.membersCount.textContent = "Profile";
  els.membersRestoreCount.textContent = status === "online" ? "1" : "0";
  els.memberList.innerHTML = "";
  els.profilePanel.hidden = false;
  els.profilePanel.innerHTML = profileMarkup(other, {
    status,
    blocked: Boolean(thread?.blocked),
    showBlock: Boolean(other.id),
  });
}

export function normalizeHexColor(value) {
  const candidate = String(value || "").trim();
  const normalized = candidate.startsWith("#") ? candidate : `#${candidate}`;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : "#fecae1";
}

export function profileDetail(label, value, className = "") {
  return `
    <div class="${className}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Not set")}</strong>
    </div>
  `;
}

export function profileMarkup(user, options = {}) {
  const status = options.status || (user?.online ? "online" : "offline");
  const handle = user?.handle || (user?.username ? `@${user.username}` : `@${user?.id || "apstudy-user"}`);
  const graduation = user?.graduation_year || user?.class_year || "";
  const memberSince = user?.member_since || "";
  const bannerColor = normalizeHexColor(user?.banner_color);
  const blockLabel = options.blocked ? "Unblock" : "Block";
  const blockAction = options.showBlock
    ? `<button type="button" data-block-user="${escapeHtml(user.id)}" data-blocked="${options.blocked ? "true" : "false"}">${blockLabel}</button>`
    : "";
  return `
    <div class="chat-profile-card">
      <div class="profile-tile" style="--profile-banner-color: ${escapeHtml(bannerColor)};">
        <div class="profile-tile-banner" aria-hidden="true"></div>
        <div class="profile-tile-body">
          <div class="profile-tile-avatar-frame">
            <img class="profile-tile-avatar" ${avatarAttrs(user?.picture_url, 150, "(max-width: 640px) 96px, 150px")} alt="${escapeHtml(user?.name || "Nest User")} avatar" width="150" height="150">
          </div>
          <div class="profile-tile-heading">
            <h3>${escapeHtml(user?.name || user?.username || "Nest User")}</h3>
            <p>${escapeHtml(handle)}</p>
            <p class="chat-presence-line chat-profile-presence">
              <span class="chat-presence-dot is-${status}" aria-hidden="true"></span>
              <span>${status === "online" ? "Online" : "Offline"}</span>
            </p>
          </div>
          <div class="profile-tile-details">
            ${profileDetail("School", user?.school, user?.is_emory_school ? "profile-tile-detail-emory" : "")}
            ${profileDetail("Major", user?.major)}
            ${profileDetail("Graduation", graduation)}
            ${profileDetail("Education", user?.education_level)}
            ${profileDetail("Member Since", memberSince, user?.is_early_member ? "profile-tile-detail-early-member" : "")}
          </div>
        </div>
      </div>
    </div>
    <div class="chat-profile-actions">
      ${user?.profile_url ? `<a href="${escapeHtml(user.profile_url)}">View profile</a>` : ""}
      ${blockAction}
    </div>
  `;
}

export function updateCurrentMembersFromPayload(payload) {
  if (payload.thread && state.activeRoom?.type === "thread" && state.activeRoom.id === payload.thread.id) {
    renderDmProfile(payload.thread);
  }
  renderPresenceDrivenUi();
}

export function updateChannel(payload) {
  if (!payload?.id) return;
  const index = state.channels.findIndex((channel) => channel.id === payload.id);
  if (index >= 0) {
    state.channels[index] = { ...state.channels[index], ...payload };
  } else {
    state.channels.push(payload);
  }
}

export function updateThread(payload) {
  if (!payload?.id) return;
  registerKnownUser(payload.other_user);
  const index = state.threads.findIndex((thread) => thread.id === payload.id);
  if (index >= 0) {
    state.threads[index] = { ...state.threads[index], ...payload };
  } else {
    state.threads.unshift(payload);
  }
  state.threads.sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
}
