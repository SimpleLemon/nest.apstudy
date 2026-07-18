/**
 * sidebar.js
 * Renders collapsible sidebar with Appwrite Console pattern
 * - Edge-aligned collapse handle on the sidebar border
 * - Left-chevron icon when expanded, right-chevron icon when collapsed
 * - Tooltips on icon hover (collapsed state only)
 */

(() => {
if (window.APStudySidebarLoaded) return;
window.APStudySidebarLoaded = true;

const SIDEBAR_ICONS = {
  collapse: sidebarSvgIcon("M12.707 5.293a1 1 0 0 1 0 1.414L9.415 10l3.292 3.293a1 1 0 0 1-1.414 1.414l-4-4a1 1 0 0 1 0-1.414l4-4a1 1 0 0 1 1.414 0"),
  expand: sidebarSvgIcon("M7.293 14.707a1 1 0 0 1 0-1.414L10.586 10 7.293 6.707a1 1 0 1 1 1.414-1.414l4 4a1 1 0 0 1 0 1.414l-4 4a1 1 0 0 1-1.414 0"),
};

function materialSymbol(name) {
  return `<span class="material-symbols-outlined sidebar-material-icon" aria-hidden="true">${name}</span>`;
}

function sidebarSvgIcon(path) {
  return `<svg class="sidebar-toggle-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path fill="currentcolor" fill-rule="evenodd" d="${path}" clip-rule="evenodd"></path></svg>`;
}

function initSidebar() {
  const sidebar = document.querySelector('.sidebar-container');
  if (!sidebar) return;

  document.body.classList.add('with-sidebar');
  const sidebarDefault = normalizeSidebarDefault(sidebar?.dataset?.sidebarDefault);
  setupSidebarInteractions(sidebarDefault);
}

function normalizeSidebarDefault(value) {
  if (typeof window.APSTUDY_NORMALIZE_SIDEBAR_DEFAULT === 'function') {
    return window.APSTUDY_NORMALIZE_SIDEBAR_DEFAULT(value);
  }
  return String(value || '').trim().toLowerCase() === 'collapsed' ? 'collapsed' : 'expanded';
}

function resolveSidebarCollapsed(sidebarDefault) {
  if (typeof window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED === 'function') {
    return window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED(sidebarDefault);
  }
  const storedCollapsed = localStorage.getItem('sidebar-collapsed');
  if (storedCollapsed === null) {
    return normalizeSidebarDefault(sidebarDefault) === 'collapsed';
  }
  return storedCollapsed === 'true';
}

function syncSidebarCollapsedHtmlClass(shouldCollapse) {
  if (typeof window.APSTUDY_SYNC_SIDEBAR_COLLAPSED_HTML === 'function') {
    window.APSTUDY_SYNC_SIDEBAR_COLLAPSED_HTML(shouldCollapse);
    return;
  }
  document.documentElement.classList.toggle('apstudy-sidebar-collapsed', shouldCollapse);
}

function setupSidebarInteractions(sidebarDefault = 'expanded') {
  const sidebar = document.querySelector('.sidebar-container');
  if (!sidebar) return;

  const toggleHandle = document.getElementById('sidebar-toggle-handle');
  const mobileToggle = document.querySelector('[data-sidebar-mobile-toggle]');
  const tooltip = document.getElementById('sidebar-tooltip');
  const backdrop = document.getElementById('sidebar-mobile-backdrop');
  const toggleTooltip = toggleHandle?.querySelector('.sidebar-toggle-tooltip');
  const items = document.querySelectorAll('.sidebar-item');
  const mobileQuery = window.matchMedia('(max-width: 1024px)');

  function isMobileShell() {
    return mobileQuery.matches;
  }

  function syncMobileNavButton(isOpen) {
    if (typeof window.APSTUDY_SYNC_MOBILE_NAV_BUTTON === 'function') {
      window.APSTUDY_SYNC_MOBILE_NAV_BUTTON(isOpen);
      return;
    }

    const menuButton = document.getElementById('navbar-menu-btn') || mobileToggle;
    if (!menuButton) return;
    menuButton.setAttribute('aria-expanded', String(isOpen));
    menuButton.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
  }

  function setMobileSidebarOpen(isOpen) {
    const shouldOpen = Boolean(isOpen) && isMobileShell();
    const wasOpen = sidebar.classList.contains('mobile-open');
    const menuButton = document.getElementById('navbar-menu-btn') || mobileToggle;
    sidebar.classList.toggle('mobile-open', shouldOpen);
    document.body.classList.toggle('mobile-sidebar-open', shouldOpen);
    if (backdrop) {
      backdrop.hidden = !shouldOpen;
    }
    sidebar.setAttribute('aria-hidden', shouldOpen || !isMobileShell() ? 'false' : 'true');
    sidebar.toggleAttribute('inert', isMobileShell() && !shouldOpen);
    if (shouldOpen) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => sidebar.querySelector('.sidebar-item, button, a[href]')?.focus({ preventScroll: true }));
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      window.APStudyAccessibility?.syncDialogs?.();
      if (wasOpen && menuButton?.isConnected) menuButton.focus({ preventScroll: true });
    }
    syncMobileNavButton(shouldOpen);
    if (!shouldOpen && tooltip) tooltip.classList.remove('visible');
  }

  function toggleMobileSidebar() {
    setMobileSidebarOpen(!sidebar.classList.contains('mobile-open'));
  }

  window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN = setMobileSidebarOpen;
  window.APSTUDY_TOGGLE_MOBILE_SIDEBAR = toggleMobileSidebar;

  document.addEventListener('apstudy-mobile-sidebar-toggle', toggleMobileSidebar);

  if (mobileToggle) {
    mobileToggle.addEventListener('click', (event) => {
      event.preventDefault();
      toggleMobileSidebar();
    });
  }

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
      sidebar.removeAttribute('inert');
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
      toggleIcon.innerHTML = isCollapsed ? SIDEBAR_ICONS.expand : SIDEBAR_ICONS.collapse;
    }
    toggleHandle.setAttribute('aria-expanded', String(!isCollapsed));
    toggleHandle.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    if (toggleTooltip) {
      toggleTooltip.textContent = isCollapsed ? 'Expand' : 'Collapse';
    }
  }

  function applySidebarCollapsedState(shouldCollapse) {
    sidebar.classList.toggle('collapsed', shouldCollapse);
    document.body.classList.toggle('sidebar-collapsed', shouldCollapse);
    syncSidebarCollapsedHtmlClass(shouldCollapse);
    localStorage.setItem('sidebar-collapsed', String(shouldCollapse));
    updateToggleHandleState();
  }

  // Load per-session state first. On a fresh login, localStorage is cleared,
  // so the server-rendered preference becomes the default.
  const isCollapsed = resolveSidebarCollapsed(sidebarDefault);
  applySidebarCollapsedState(isCollapsed);

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
      const route = item.dataset.route;
      setMobileSidebarOpen(false);
      if (route) {
        e.preventDefault();
        if (!window.APStudyNavigation?.go?.(route)) {
          window.location.assign(route);
        }
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
  const idleMs = 300000;
  let timer = null;
  let inFlight = false;
  let paused = false;
  let disposed = false;
  let requestController = null;
  let lastActivityAt = Date.now();

  function isIdle() {
    return Date.now() - lastActivityAt >= idleMs;
  }

  function renderBadge(payload = {}) {
    const roomCount = Array.isArray(payload.rooms)
      ? payload.rooms.reduce((total, room) => {
          const hasUnread = room?.has_unread === true || Number(room?.unread_count || 0) > 0;
          return hasUnread ? total + Number(room?.unread_count || 0) : total;
        }, 0)
      : null;
    const count = Number(roomCount ?? payload.total_unread ?? 0);
    const capped = payload.unread_capped === true || count >= 99;
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
    timer = null;
    if (paused || disposed || document.visibilityState === 'hidden' || isIdle()) return;
    const activeForMs = Date.now() - lastActivityAt;
    const untilIdleMs = Math.max(0, idleMs - activeForMs);
    timer = window.setTimeout(refresh, Math.min(delay, untilIdleMs));
  }

  async function refresh() {
    if (paused || disposed || inFlight || document.visibilityState === 'hidden' || isIdle()) return;
    inFlight = true;
    requestController = new AbortController();
    try {
      const response = await fetch('/api/chat/summary', {
        headers: { Accept: 'application/json' },
        signal: requestController.signal,
      });
      if (response.ok) {
        renderBadge(await response.json());
      }
    } catch (error) {
      void error;
      // The next visible-tab interval will try again.
    } finally {
      requestController = null;
      inFlight = false;
      schedule();
    }
  }

  function pausePolling() {
    if (disposed) return;
    paused = true;
    window.clearTimeout(timer);
    timer = null;
    requestController?.abort();
  }

  function resumePolling() {
    if (disposed || !paused) return;
    paused = false;
    lastActivityAt = Date.now();
    schedule(1000);
  }

  function disposePolling() {
    pausePolling();
    disposed = true;
  }

  function markActive() {
    const wasIdle = isIdle();
    lastActivityAt = Date.now();
    if (wasIdle && document.visibilityState === 'visible') schedule(1000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastActivityAt = Date.now();
      schedule(1000);
    } else {
      window.clearTimeout(timer);
      timer = null;
    }
  });
  document.addEventListener('pointerdown', markActive, { passive: true });
  document.addEventListener('keydown', markActive);
  window.addEventListener('apstudy-chat-read-state-change', () => {
    markActive();
    schedule(1000);
  });
  window.addEventListener('apstudy-chat-summary', (event) => {
    renderBadge(event.detail || {});
    schedule();
  });
  window.APStudyPageLifecycle?.register?.({
    pause: pausePolling,
    resume: resumePolling,
    dispose: disposePolling,
  });
  schedule(2500);
}

// Initialize sidebar when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebar);
} else {
  initSidebar();
}
})();
