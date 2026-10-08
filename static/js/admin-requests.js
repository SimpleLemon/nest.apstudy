(() => {
  const refreshTimers = new WeakMap();
  const policyHandlers = new WeakMap();
  const boundRefreshControls = new WeakSet();
  const boundTrackingLists = new WeakSet();

  function getCsrfToken(root) {
    return document.getElementById("admin-csrf-token")?.value || root?.querySelector("#admin-csrf-token")?.value || "";
  }

  function setNotice(message, isError = false, title = '') {
    if (window.APStudyToast) {
      window.APStudyToast.show({ message, title, type: isError ? "error" : "success" });
    }
  }

  function refreshMinutes(refreshSelect) {
    const value = Number(refreshSelect?.value || 5);
    return [5, 10, 30, 60].includes(value) ? value : 5;
  }

  function startRefreshTimer(root, refreshSelect) {
    if (!refreshSelect) return;
    const existing = refreshTimers.get(root);
    if (existing) {
      window.clearInterval(existing);
    }
    const minutes = refreshMinutes(refreshSelect);
    const timer = window.setInterval(() => {
      root.dispatchEvent(new CustomEvent("admin-auth:reload-section", { bubbles: true }));
    }, minutes * 60 * 1000);
    refreshTimers.set(root, timer);
  }

  function requestSectionReload() {
    document.dispatchEvent(new CustomEvent("admin-auth:reload-section", { bubbles: true }));
  }

  function initAdminCourseTracking(root) {
    const scope = root || document;
    const csrfToken = getCsrfToken(scope);
    window.initAdminTrackingTerms?.(scope);
    const trackingList = scope.querySelector("#admin-tracking-list");
    const refreshSelect = scope.querySelector("#admin-tracking-refresh");
    const previousHandler = policyHandlers.get(scope);
    if (previousHandler) scope.removeEventListener('admin-tracking:policy-saved', previousHandler);
    const policyHandler = async () => {
      try {
        const response = await fetch('/admin/auth/sections/course-tracking', { credentials: 'same-origin' });
        if (!response.ok) return;
        const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
        const replacement = parsed.querySelector('#admin-tracking-list');
        if (trackingList && replacement) trackingList.innerHTML = replacement.innerHTML;
      } catch (error) { console.error('[Admin] Could not refresh tracking groups', error); }
    };
    policyHandlers.set(scope, policyHandler);
    scope.addEventListener('admin-tracking:policy-saved', policyHandler);
    let currentRefreshMinutes = refreshMinutes(refreshSelect);

    if (refreshSelect && !boundRefreshControls.has(refreshSelect)) {
      boundRefreshControls.add(refreshSelect);
      startRefreshTimer(scope, refreshSelect);
      refreshSelect.addEventListener("change", async () => {
        const previousMinutes = currentRefreshMinutes || refreshMinutes(refreshSelect);
        const minutes = refreshMinutes(refreshSelect);
        try {
          await window.APStudyHttp.postJson("/admin/course-tracking/refresh-interval", { minutes }, csrfToken);
          currentRefreshMinutes = minutes;
          startRefreshTimer(scope, refreshSelect);
          setNotice(`Course tracking refresh set to ${minutes}m.`);
        } catch (error) {
          console.error("[Admin Course Tracking] Refresh interval update failed", error);
          refreshSelect.value = String(previousMinutes);
          currentRefreshMinutes = previousMinutes;
          startRefreshTimer(scope, refreshSelect);
          setNotice(error.message || "Try again in a moment.", true, "Couldn’t update refresh interval");
        }
      });
    }

    if (!trackingList || boundTrackingLists.has(trackingList)) return;
    boundTrackingLists.add(trackingList);
    trackingList.addEventListener("click", async (event) => {
      const groupButton = event.target.closest("[data-group-toggle]");
      const trackButton = event.target.closest("[data-track-toggle]");
      if (!groupButton && !trackButton) return;

      const button = groupButton || trackButton;
      button.disabled = true;
      try {
        if (groupButton) {
          const group = groupButton.closest("[data-track-group]");
          const enabled = groupButton.dataset.groupToggle === "true";
          await window.APStudyHttp.postJson("/admin/course-tracking/groups/toggle", {
            term: group?.dataset.term,
            subject: group?.dataset.subject,
            catalog: group?.dataset.catalog,
            crn: group?.dataset.crn || "",
            enabled,
          }, csrfToken);
          setNotice(enabled ? "Course tracking group resumed." : "Course tracking group paused.");
        } else {
          const row = trackButton.closest("[data-track-id]");
          const enabled = trackButton.dataset.trackToggle === "true";
          await window.APStudyHttp.postJson(`/admin/course-tracking/tracks/${encodeURIComponent(row?.dataset.trackId || "")}/toggle`, { enabled }, csrfToken);
          setNotice(enabled ? "Course tracking row resumed." : "Course tracking row paused.");
        }
        requestSectionReload();
      } catch (error) {
        console.error("[Admin Course Tracking] Toggle failed", error);
        setNotice(error.message || "Try again in a moment.", true, "Couldn’t update course tracking");
        button.disabled = false;
      }
    });
  }

  window.initAdminCourseTracking = initAdminCourseTracking;

  if (document.getElementById("admin-tracking-list") && !document.getElementById("admin-auth-panel")) {
    initAdminCourseTracking(document);
  }
})();
