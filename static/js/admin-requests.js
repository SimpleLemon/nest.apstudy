(() => {
  const csrfToken = document.getElementById("admin-csrf-token")?.value || "";
  const alertEl = document.getElementById("admin-tracking-alert");
  const testChemButton = document.getElementById("admin-test-chem-150");
  const springTrackingButton = document.getElementById("admin-spring-tracking-toggle");
  const trackingList = document.getElementById("admin-tracking-list");
  const refreshSelect = document.getElementById("admin-tracking-refresh");
  const refreshStorageKey = "adminCourseTrackingRefreshMinutes";
  const legacyRefreshStorageKey = "adminCourseTrackingRefreshSeconds";
  let refreshTimer = null;

  function setNotice(message, isError = false) {
    if (!alertEl) return;
    alertEl.textContent = message;
    alertEl.hidden = false;
    alertEl.classList.toggle("is-error", isError);
  }

  async function postJson(url, body) {
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body || {}),
    };
    requestOptions["credentials"] = "same-origin";
    const response = await fetch(url, requestOptions);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Request failed.");
    }
    return payload;
  }

  function refreshMinutes() {
    const value = Number(refreshSelect?.value || 5);
    return [5, 10, 30, 60].includes(value) ? value : 5;
  }

  function startRefreshTimer() {
    if (!refreshSelect) return;
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
    }
    refreshTimer = window.setInterval(() => {
      window.location.reload();
    }, refreshMinutes() * 60 * 1000);
  }

  if (refreshSelect) {
    const saved = Number(
      window.localStorage.getItem(refreshStorageKey)
      || window.localStorage.getItem(legacyRefreshStorageKey)
      || 5
    );
    if ([5, 10, 30, 60].includes(saved)) {
      refreshSelect.value = String(saved);
    }
    window.localStorage.setItem(refreshStorageKey, refreshSelect.value);
    startRefreshTimer();
    refreshSelect.addEventListener("change", async () => {
      const minutes = refreshMinutes();
      window.localStorage.setItem(refreshStorageKey, String(minutes));
      startRefreshTimer();
      try {
        await postJson("/admin/course-tracking/refresh-interval", { minutes });
        setNotice(`Course tracking refresh set to ${minutes}m.`);
      } catch (error) {
        console.error("[Admin Course Tracking] Refresh interval update failed", error);
        setNotice(error.message || "Unable to update refresh interval.", true);
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
      const payload = await postJson("/admin/course-tracking/test-chem-150", {});
      console.info("[Admin Course Tracking] CHEM 150 diagnostic completed", payload);
      const checked = payload.poll?.atlas_checks_attempted ?? 0;
      setNotice(`CHEM 150 ping complete: ${checked} Atlas check(s), ${payload.notifications_sent || 0} notification(s). Check the console for details.`);
    } catch (error) {
      console.error("[Admin Course Tracking] CHEM 150 diagnostic failed", error);
      setNotice(error.message || "CHEM 150 diagnostic failed.", true);
    } finally {
      testChemButton.disabled = false;
    }
  });

  springTrackingButton?.addEventListener("click", async () => {
    const enabled = springTrackingButton.dataset.enabled === "true";
    springTrackingButton.disabled = true;
    try {
      await postJson("/admin/course-tracking/spring-toggle", { enabled });
      setNotice(enabled ? "Spring course tracking is open." : "Spring course tracking is closed.");
      window.location.reload();
    } catch (error) {
      console.error("[Admin Course Tracking] Spring tracking toggle failed", error);
      setNotice(error.message || "Unable to update Spring course tracking.", true);
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
        });
        setNotice(enabled ? "Course tracking group resumed." : "Course tracking group paused.");
      } else {
        const row = trackButton.closest("[data-track-id]");
        const enabled = trackButton.dataset.trackToggle === "true";
        await postJson(`/admin/course-tracking/tracks/${encodeURIComponent(row?.dataset.trackId || "")}/toggle`, { enabled });
        setNotice(enabled ? "Course tracking row resumed." : "Course tracking row paused.");
      }
      window.location.reload();
    } catch (error) {
      console.error("[Admin Course Tracking] Toggle failed", error);
      setNotice(error.message || "Unable to update course tracking.", true);
      button.disabled = false;
    }
  });
})();
