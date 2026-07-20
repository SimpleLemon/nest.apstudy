(() => {
  const refreshTimers = new WeakMap();

  function getCsrfToken(root) {
    return document.getElementById("admin-csrf-token")?.value || root?.querySelector("#admin-csrf-token")?.value || "";
  }

  function setNotice(message, isError = false, title = '') {
    if (window.APStudyToast) {
      window.APStudyToast.show({ message, title, type: isError ? "error" : "success" });
    }
  }

  async function postJson(url, body, csrfToken) {
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
    };
    const response = await fetch(url, requestOptions);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Request failed.");
    }
    return payload;
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
    const alertEl = scope.querySelector("#admin-tracking-alert");
    const testChemButton = scope.querySelector("#admin-test-chem-150");
    const springTrackingButton = scope.querySelector("#admin-spring-tracking-toggle");
    const trackingList = scope.querySelector("#admin-tracking-list");
    const refreshSelect = scope.querySelector("#admin-tracking-refresh");
    let currentRefreshMinutes = refreshMinutes(refreshSelect);

    if (refreshSelect) {
      startRefreshTimer(scope, refreshSelect);
      refreshSelect.addEventListener("change", async () => {
        const previousMinutes = currentRefreshMinutes || refreshMinutes(refreshSelect);
        const minutes = refreshMinutes(refreshSelect);
        try {
          await postJson("/admin/course-tracking/refresh-interval", { minutes }, csrfToken);
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

    testChemButton?.addEventListener("click", async () => {
      testChemButton.disabled = true;
      console.info("[Admin Course Tracking] Starting Fall_2026 CHEM 150 diagnostic", {
        term: "Fall_2026",
        subject: "CHEM",
        catalog: "150",
      });
      try {
        const payload = await postJson("/admin/course-tracking/test-chem-150", {}, csrfToken);
        console.info("[Admin Course Tracking] CHEM 150 diagnostic completed", payload);
        const checked = payload.poll?.atlas_checks_attempted ?? 0;
        setNotice(`CHEM 150 ping complete: ${checked} Atlas check(s), ${payload.notifications_sent || 0} notification(s). Check the console for details.`);
      } catch (error) {
        console.error("[Admin Course Tracking] CHEM 150 diagnostic failed", error);
        setNotice(error.message || "Try again in a moment.", true, "Couldn’t run CHEM 150 diagnostic");
      } finally {
        testChemButton.disabled = false;
      }
    });

    springTrackingButton?.addEventListener("click", async () => {
      const enabled = springTrackingButton.dataset.enabled === "true";
      springTrackingButton.disabled = true;
      try {
        await postJson("/admin/course-tracking/spring-toggle", { enabled }, csrfToken);
        setNotice(enabled ? "Spring course tracking is open." : "Spring course tracking is closed.");
        requestSectionReload();
      } catch (error) {
        console.error("[Admin Course Tracking] Spring tracking toggle failed", error);
        setNotice(error.message || "Try again in a moment.", true, "Couldn’t update Spring tracking");
        springTrackingButton.disabled = false;
      }
    });

    trackingList?.addEventListener("click", async (event) => {
      const groupButton = event.target.closest("[data-group-toggle]");
      const trackButton = event.target.closest("[data-track-toggle]");
      if (!groupButton && !trackButton) return;

      const button = groupButton || trackButton;
      button.disabled = true;
      try {
        if (groupButton) {
          const group = groupButton.closest("[data-track-group]");
          const enabled = groupButton.dataset.groupToggle === "true";
          await postJson("/admin/course-tracking/groups/toggle", {
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
          await postJson(`/admin/course-tracking/tracks/${encodeURIComponent(row?.dataset.trackId || "")}/toggle`, { enabled }, csrfToken);
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
