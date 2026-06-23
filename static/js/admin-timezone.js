(() => {
  function adminTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  function parseTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatAdminTimestamp(value, options = {}) {
    const date = parseTimestamp(value);
    if (!date) return value || "--";
    const mode = options.mode || "datetime";
    const base = {
      timeZone: options.timeZone || adminTimezone(),
      month: "short",
      day: "numeric",
      year: "numeric",
    };
    if (mode !== "date") {
      base.hour = "numeric";
      base.minute = "2-digit";
    }
    return new Intl.DateTimeFormat(undefined, base).format(date);
  }

  function formatAdminTimestamps(root = document) {
    root.querySelectorAll("[data-admin-timestamp]").forEach((el) => {
      const value = el.getAttribute("data-admin-timestamp") || "";
      if (!value) return;
      el.textContent = formatAdminTimestamp(value, { mode: el.dataset.adminTimestampMode || "datetime" });
      el.title = value;
    });
  }

  window.AdminTimezone = {
    adminTimezone,
    formatAdminTimestamp,
    formatAdminTimestamps,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => formatAdminTimestamps());
  } else {
    formatAdminTimestamps();
  }
})();
