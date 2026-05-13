/**
 * navbar.js
 * Renders the full-width navbar with:
 * - Logo + "Nest.APStudy" title on left
 * - Search icon + user avatar on right
 * - Profile dropdown (email + Account + Sign Out)
 */

const NAVBAR_ICONS = {
  search: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>`,
  account: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5"><path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-6.5 9a6.5 6.5 0 0 1 13 0 .75.75 0 0 1-.75.75h-11.5A.75.75 0 0 1 3.5 17z"/></svg>`,
  signOut: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5"><path fill-rule="evenodd" d="M3 4.25A2.25 2.25 0 0 1 5.25 2H10a2.25 2.25 0 0 1 2.25 2.25v.75H11V4.25A.75.75 0 0 0 10.25 3.5H5.25a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5a.75.75 0 0 0 .75-.75V15h1.25v.75A2.25 2.25 0 0 1 10 18H5.25A2.25 2.25 0 0 1 3 15.75V4.25z" clip-rule="evenodd"/><path fill-rule="evenodd" d="M8 10a.75.75 0 0 1 .75-.75h7.19l-1.72-1.72a.75.75 0 1 1 1.06-1.06l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 1 1-1.06-1.06l1.72-1.72H8.75A.75.75 0 0 1 8 10z" clip-rule="evenodd"/></svg>`,
};

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
    <a href="/calendar" class="navbar-title">Nest.APStudy</a>
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
