import { avatarAttrs, escapeHtml, plural, dmPresenceStatus, normalizeLocalPresenceStatus, presenceStatusLabel } from "./presentation.js";

export function createChatProfiles({ state, els, config }) {
  const { GRAMMARLY_DISABLED_ATTRS } = config;

  function renderMembers(users) {
    if (!els.members || !els.memberList || !els.profilePanel) return;
    els.members.classList.remove("is-dm-profile", "is-profile-view");
    state.activeProfile = null;
    const onlineUsers = users || [];
    if (els.membersContext) els.membersContext.textContent = "Online";
    els.membersCount.textContent = plural(onlineUsers.length, "user", "users");
    els.membersRestoreCount.textContent = String(onlineUsers.length);
    if (els.profileBack) els.profileBack.hidden = true;
    els.profilePanel.hidden = true;
    els.profilePanel.innerHTML = "";
    if (!onlineUsers.length) {
      els.memberList.innerHTML = `<div class="chat-empty chat-empty-compact" ${GRAMMARLY_DISABLED_ATTRS}>No online users.</div>`;
      return;
    }
    els.memberList.innerHTML = onlineUsers.map((user) => `
      <button class="chat-member" type="button" data-profile-id="${escapeHtml(user.id)}" aria-label="View ${escapeHtml(user.name || user.username || "Nest User")} profile${user.tier_label ? `, ${escapeHtml(user.tier_label)}` : ""}" ${GRAMMARLY_DISABLED_ATTRS}>
        <img class="chat-member-avatar" ${avatarAttrs(user.picture_url, 84, "42px")} alt="">
        <span class="chat-member-copy">
          <strong>${escapeHtml(user.name || user.username || "Nest User")}</strong>
          <small>${escapeHtml(user.school || user.username || presenceStatusLabel(user.presence_status || "active"))}</small>
        </span>
        ${memberTierBadgeMarkup(user)}
      </button>
    `).join("");
  }

  function showMemberProfile(user, options = {}) {
    if (!user || !els.members || !els.profilePanel) return;
    state.activeProfile = user;
    els.members.classList.remove("is-dm-profile");
    els.members.classList.add("is-profile-view");
    if (els.membersContext) els.membersContext.textContent = "Profile";
    els.membersCount.textContent = user.name || user.username || "Nest User";
    if (els.profileBack) els.profileBack.hidden = false;
    els.profilePanel.hidden = false;
    els.profilePanel.innerHTML = profileMarkup(user, {
      showBlock: false,
      status: user.presence_status || (user.online ? "active" : "offline"),
    });
    if (!options.preserveFocus) {
      els.profileBack?.focus({ preventScroll: true });
    }
  }

  function renderDmProfile(thread) {
    if (!els.members || !els.memberList || !els.profilePanel) return;
    const other = thread?.other_user || {};
    const status = dmPresenceStatus(thread);
    state.activeProfile = null;
    els.members.classList.remove("is-profile-view");
    els.members.classList.add("is-dm-profile");
    if (els.membersContext) els.membersContext.textContent = "Conversation";
    els.membersCount.textContent = "Profile";
    els.membersRestoreCount.textContent = status === "offline" ? "0" : "1";
    if (els.profileBack) els.profileBack.hidden = true;
    els.memberList.innerHTML = "";
    els.profilePanel.hidden = false;
    els.profilePanel.innerHTML = profileMarkup(other, {
      status,
      blocked: Boolean(thread?.blocked),
      showBlock: Boolean(other.id),
    });
  }

  function normalizeHexColor(value) {
    const candidate = String(value || "").trim();
    const normalized = candidate.startsWith("#") ? candidate : `#${candidate}`;
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : "#fecae1";
  }

  function profileDetail(label, value, className = "") {
    return `
      <div class="${className}" ${GRAMMARLY_DISABLED_ATTRS}>
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value || "Not set")}</dd>
      </div>
    `;
  }

  function tierBadgeMarkup(user, size = 24, triggerClass = "") {
    if (!user?.tier_badge?.asset || !user?.tier_label) return "";
    const className = `tier-badge-trigger${triggerClass ? ` ${triggerClass}` : ""}`;
    return `<span class="${className}" tabindex="0" role="img" aria-label="${escapeHtml(user.tier_label)}" data-tooltip="${escapeHtml(user.tier_label)}">
      <img class="tier-badge" src="${escapeHtml(user.tier_badge.asset)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">
    </span>`;
  }

  function memberTierBadgeMarkup(user) {
    if (!user?.tier_badge?.asset || !user?.tier_label) return "";
    return `<span class="tier-badge-trigger chat-member-tier" aria-hidden="true" data-tooltip="${escapeHtml(user.tier_label)}">
      <img class="tier-badge" src="${escapeHtml(user.tier_badge.asset)}" alt="" width="20" height="20" loading="lazy" decoding="async">
    </span>`;
  }

  function profileMarkup(user, options = {}) {
    const status = normalizeLocalPresenceStatus(options.status || user?.presence_status || (user?.online ? "active" : "offline"));
    const handle = user?.handle || (user?.username ? `@${user.username}` : `@${user?.id || "apstudy-user"}`);
    const graduation = user?.graduation_year || user?.class_year || "";
    const memberSince = user?.member_since || "";
    const bannerColor = normalizeHexColor(user?.banner_color);
    const tierBadge = tierBadgeMarkup(user);
    const blockLabel = options.blocked ? "Unblock" : "Block";
    const blockAction = options.showBlock
      ? `<button type="button" data-block-user="${escapeHtml(user.id)}" data-blocked="${options.blocked ? "true" : "false"}">${blockLabel}</button>`
      : "";
    return `
      <div class="chat-profile-card" ${GRAMMARLY_DISABLED_ATTRS}>
        <div class="profile-tile" style="--profile-banner-color: ${escapeHtml(bannerColor)};">
          <div class="profile-tile-banner" aria-hidden="true"></div>
          <div class="profile-tile-body">
            <div class="profile-tile-avatar-frame">
              <img class="profile-tile-avatar" ${avatarAttrs(user?.picture_url, 150, "(max-width: 640px) 96px, 150px")} alt="${escapeHtml(user?.name || "Nest User")} avatar" width="150" height="150">
              <span class="chat-presence-dot chat-presence-overlay is-${status}" role="img" aria-label="${escapeHtml(presenceStatusLabel(status))}" title="${escapeHtml(presenceStatusLabel(status))}"></span>
            </div>
            <div class="profile-tile-heading">
              <h3>${escapeHtml(user?.name || user?.username || "Nest User")}</h3>
              <div class="chat-profile-meta">
                <p class="chat-profile-handle">${escapeHtml(handle)}</p>
                <span class="chat-profile-presence-label">${escapeHtml(presenceStatusLabel(status))}</span>
              </div>
              ${tierBadge}
            </div>
            <dl class="profile-tile-details">
              ${profileDetail("School", user?.school, user?.is_emory_school ? "profile-tile-detail-emory" : "")}
              ${profileDetail("Major", user?.major)}
              ${profileDetail("Graduation", graduation)}
              ${profileDetail("Education", user?.education_level)}
              ${profileDetail("Member Since", memberSince, user?.is_early_member ? "profile-tile-detail-early-member" : "")}
            </dl>
          </div>
        </div>
      </div>
      <div class="chat-profile-actions" ${GRAMMARLY_DISABLED_ATTRS}>
        ${user?.profile_url ? `<a href="${escapeHtml(user.profile_url)}">View profile</a>` : ""}
        ${blockAction}
      </div>
    `;
  }

  return { renderMembers, showMemberProfile, renderDmProfile, memberTierBadgeMarkup, profileMarkup };
}
