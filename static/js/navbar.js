/**
 * navbar.js
 * Renders the full-width navbar with:
 * - Logo + "Nest.APStudy" title on left
 * - Search icon + user avatar on right
 * - Profile dropdown (email + Account + Sign Out)
 */

const NAVBAR_ICONS = {
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
    commandPaletteModulePromise = import('/static/js/command-palette.js')
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
  if (!navPlaceholder) return;

  const profileImage = avatarUrlForSize(navPlaceholder.dataset.profilePicture || 
    document.body?.dataset?.profilePicture || 
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" fill="%23ccc"/%3E%3C/svg%3E', 32);
  
  const userEmail = navPlaceholder.dataset.userEmail || 'user@example.com';
  const commandShortcut = getCommandPaletteShortcutLabel();

  const navbarHTML = `
<div class="navbar-container" id="navbar-root">
  <div class="navbar-left">
    <img src="https://resources.apstudy.org/images/AP-Resources-Logo.png" alt="APStudy" class="navbar-logo" />
    <a href="/dashboard" class="navbar-title">Nest.APStudy</a>
  </div>
  
  <div class="navbar-right">
    <button type="button" class="navbar-button navbar-search-button" id="navbar-search-btn" aria-label="Open command palette (${commandShortcut})" title="${commandShortcut}">
      ${NAVBAR_ICONS.search}
      <span class="navbar-search-tooltip" role="tooltip">${commandShortcut}</span>
    </button>
    
    <div class="navbar-avatar-wrapper">
      <button type="button" class="navbar-avatar" id="navbar-avatar-btn" aria-label="Profile menu">
        <img src="${profileImage}" alt="Profile" width="32" height="32" decoding="async" />
      </button>
      
      <div id="profile-dropdown" class="profile-dropdown">
        <div class="profile-dropdown-item email">${userEmail}</div>
        <button type="button" class="profile-dropdown-button" id="navbar-account-btn">
          <span>Account</span>
          <span class="profile-dropdown-icon" aria-hidden="true">${NAVBAR_ICONS.account}</span>
        </button>
        <button type="button" class="profile-dropdown-button profile-dropdown-button--danger" id="navbar-logout-btn">
          <span>Sign Out</span>
          <span class="profile-dropdown-icon" aria-hidden="true">${NAVBAR_ICONS.signOut}</span>
        </button>
      </div>
    </div>
  </div>
</div>
  `;

  navPlaceholder.innerHTML = navbarHTML;

  // Setup navbar interactions
  setupNavbarInteractions(userEmail);
}

function setupNavbarInteractions(userEmail) {
  const avatarBtn = document.getElementById('navbar-avatar-btn');
  const dropdown = document.getElementById('profile-dropdown');
  const accountBtn = document.getElementById('navbar-account-btn');
  const logoutBtn = document.getElementById('navbar-logout-btn');
  const searchBtn = document.getElementById('navbar-search-btn');

  if (avatarBtn && dropdown) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('visible');
      dropdown.classList.toggle('visible', !isOpen);
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (dropdown && !dropdown.contains(e.target) && !avatarBtn?.contains(e.target)) {
      dropdown.classList.remove('visible');
    }
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
      window.location.href = '/settings#account';
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openCommandPalette();
    });
  }

  if (!window.APSTUDY_COMMAND_PALETTE_SHORTCUT_BOUND) {
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

  ensureCommandPaletteModule().catch((error) => {
    console.warn('Unable to preload command palette.', error);
  });
}

// Initialize navbar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderNavbar);
} else {
  renderNavbar();
}
