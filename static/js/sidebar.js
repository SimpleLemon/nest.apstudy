/**
 * sidebar.js
 * Renders collapsible sidebar with Appwrite Console pattern
 * - Edge-aligned collapse handle on the sidebar border
 * - Left-chevron icon when expanded, right-chevron icon when collapsed
 * - Tooltips on icon hover (collapsed state only)
 */

// Appwrite-style filled SVG icons (20x20 viewBox, fill-based, no stroke)
const SIDEBAR_ICONS = {
  layoutDashboard: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M3 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4zm0 8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4zm8-8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V4zm0 8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4z"/></svg>`,
  calendarDays: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 0 0-1 1v1H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1V3a1 1 0 1 0-2 0v1H7V3a1 1 0 0 0-1-1zm0 5a1 1 0 0 0 0 2h8a1 1 0 1 0 0-2H6z" clip-rule="evenodd"/></svg>`,
  graduationCap: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10.394 2.08a1 1 0 0 0-.788 0l-7 3.5a1 1 0 0 0 0 1.84L5 8.445v3.192a1 1 0 0 0 .553.894C6.736 13.155 8.29 13.75 10 13.75c1.71 0 3.264-.594 4.447-1.219a1 1 0 0 0 .553-.894V8.445l1.5-.75v4.555a.75.75 0 0 0 1.5 0V7.17a1 1 0 0 0-.053-.22l.003-.002-7-3.5a1 1 0 0 0-.556-.368z"/></svg>`,
  folderOpen: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H2V6z"/><path fill-rule="evenodd" d="M2 9h16v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9z" clip-rule="evenodd"/></svg>`,
  notebookPen: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4zm3 2a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5H7zm0 3a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5H7zm0 3a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5H7z" clip-rule="evenodd"/></svg>`,
  messageSquare: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 5v8a2 2 0 0 1-2 2h-5l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" clip-rule="evenodd"/></svg>`,
  chevronsLeft: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0z" clip-rule="evenodd"/><path fill-rule="evenodd" d="M15.78 5.22a.75.75 0 0 1 0 1.06L12.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0z" clip-rule="evenodd"/></svg>`,
  chevronsRight: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06z" clip-rule="evenodd"/><path fill-rule="evenodd" d="M4.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L7.94 10 4.22 6.28a.75.75 0 0 1 0-1.06z" clip-rule="evenodd"/></svg>`,
  settings: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.2 1.082c.363.15.707.333 1.03.546l1.02-.382a1 1 0 0 1 1.22.434l.68 1.178a1 1 0 0 1-.24 1.238l-.82.7c.027.2.04.403.04.608 0 .205-.013.408-.04.608l.82.7a1 1 0 0 1 .24 1.238l-.68 1.178a1 1 0 0 1-1.22.434l-1.02-.382a6.01 6.01 0 0 1-1.03.546l-.2 1.082A1 1 0 0 1 10.68 13H9.32a1 1 0 0 1-.98-.804l-.2-1.082a6.01 6.01 0 0 1-1.03-.546l-1.02.382a1 1 0 0 1-1.22-.434l-.68-1.178a1 1 0 0 1 .24-1.238l.82-.7A5.13 5.13 0 0 1 5.21 7c0-.205.013-.408.04-.608l-.82-.7a1 1 0 0 1-.24-1.238l.68-1.178a1 1 0 0 1 1.22-.434l1.02.382c.323-.213.667-.396 1.03-.546l.2-1.082zM10 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" clip-rule="evenodd" transform="translate(0,3)"/></svg>`,
  search: `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9z" clip-rule="evenodd"/></svg>`,
};

function renderSidebar() {
  const sidebarPlaceholder = document.querySelector('global.thesidebar');
  if (!sidebarPlaceholder) return;

  const userDataEl = document.querySelector('[data-user-emory-student]');
  const isEmoryStudent = userDataEl?.dataset?.userEmoryStudent === 'true' || userDataEl?.dataset?.userEmoryStudent === 'True';
  const sidebarDefault = normalizeSidebarDefault(sidebarPlaceholder?.dataset?.sidebarDefault);
  const currentPath = window.location.pathname;

  const isActive = (routePath) => {
    if (routePath === '/dashboard') return currentPath === '/dashboard' || currentPath === '/';
    return currentPath === routePath;
  };

  const sidebarHTML = `
<div class="sidebar-container" id="sidebar-root">
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
        <button class="sidebar-item" data-route="/dashboard" data-courses="true" aria-label="Courses">
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
      </div>

      <!-- Other Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-label">Other</div>
        <button class="sidebar-item ${isActive('/chat') ? 'active' : ''}" data-route="/chat" aria-label="Chat">
          <span class="sidebar-item-icon">${SIDEBAR_ICONS.messageSquare}</span>
          <span class="sidebar-item-label">Chat</span>
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
  const toggleTooltip = toggleHandle?.querySelector('.sidebar-toggle-tooltip');
  const items = document.querySelectorAll('.sidebar-item');
  let collapseAnimationPending = false;

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
      const isCoursesButton = item.dataset.courses === 'true';
      const isDashboardRoute = window.location.pathname === '/dashboard' || window.location.pathname === '/';

      if (isCoursesButton && isDashboardRoute) {
        document.dispatchEvent(new Event('profile-my-courses-click'));
        return;
      }

      if (isCoursesButton && !isDashboardRoute) {
        sessionStorage.setItem('openCoursesPanelOnLoad', 'true');
        window.location.href = '/dashboard';
        return;
      }

      if (route) {
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
}

// Initialize sidebar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderSidebar);
} else {
  renderSidebar();
}
