/*
 * Early shared browser lifecycle and navigation bootstrap. Templates load this
 * before global.js so feature modules can register cleanup consistently.
 */

(() => {
  if (window.APStudyPageLifecycle) return;

  const registrations = new Set();
  let pageState = 'active';

  function invoke(entry, hookName) {
    const hook = entry?.hooks?.[hookName];
    if (typeof hook !== 'function') return;
    try {
      hook();
    } catch (error) {
      console.error(`APStudy page lifecycle ${hookName} hook failed`, error);
    }
  }

  function pauseEntry(entry) {
    if (entry.disposed || entry.paused) return;
    entry.paused = true;
    invoke(entry, 'pause');
  }

  function resumeEntry(entry) {
    if (entry.disposed || !entry.paused) return;
    entry.paused = false;
    invoke(entry, 'resume');
  }

  function disposeEntry(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.paused = false;
    invoke(entry, 'dispose');
  }

  function register(hooks = {}) {
    const entry = {
      hooks: hooks && typeof hooks === 'object' ? hooks : {},
      paused: false,
      disposed: false,
    };

    if (pageState === 'disposed') {
      disposeEntry(entry);
      return () => {};
    }

    registrations.add(entry);
    if (pageState === 'paused') pauseEntry(entry);

    return () => {
      registrations.delete(entry);
    };
  }

  function handlePageHide(event) {
    if (event.persisted) {
      if (pageState === 'paused') return;
      pageState = 'paused';
      registrations.forEach(pauseEntry);
      return;
    }

    if (pageState === 'disposed') return;
    pageState = 'disposed';
    registrations.forEach(disposeEntry);
    registrations.clear();
  }

  function handlePageShow(event) {
    if (!event.persisted || pageState !== 'paused') return;
    pageState = 'active';
    registrations.forEach(resumeEntry);
  }

  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
  window.APStudyPageLifecycle = {
    register,
    state: () => pageState,
  };
})();

(() => {
  if (window.APStudyNavigation) return;

  function currentPageShouldBeDiscarded() {
    return document.body?.dataset?.navigationRetention === 'discard';
  }

  function resolveUrl(rawUrl) {
    try {
      return new URL(String(rawUrl || ''), window.location.href);
    } catch (_error) {
      return null;
    }
  }

  function go(rawUrl, options = {}) {
    const url = resolveUrl(rawUrl);
    if (!url) return false;

    const sameOrigin = url.origin === window.location.origin;
    const replace = typeof options.replace === 'boolean'
      ? options.replace
      : sameOrigin && currentPageShouldBeDiscarded();

    if (replace) {
      window.location.replace(url.href);
    } else {
      window.location.assign(url.href);
    }
    return true;
  }

  function shouldInterceptAnchor(event, anchor) {
    if (!currentPageShouldBeDiscarded() || event.defaultPrevented) return false;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (!anchor || anchor.hasAttribute('download') || anchor.dataset.noAppNavigation === 'true') return false;
    const target = String(anchor.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self') return false;

    const url = resolveUrl(anchor.href);
    if (!url || url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) return false;
    const current = resolveUrl(window.location.href);
    if (current && url.pathname === current.pathname && url.search === current.search && url.hash) return false;
    return true;
  }

  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!shouldInterceptAnchor(event, anchor)) return;
    event.preventDefault();
    go(anchor.href);
  });

  window.APStudyNavigation = {
    go,
    shouldDiscardCurrentPage: currentPageShouldBeDiscarded,
  };
})();
