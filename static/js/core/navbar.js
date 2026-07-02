/**
 * navbar.js
 * Renders the full-width navbar with:
 * - Logo + "Nest.APStudy" title on left
 * - Search icon + user avatar on right
 * - Profile dropdown (email + Account + Sign Out)
 */

const NAVBAR_ICONS = {
  menu: materialIcon("menu"),
  search: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>`,
  account: materialIcon("account_circle"),
  signOut: materialIcon("logout"),
};

function materialIcon(name) {
  return `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
}

function avatarUrlForSize(url, size = 32) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return rawUrl;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, window.location.origin);
  } catch (error) {
    return rawUrl;
  }

  const host = parsedUrl.hostname.toLowerCase();
  const normalizedSize = Math.max(16, Math.min(Number.parseInt(size, 10) || 32, 512));

  if (host.includes('githubusercontent.com')) {
    parsedUrl.searchParams.set('s', String(normalizedSize));
    return parsedUrl.toString();
  }

  if (host.includes('discordapp.com') || host.includes('discord.com')) {
    parsedUrl.searchParams.set('size', String(nearestDiscordAvatarSize(normalizedSize)));
    return parsedUrl.toString();
  }

  if (host.includes('googleusercontent.com')) {
    return googleAvatarUrlForSize(rawUrl, normalizedSize);
  }

  if (host.includes('cloud.appwrite.io') && parsedUrl.pathname.includes('/storage/buckets/')) {
    parsedUrl.searchParams.set('width', String(normalizedSize));
    parsedUrl.searchParams.set('height', String(normalizedSize));
    return parsedUrl.toString();
  }

  return rawUrl;
}

function nearestDiscordAvatarSize(size) {
  return [16, 32, 64, 128, 256, 512]
    .reduce((closest, candidate) => (
      Math.abs(candidate - size) < Math.abs(closest - size) ? candidate : closest
    ), 32);
}

function googleAvatarUrlForSize(url, size) {
  const sizedUrl = url.replace(/([=?&]s(?:z)?=?)\d+/, `$1${size}`);
  if (sizedUrl !== url) return sizedUrl;
  return `${url}${url.includes('?') ? '&' : '?'}sz=${size}`;
}

window.APSTUDY_AVATAR_URL_FOR_SIZE = avatarUrlForSize;

function escapeHtmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function avatarImageAttrs(image, image2x) {
  const src = escapeHtmlAttr(image);
  // Data URLs are resolution-independent and may contain spaces that break
  // srcset tokenization, so emit them with src only.
  if (/^data:/i.test(String(image || ''))) {
    return `src="${src}"`;
  }
  const src2x = escapeHtmlAttr(image2x);
  return `src="${src}" srcset="${src} 1x, ${src2x} 2x"`;
}

function getCommandPaletteShortcutLabel() {
  const platform = (
    navigator.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ''
  ).toLowerCase();

  return /mac|iphone|ipad|ipod/.test(platform) ? '⌘K' : 'Ctrl+K';
}

let commandPaletteModulePromise = null;

function ensureCommandPaletteModule() {
  if (window.APSTUDY_COMMAND_PALETTE) {
    return Promise.resolve(window.APSTUDY_COMMAND_PALETTE);
  }

  if (!commandPaletteModulePromise) {
    commandPaletteModulePromise = import('/static/js/core/command-palette.js')
      .then((module) => module.commandPalette || window.APSTUDY_COMMAND_PALETTE)
      .catch((error) => {
        commandPaletteModulePromise = null;
        throw error;
      });
  }

  return commandPaletteModulePromise;
}

function openCommandPalette() {
  ensureCommandPaletteModule()
    .then((palette) => {
      if (palette && typeof palette.open === 'function') {
        palette.open();
      }
    })
    .catch((error) => {
      console.warn('Unable to open command palette.', error);
    });
}

function toggleCommandPalette() {
  ensureCommandPaletteModule()
    .then((palette) => {
      if (palette && typeof palette.toggle === 'function') {
        palette.toggle();
      }
    })
    .catch((error) => {
      console.warn('Unable to toggle command palette.', error);
    });
}

function renderNavbar() {
  const navPlaceholder = document.querySelector('global.thenav');
  if (!navPlaceholder) {
    if (document.querySelector('[data-navbar-controls]')) {
      setupNavbarInteractions('', true);
    }
    return;
  }

  const authenticated = navPlaceholder.dataset.authenticated !== 'false';
  const hasSidebar = navPlaceholder.dataset.hasSidebar !== 'false';
  const loginUrl = navPlaceholder.dataset.loginUrl || '/login';
  const rawProfileImage = navPlaceholder.dataset.profilePicture ||
    document.body?.dataset?.profilePicture ||
    'data:image/svg+xml,%3Csvg%20xmlns="http://www.w3.org/2000/svg"%20viewBox="0%200%2032%2032"%3E%3Crect%20width="32"%20height="32"%20fill="%23ccc"/%3E%3C/svg%3E';
  const profileImage = avatarUrlForSize(rawProfileImage, 48);
  const profileImage2x = avatarUrlForSize(rawProfileImage, 96);
  const profileImageAttrs = avatarImageAttrs(profileImage, profileImage2x);

  const userEmail = navPlaceholder.dataset.userEmail || 'user@example.com';
  const commandShortcut = getCommandPaletteShortcutLabel();

  const menuButton = hasSidebar ? `
    <button type="button" class="navbar-button navbar-menu-button" id="navbar-menu-btn" aria-label="Open navigation menu" aria-controls="sidebar-root" aria-expanded="false">
      ${NAVBAR_ICONS.menu}
    </button>` : '';
  const accountControls = authenticated ? `
    <button type="button" class="navbar-button navbar-search-button" id="navbar-search-btn" aria-label="Open command palette (${commandShortcut})" title="${commandShortcut}">
      ${NAVBAR_ICONS.search}
      <span class="navbar-search-tooltip" role="tooltip">${commandShortcut}</span>
    </button>
    <div class="navbar-avatar-wrapper">
      <button type="button" class="navbar-avatar" id="navbar-avatar-btn" aria-label="Profile menu" aria-haspopup="menu" aria-controls="profile-dropdown" aria-expanded="false">
        <img ${profileImageAttrs} sizes="48px" alt="Profile" width="48" height="48" decoding="async" />
      </button>
      <div id="profile-dropdown" class="profile-dropdown" role="menu">
        <div class="profile-dropdown-item email">${userEmail}</div>
        <button type="button" class="profile-dropdown-button" id="navbar-account-btn" role="menuitem">
          <span>Account</span>
          <span class="profile-dropdown-icon" aria-hidden="true">${NAVBAR_ICONS.account}</span>
        </button>
        <button type="button" class="profile-dropdown-button profile-dropdown-button--danger" id="navbar-logout-btn" role="menuitem">
          <span>Sign Out</span>
          <span class="profile-dropdown-icon" aria-hidden="true">${NAVBAR_ICONS.signOut}</span>
        </button>
      </div>
    </div>` : `
    <a class="navbar-login-button" href="${escapeHtmlAttr(loginUrl)}">Login</a>`;

  const navbarHTML = `
<div class="navbar-container" id="navbar-root">
  <div class="navbar-left">
    ${menuButton}
    <img src="https://resources.apstudy.org/images/AP-Resources-Logo.png" alt="APStudy" class="navbar-logo" width="32" height="32" decoding="async" />
    <a href="${authenticated ? '/dashboard' : '/'}" class="navbar-title">Nest.APStudy</a>
  </div>

  <div class="navbar-right">
    ${accountControls}
  </div>
</div>
  `;

  navPlaceholder.innerHTML = navbarHTML;

  // Setup navbar interactions
  setupNavbarInteractions(userEmail, authenticated);
}

function setupNavbarInteractions(userEmail, authenticated = true) {
  const avatarBtn = document.getElementById('navbar-avatar-btn');
  const dropdown = document.getElementById('profile-dropdown');
  const accountBtn = document.getElementById('navbar-account-btn');
  const logoutBtn = document.getElementById('navbar-logout-btn');
  const searchBtn = document.getElementById('navbar-search-btn');
  const menuBtn = document.getElementById('navbar-menu-btn');
  const titleLink = document.querySelector('.navbar-title');

  function syncMobileMenuButton(isOpen) {
    if (!menuBtn) return;
    menuBtn.setAttribute('aria-expanded', String(isOpen));
    menuBtn.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
  }

  window.APSTUDY_SYNC_MOBILE_NAV_BUTTON = syncMobileMenuButton;

  titleLink?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!window.APStudyNavigation?.go?.(titleLink.href)) {
      window.location.assign(titleLink.href);
    }
  });

  if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      dropdown?.classList.remove('visible');
      avatarBtn?.setAttribute('aria-expanded', 'false');
      if (typeof window.APSTUDY_TOGGLE_MOBILE_SIDEBAR === 'function') {
        window.APSTUDY_TOGGLE_MOBILE_SIDEBAR();
        return;
      }
      document.dispatchEvent(new CustomEvent('apstudy-mobile-sidebar-toggle'));
    });
  }

  if (avatarBtn && dropdown) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('visible');
      dropdown.classList.toggle('visible', !isOpen);
      avatarBtn.setAttribute('aria-expanded', String(!isOpen));
      if (!isOpen) requestAnimationFrame(() => dropdown.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (dropdown && !dropdown.contains(e.target) && !avatarBtn?.contains(e.target)) {
      dropdown.classList.remove('visible');
      avatarBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !dropdown?.classList.contains('visible')) return;
    event.preventDefault();
    dropdown.classList.remove('visible');
    avatarBtn?.setAttribute('aria-expanded', 'false');
    avatarBtn?.focus({ preventScroll: true });
  });

  // Logout button
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      runLogoutFlow();
    });
  }

  if (accountBtn) {
    accountBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.APStudyNavigation?.go?.('/settings#account')) {
        window.location.assign('/settings#account');
      }
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openCommandPalette();
    });
  }

  if (authenticated && !window.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND) {
    window.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND = true;
    document.addEventListener('keydown', (event) => {
      const key = String(event.key || '').toLowerCase();
      if (key !== 'k' || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      toggleCommandPalette();
    });
  }

  if (authenticated && document.body?.dataset?.commandPalettePreload !== 'false') {
    ensureCommandPaletteModule().catch((error) => {
      console.warn('Unable to preload command palette.', error);
    });
  }
}

// Initialize navbar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderNavbar);
} else {
  renderNavbar();
}
