(() => {
  const csrfToken = document.getElementById("admin-apswiftly-csrf-token")?.value || "";
  const actionButtons = Array.from(document.querySelectorAll("[data-apswiftly-action]"));
  const statusEndpoint = "/admin/apswiftly/status";
  const log = document.querySelector("[data-apswiftly-log]");
  const refreshMs = 15000;
  let requestPending = false;

  function setNotice(message, isError = false, title = '') {
    if (window.APStudyToast) {
      window.APStudyToast.show({ message, title, type: isError ? "error" : "success" });
    }
  }

  function appendLog(message, isError = false) {
    if (!log) return;
    const line = document.createElement("span");
    if (isError) line.classList.add("is-error");
    const timestamp = document.createElement("time");
    timestamp.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    line.append(timestamp, document.createTextNode(message));
    log.append(line);
    while (log.children.length > 6) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  function setText(role, text) {
    const el = document.querySelector(`[data-apswiftly-role="${role}"]`);
    if (el) {
      el.textContent = text;
    }
  }

  function formatServiceState(state) {
    const normalized = (state || "unknown").trim().toLowerCase();
    if (normalized === "unknown") {
      return "Unknown";
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function formatCheckedAt(iso) {
    if (!iso) {
      return "—";
    }

    const checkedAt = new Date(iso);
    if (Number.isNaN(checkedAt.getTime())) {
      return "—";
    }

    const totalSeconds = Math.max(0, Math.floor((Date.now() - checkedAt.getTime()) / 1000));
    if (totalSeconds > 5 * 86400) {
      return checkedAt.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }

    const hours = totalSeconds / 3600;
    if (hours < 48) {
      if (hours < 1) {
        const minutes = Math.max(1, Math.floor(totalSeconds / 60));
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
      }
      const hourCount = Math.max(1, Math.floor(hours));
      return `${hourCount} hour${hourCount === 1 ? "" : "s"} ago`;
    }

    const dayCount = Math.max(1, Math.floor(totalSeconds / 86400));
    return `${dayCount} day${dayCount === 1 ? "" : "s"} ago`;
  }

  function updateCheckedAt(iso) {
    const el = document.querySelector('[data-apswiftly-role="checked-at"]');
    if (!el) {
      return;
    }
    el.dataset.apswiftlyCheckedAt = iso || "";
    el.textContent = formatCheckedAt(iso);
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
      setText("service-state", payload.service_state_display || formatServiceState(payload.service_state));
      setText("api-state", payload.api_reachable ? "Reachable" : "Unreachable");
      updateCheckedAt(payload.checked_at);
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
      appendLog(` $ ${action}`);
      try {
        const body = {};
        if (button.dataset.apswiftlyConfirmValue) {
          body.confirm = button.dataset.apswiftlyConfirmValue;
        }
        const payload = await postJson(`/admin/apswiftly/${encodeURIComponent(action)}`, body);
        setNotice(payload.message || "APSwiftly command completed.");
        appendLog(` ✓ ${payload.message || "Command completed."}`);
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
        setNotice(error.message || "Try again in a moment.", true, "Couldn’t run APSwiftly command");
        appendLog(` ! ${error.message || "Command failed."}`, true);
      } finally {
        requestPending = false;
        syncButtons();
      }
    });
  });

  refreshStatus();
  window.setInterval(refreshStatus, refreshMs);
})();
