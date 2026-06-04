/**
 * sidebar.js
 * Renders collapsible sidebar with Appwrite Console pattern
 * - Edge-aligned collapse handle on the sidebar border
 * - Left-chevron icon when expanded, right-chevron icon when collapsed
 * - Tooltips on icon hover (collapsed state only)
 */

// Material Symbols used by dashboard tiles, plus shell controls.
const SIDEBAR_ICONS = {
  layoutDashboard: materialSymbol("grid_view"),
  calendarDays: materialSymbol("calendar_today"),
  graduationCap: materialSymbol("school"),
  folderOpen: materialSymbol("folder"),
  notebookPen: materialSymbol("article"),
  checklist: materialSymbol("check_circle"),
  messageSquare: materialSymbol("chat_bubble"),
  chevronsLeft: materialSymbol("keyboard_double_arrow_left"),
  chevronsRight: materialSymbol("keyboard_double_arrow_right"),
  settings: materialSymbol("settings"),
  search: materialSymbol("search"),
};

function materialSymbol(name) {
  return `<span class="material-symbols-outlined sidebar-material-icon" aria-hidden="true">${name}</span>`;
}

function ensureMaterialSymbolsFont() {
  const href = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,1,0";
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function renderSidebar() {
  const sidebarPlaceholder = document.querySelector('global.thesidebar');
  if (!sidebarPlaceholder) return;
  ensureMaterialSymbolsFont();

  const userDataEl = document.querySelector('[data-user-emory-student]');
  const isEmoryStudent = userDataEl?.dataset?.userEmoryStudent === 'true' || userDataEl?.dataset?.userEmoryStudent === 'True';
  const sidebarDefault = normalizeSidebarDefault(sidebarPlaceholder?.dataset?.sidebarDefault);
  const currentPath = window.location.pathname;

  const isActive = (routePath) => {
    if (routePath === '/dashboard') return currentPath === '/' || currentPath === '/dashboard';
    return currentPath === routePath;
  };

  const sidebarHTML = `
<div class="sidebar-container" id="sidebar-root" role="navigation" aria-label="Primary navigation">
  <div class="sidebar-scroll">
    <div class="sidebar-content">
      <!-- Dashboard Section -->
      <div class="sidebar-section">
        <button class="sidebar-item ${isActive('/dashboard') ? 'active' : ''}" data-route="/dashboard" aria-label="Dashboard">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.layoutDashboard}</span>
          <span class="sidebar-item-label">Dashboard</span>
        </button>
      </div>

      <!-- My Nest Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-label">My Nest</div>
        
        <button class="sidebar-item ${isActive('/calendar') ? 'active' : ''}" data-route="/calendar" aria-label="Calendar">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.calendarDays}</span>
          <span class="sidebar-item-label">Calendar</span>
        </button>

        ${isEmoryStudent ? `
        <button class="sidebar-item ${isActive('/courses') ? 'active' : ''}" data-route="/courses" aria-label="Courses">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.graduationCap}</span>
          <span class="sidebar-item-label">Courses</span>
        </button>` : ''}

        <button class="sidebar-item ${isActive('/files') ? 'active' : ''}" data-route="/files" aria-label="Files">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.folderOpen}</span>
          <span class="sidebar-item-label">Files</span>
        </button>

        <button class="sidebar-item ${isActive('/notes') ? 'active' : ''}" data-route="/notes" aria-label="Notes">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.notebookPen}</span>
          <span class="sidebar-item-label">Notes</span>
        </button>

        <button class="sidebar-item ${isActive('/tasks') ? 'active' : ''}" data-route="/tasks" aria-label="Tasks">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.checklist}</span>
          <span class="sidebar-item-label">Tasks</span>
        </button>
      </div>

      <!-- Other Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-label">Other</div>
        <button class="sidebar-item ${isActive('/chat') ? 'active' : ''}" data-route="/chat" aria-label="Chat">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.messageSquare}</span>
          <span class="sidebar-item-label">Chat</span>
          <span class="sidebar-chat-badge" data-chat-unread-badge hidden></span>
        </button>
      </div>

      <!-- Spacer -->
      <div class="sidebar-spacer"></div>
    </div>

    <!-- Settings (pinned to bottom) -->
    <div class="sidebar-settings">
      <button class="sidebar-item ${isActive('/settings') ? 'active' : ''}" data-route="/settings" aria-label="Settings">
        <span class="sidebar-item-icon">${SIDEBAR_ICONS.settings}</span>
        <span class="sidebar-item-label">Settings</span>
      </button>
    </div>
  </div>

  <button class="sidebar-toggle-handle" id="sidebar-toggle-handle" type="button" aria-label="Toggle sidebar" aria-expanded="true">
    <span class="sidebar-toggle-line" aria-hidden="true"></span>
    <span class="sidebar-toggle-icon" aria-hidden="true"></span>
    <span class="sidebar-toggle-tooltip">Collapse</span>
  </button>
</div>

<!-- Tooltip for collapsed state -->
<div class="sidebar-tooltip" id="sidebar-tooltip"></div>
<div class="sidebar-mobile-backdrop" id="sidebar-mobile-backdrop" hidden></div>
  `;

  const temp = document.createElement('div');
  temp.innerHTML = sidebarHTML;
  
  const sidebarWrapper = temp.querySelector('.sidebar-container');
  if (sidebarWrapper && !document.querySelector('.sidebar-container')) {
    document.body.insertAdjacentElement('afterbegin', sidebarWrapper);
    document.body.classList.add('with-sidebar');
  }

  const tooltip = temp.querySelector('.sidebar-tooltip');
  if (tooltip && !document.querySelector('.sidebar-tooltip')) {
    document.body.appendChild(tooltip);
  }

  const backdrop = temp.querySelector('.sidebar-mobile-backdrop');
  if (backdrop && !document.querySelector('.sidebar-mobile-backdrop')) {
    document.body.appendChild(backdrop);
  }

  setupSidebarInteractions(sidebarDefault);
}

function normalizeSidebarDefault(value) {
  return String(value || '').trim().toLowerCase() === 'collapsed' ? 'collapsed' : 'expanded';
}

function setupSidebarInteractions(sidebarDefault = 'expanded') {
  const sidebar = document.querySelector('.sidebar-container');
  if (!sidebar) return;

  const toggleHandle = document.getElementById('sidebar-toggle-handle');
  const tooltip = document.getElementById('sidebar-tooltip');
  const backdrop = document.getElementById('sidebar-mobile-backdrop');
  const toggleTooltip = toggleHandle?.querySelector('.sidebar-toggle-tooltip');
  const items = document.querySelectorAll('.sidebar-item');
  const mobileQuery = window.matchMedia('(max-width: 1024px)');
  let collapseAnimationPending = false;

  function isMobileShell() {
    return mobileQuery.matches;
  }

  function syncMobileNavButton(isOpen) {
    if (typeof window.APSTUDY_SYNC_MOBILE_NAV_BUTTON === 'function') {
      window.APSTUDY_SYNC_MOBILE_NAV_BUTTON(isOpen);
      return;
    }

    const menuButton = document.getElementById('navbar-menu-btn');
    if (!menuButton) return;
    menuButton.setAttribute('aria-expanded', String(isOpen));
    menuButton.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
  }

  function setMobileSidebarOpen(isOpen) {
    const shouldOpen = Boolean(isOpen) && isMobileShell();
    sidebar.classList.toggle('mobile-open', shouldOpen);
    document.body.classList.toggle('mobile-sidebar-open', shouldOpen);
    if (backdrop) {
      backdrop.hidden = !shouldOpen;
    }
    sidebar.setAttribute('aria-hidden', shouldOpen || !isMobileShell() ? 'false' : 'true');
    syncMobileNavButton(shouldOpen);
    if (!shouldOpen && tooltip) tooltip.classList.remove('visible');
  }

  function toggleMobileSidebar() {
    setMobileSidebarOpen(!sidebar.classList.contains('mobile-open'));
  }

  window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = setMobileSidebarOpen;
  window.APSTUDY_TOGGLE_MOBILE_SIDEBAR = toggleMobileSidebar;

  document.addEventListener('apstudy-mobile-sidebar-toggle', toggleMobileSidebar);

  if (backdrop) {
    backdrop.addEventListener('click', () => setMobileSidebarOpen(false));
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('mobile-open')) {
      setMobileSidebarOpen(false);
    }
  });

  const handleShellSizeChange = () => {
    if (!isMobileShell()) {
      setMobileSidebarOpen(false);
      sidebar.setAttribute('aria-hidden', 'false');
    } else {
      sidebar.setAttribute('aria-hidden', sidebar.classList.contains('mobile-open') ? 'false' : 'true');
    }
  };
  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', handleShellSizeChange);
  } else if (typeof mobileQuery.addListener === 'function') {
    mobileQuery.addListener(handleShellSizeChange);
  }

  function updateToggleHandleState() {
    if (!toggleHandle) return;
    const isCollapsed = sidebar.classList.contains('collapsed');
    const toggleIcon = toggleHandle.querySelector('.sidebar-toggle-icon');
    if (toggleIcon) {
      toggleIcon.innerHTML = isCollapsed ? SIDEBAR_ICONS.chevronsRight : SIDEBAR_ICONS.chevronsLeft;
    }
    toggleHandle.setAttribute('aria-expanded', String(!isCollapsed));
    toggleHandle.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    if (toggleTooltip) {
      toggleTooltip.textContent = isCollapsed ? 'Expand' : 'Collapse';
    }
  }

  function setCenteredCollapsedItems(shouldCenter) {
    sidebar.classList.toggle('collapsed-aligned', shouldCenter);
  }

  sidebar.addEventListener('transitionend', (event) => {
    if (event.propertyName !== 'width') return;
    if (!sidebar.classList.contains('collapsed')) {
      setCenteredCollapsedItems(false);
      collapseAnimationPending = false;
      return;
    }

    if (collapseAnimationPending) {
      setCenteredCollapsedItems(true);
      collapseAnimationPending = false;
    }
  });

  function applySidebarCollapsedState(shouldCollapse) {
    if (shouldCollapse) {
      sidebar.classList.add('collapsed');
      setCenteredCollapsedItems(false);
      collapseAnimationPending = true;
    } else {
      sidebar.classList.remove('collapsed');
      setCenteredCollapsedItems(false);
      collapseAnimationPending = false;
    }

    document.body.classList.toggle('sidebar-collapsed', shouldCollapse);
    localStorage.setItem('sidebar-collapsed', String(shouldCollapse));
    updateToggleHandleState();
  }

  // Load per-session state first. On a fresh login, localStorage is cleared,
  // so the server-rendered Appwrite preference becomes the default.
  const storedCollapsed = localStorage.getItem('sidebar-collapsed');
  const isCollapsed = storedCollapsed === null
    ? normalizeSidebarDefault(sidebarDefault) === 'collapsed'
    : storedCollapsed === 'true';
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);
  if (isCollapsed) {
    sidebar.classList.add('collapsed');
    setCenteredCollapsedItems(true);
  }
  localStorage.setItem('sidebar-collapsed', String(isCollapsed));
  updateToggleHandleState();

  window.APSTUDY_SET_SIDEBAR_COLLAPSED = applySidebarCollapsedState;
  document.addEventListener('apstudy-sidebar-default-change', (event) => {
    applySidebarCollapsedState(event.detail?.collapsed === true);
  });

  // Collapse button click
  if (toggleHandle) {
    toggleHandle.addEventListener('click', (e) => {
      e.preventDefault();
      const shouldCollapse = !sidebar.classList.contains('collapsed');
      applySidebarCollapsedState(shouldCollapse);
      if (tooltip) tooltip.classList.remove('visible');
    });
  }

  // Navigation items
  items.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const route = item.dataset.route;
      if (route) {
        setMobileSidebarOpen(false);
        window.location.href = route;
      }
    });

    // Tooltips on hover (collapsed state only)
    item.addEventListener('mouseenter', () => {
      if (!sidebar.classList.contains('collapsed')) return;
      
      const label = item.querySelector('.sidebar-item-label')?.textContent || '';
      if (!label) return;

      const rect = item.getBoundingClientRect();
      tooltip.textContent = label;
      tooltip.classList.add('visible');
      
      // Position tooltip to the right of the icon
      const tooltipWidth = tooltip.offsetWidth;
      tooltip.style.left = (rect.right + 12) + 'px';
      tooltip.style.top = (rect.top + rect.height / 2 - tooltip.offsetHeight / 2) + 'px';
    });

    item.addEventListener('mouseleave', () => {
      if (tooltip) tooltip.classList.remove('visible');
    });
  });

  // Hide tooltip on sidebar mouseleave
  sidebar.addEventListener('mouseleave', () => {
    if (tooltip) tooltip.classList.remove('visible');
  });

  setMobileSidebarOpen(false);
  setupChatSummaryBadge();
}

function setupChatSummaryBadge() {
  const badge = document.querySelector('[data-chat-unread-badge]');
  if (!badge) return;
  const nav = document.querySelector('global.thenav');
  if (!nav || !nav.hasAttribute('data-user-email')) return;
  const pollMs = 120000;
  let timer = null;
  let inFlight = false;

  function renderBadge(payload = {}) {
    const count = Number(payload.total_unread || 0);
    const capped = payload.unread_capped === true;
    badge.hidden = count <= 0;
    if (count <= 0) {
      badge.textContent = '';
      badge.removeAttribute('aria-label');
      return;
    }
    const label = capped ? '99+' : String(Math.min(count, 99));
    badge.textContent = label;
    badge.setAttribute('aria-label', `${label} unread chat message${label === '1' ? '' : 's'}`);
  }

  function schedule(delay = pollMs) {
    window.clearTimeout(timer);
    if (document.visibilityState === 'hidden') return;
    timer = window.setTimeout(refresh, delay);
  }

  async function refresh() {
    if (inFlight || document.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      const response = await fetch('/api/chat/summary', {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        renderBadge(await response.json());
      }
    } catch (_) {
      // The next visible-tab interval will try again.
    } finally {
      inFlight = false;
      schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedule(1000);
    } else {
      window.clearTimeout(timer);
    }
  });
  window.addEventListener('apstudy-chat-read-state-change', () => schedule(1000));
  schedule(2500);
}

// Initialize sidebar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderSidebar);
} else {
  renderSidebar();
}
