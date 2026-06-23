/**
 * Apply sidebar collapse preference before first paint.
 * Load in <head> on pages with the main shell sidebar, after setting:
 *   window.APSTUDY_SIDEBAR_DEFAULT = "expanded" | "collapsed"
 */
(function () {
  var STORAGE_KEY = 'sidebar-collapsed';
  var HTML_CLASS = 'apstudy-sidebar-collapsed';

  function normalizeSidebarDefault(value) {
    return String(value || '').trim().toLowerCase() === 'collapsed' ? 'collapsed' : 'expanded';
  }

  function resolveSidebarCollapsed(sidebarDefault) {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === null) {
        return normalizeSidebarDefault(sidebarDefault) === 'collapsed';
      }
      return stored === 'true';
    } catch (error) {
      console.warn('Sidebar init: unable to read saved collapse state.', error);
      return normalizeSidebarDefault(sidebarDefault) === 'collapsed';
    }
  }

  function syncHtmlCollapsedClass(shouldCollapse) {
    document.documentElement.classList.toggle(HTML_CLASS, shouldCollapse);
  }

  window.APSTUDY_NORMALIZE_SIDEBAR_DEFAULT = normalizeSidebarDefault;
  window.APSTUDY_RESOLVE_SIDEBAR_COLLAPSED = resolveSidebarCollapsed;
  window.APSTUDY_SYNC_SIDEBAR_COLLAPSED_HTML = syncHtmlCollapsedClass;

  var sidebarDefault = window.APSTUDY_SIDEBAR_DEFAULT
    || document.documentElement.dataset.apstudySidebarDefault
    || 'expanded';
  syncHtmlCollapsedClass(resolveSidebarCollapsed(sidebarDefault));
})();
