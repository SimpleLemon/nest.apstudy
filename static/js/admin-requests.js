(() => {
  const csrfToken = document.getElementById("admin-csrf-token")?.value || "";
  const alertEl = document.getElementById("admin-tracking-alert");
  const testChemButton = document.getElementById("admin-test-chem-150");
  const trackingList = document.getElementById("admin-tracking-list");

  function setNotice(message, isError = false) {
    if (!alertEl) return;
    alertEl.textContent = message;
    alertEl.hidden = false;
    alertEl.classList.toggle("is-error", isError);
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Request failed.");
    }
    return payload;
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
