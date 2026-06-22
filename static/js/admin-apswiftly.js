(() => {
  const csrfToken = document.getElementById("admin-apswiftly-csrf-token")?.value || "";
  const actionButtons = Array.from(document.querySelectorAll("[data-apswiftly-action]"));
  const statusEndpoint = "/admin/apswiftly/status";
  const refreshMs = 15000;
  let requestPending = false;

  function setNotice(message, isError = false) {
    if (window.APStudyToast) {
      window.APStudyToast.show({ message, type: isError ? "error" : "success" });
    }
  }

  function setText(role, text) {
    const el = document.querySelector(`[data-apswiftly-role="${role}"]`);
    if (el) {
      el.textContent = text;
    }
  }

  async function postJson(url, body) {
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

  function syncButtons() {
    actionButtons.forEach((button) => {
      button.disabled = requestPending;
    });
  }

  function confirmValue(button) {
    const inputId = button.dataset.apswiftlyConfirmInput;
    const expected = (button.dataset.apswiftlyConfirmValue || "").trim().toUpperCase();
    if (!inputId || !expected) {
      return true;
    }
    const input = document.getElementById(inputId);
    const actual = (input?.value || "").trim().toUpperCase();
    return actual === expected;
  }

  async function refreshStatus() {
    try {
      const response = await fetch(statusEndpoint, { credentials: "same-origin" });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      setText("service-state", payload.service_state || "unknown");
      setText("api-state", payload.api_reachable ? "Reachable" : "Unreachable");
      setText("checked-at", payload.checked_at || "—");
    } catch (error) {
      console.error("[Admin APSwiftly] Status refresh failed", error);
    }
  }

  actionButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (requestPending) {
        return;
      }

      const action = button.dataset.apswiftlyAction;
      if (!action) {
        return;
      }

      if (!confirmValue(button)) {
        const expected = button.dataset.apswiftlyConfirmValue || "confirmation";
        setNotice(`Type ${expected} to confirm this action.`, true);
        return;
      }

      requestPending = true;
      syncButtons();
      try {
        const body = {};
        if (button.dataset.apswiftlyConfirmValue) {
          body.confirm = button.dataset.apswiftlyConfirmValue;
        }
        const payload = await postJson(`/admin/apswiftly/${encodeURIComponent(action)}`, body);
        setNotice(payload.message || "APSwiftly command completed.");
        const inputId = button.dataset.apswiftlyConfirmInput;
        if (inputId) {
          const input = document.getElementById(inputId);
          if (input) {
            input.value = "";
          }
        }
        await refreshStatus();
      } catch (error) {
        console.error("[Admin APSwiftly] Action failed", action, error);
        setNotice(error.message || "Unable to run APSwiftly command.", true);
      } finally {
        requestPending = false;
        syncButtons();
      }
    });
  });

  refreshStatus();
  window.setInterval(refreshStatus, refreshMs);
})();
