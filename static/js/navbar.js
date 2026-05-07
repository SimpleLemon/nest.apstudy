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

function renderNavbar() {
  const navPlaceholder = document.querySelector('global.thenav');
  if (!navPlaceholder) return;

  const profileImage = navPlaceholder.dataset.profilePicture || 
    document.body?.dataset?.profilePicture || 
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23ccc"/%3E%3C/svg%3E';
  
  const userEmail = navPlaceholder.dataset.userEmail || 'user@example.com';

  const navbarHTML = `
<div class="navbar-container" id="navbar-root">
  <div class="navbar-left">
    <img src="https://resources.apstudy.org/images/AP-Resources-Logo.png" alt="APStudy" class="navbar-logo" />
    <a href="/dashboard" class="navbar-title">Nest.APStudy</a>
  </div>
  
  <div class="navbar-right">
    <button type="button" class="navbar-button" id="navbar-search-btn" aria-label="Search" title="Search">
      ${NAVBAR_ICONS.search}
    </button>
    
    <div class="navbar-avatar-wrapper" style="position: relative;">
      <button type="button" class="navbar-avatar" id="navbar-avatar-btn" aria-label="Profile menu">
        <img src="${profileImage}" alt="Profile" />
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

  // Search button (placeholder - could open search modal)
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      console.log('Search clicked - todo: implement search modal');
    });
  }
}

// Initialize navbar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderNavbar);
} else {
  renderNavbar();
}
