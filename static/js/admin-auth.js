(() => {
  const SECTION_URLS = {
    users: "/admin/auth/sections/users",
    "course-tracking": "/admin/auth/sections/course-tracking",
    "channel-requests": "/admin/auth/sections/channel-requests",
  };

  const shell = document.getElementById("admin-auth-shell");
  const panel = document.getElementById("admin-auth-panel");
  const overlay = document.getElementById("admin-auth-overlay");
  const overlayContent = document.getElementById("admin-auth-overlay-content");
  const tabBar = document.getElementById("admin-auth-tabs");

  if (!shell || !panel || !overlay || !tabBar) return;

  const loadedSections = new Set();
  const sectionCache = new Map();
  let activeTab = document.body.dataset.initialAuthTab || "users";
  let channelStatus = "pending";
  let usersQuery = {
    q: "",
    field: "",
    sort: "created",
    order: "desc",
    page: 1,
    per_page: window.adminAuthUsersPrefs?.readStoredPerPage?.() || 10,
  };
  let loadToken = 0;
  let busy = false;

  function normalizeTab(tab) {
    return Object.prototype.hasOwnProperty.call(SECTION_URLS, tab) ? tab : "users";
  }

  function usersCacheKey() {
    return `users:${JSON.stringify(usersQuery)}`;
  }

  function sectionCacheKey(tab) {
    return tab === "users" ? usersCacheKey() : tab;
  }

  function invalidateUsersCache() {
    for (const key of [...sectionCache.keys()]) {
      if (key.startsWith("users:")) {
        sectionCache.delete(key);
      }
    }
    loadedSections.delete(usersCacheKey());
  }

  function loaderHtml(label) {
    if (window.APStudyLoader?.html) {
      return window.APStudyLoader.html(label, { sizePx: 54, textToneClass: "text-on-surface-variant" });
    }
    return `<span class="loader" style="width:54px;height:54px;" aria-hidden="true"></span><span>${label}</span>`;
  }

  function setBusy(isBusy, label = "Loading...") {
    busy = isBusy;
    shell.classList.toggle("is-busy", isBusy);
    shell.setAttribute("aria-busy", isBusy ? "true" : "false");
    if (isBusy) {
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      overlayContent.innerHTML = loaderHtml(label);
    } else {
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      overlayContent.innerHTML = "";
    }
  }

  function syncTabButtons(tab) {
    tabBar.querySelectorAll("[data-auth-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.authTab === tab);
    });
  }

  function buildSectionUrl(tab) {
    const url = new URL(SECTION_URLS[tab], window.location.origin);
    if (tab === "users") {
      if (usersQuery.q) url.searchParams.set("q", usersQuery.q);
      if (usersQuery.field) url.searchParams.set("field", usersQuery.field);
      url.searchParams.set("sort", usersQuery.sort || "created");
      url.searchParams.set("order", usersQuery.order || "desc");
      url.searchParams.set("page", String(usersQuery.page || 1));
      url.searchParams.set("per_page", String(usersQuery.per_page || 10));
    }
    if (tab === "channel-requests") {
      url.searchParams.set("status", channelStatus);
    }
    return url;
  }

  function syncUrl(tab) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    if (tab === "users") {
      if (usersQuery.q) {
        url.searchParams.set("q", usersQuery.q);
      } else {
        url.searchParams.delete("q");
      }
      if (usersQuery.field) {
        url.searchParams.set("field", usersQuery.field);
      } else {
        url.searchParams.delete("field");
      }
      url.searchParams.set("page", String(usersQuery.page || 1));
      url.searchParams.set("per_page", String(usersQuery.per_page || 10));
      url.searchParams.set("sort", usersQuery.sort || "created");
      url.searchParams.set("order", usersQuery.order || "desc");
      url.searchParams.delete("status");
    } else if (tab === "channel-requests") {
      url.searchParams.set("status", channelStatus);
      url.searchParams.delete("q");
      url.searchParams.delete("field");
      url.searchParams.delete("page");
      url.searchParams.delete("per_page");
      url.searchParams.delete("sort");
      url.searchParams.delete("order");
    } else {
      url.searchParams.delete("status");
      url.searchParams.delete("q");
      url.searchParams.delete("field");
      url.searchParams.delete("page");
      url.searchParams.delete("per_page");
      url.searchParams.delete("sort");
      url.searchParams.delete("order");
    }
    window.history.replaceState({}, "", url);
  }

  function initSection(tab, root) {
    if (tab === "users") {
      if (typeof window.initAdminAuthUsers === "function") {
        window.initAdminAuthUsers(root);
      }
      if (typeof window.initAdminUsersTable === "function") {
        window.initAdminUsersTable(root);
      }
    }
    if (tab === "course-tracking" && typeof window.initAdminCourseTracking === "function") {
      window.initAdminCourseTracking(root);
    }
    if (typeof window.AdminTimezone?.formatAdminTimestamps === "function") {
      window.AdminTimezone.formatAdminTimestamps(root);
    }
  }

  async function loadSection(tab, { force = false, label } = {}) {
    const normalizedTab = normalizeTab(tab);
    if (busy) return;

    activeTab = normalizedTab;
    syncTabButtons(activeTab);
    syncUrl(activeTab);

    const cacheKey = sectionCacheKey(normalizedTab);
    if (!force && loadedSections.has(cacheKey) && sectionCache.has(cacheKey)) {
      panel.innerHTML = sectionCache.get(cacheKey);
      initSection(normalizedTab, panel);
      return;
    }

    const token = ++loadToken;

    const loadingLabel = label || {
      users: "Loading users...",
      "course-tracking": "Loading course tracking...",
      "channel-requests": "Loading channel requests...",
    }[normalizedTab] || "Loading...";

    setBusy(true, loadingLabel);

    try {
      const response = await fetch(buildSectionUrl(normalizedTab).toString(), {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
      if (!response.ok) {
        throw new Error("Unable to load this section.");
      }
      const html = await response.text();
      if (token !== loadToken) return;

      sectionCache.set(cacheKey, html);
      loadedSections.add(cacheKey);
      panel.innerHTML = html;
      initSection(normalizedTab, panel);
    } catch (error) {
      if (token !== loadToken) return;
      panel.innerHTML = `<div class="admin-alert admin-alert--error">${error.message || "Unable to load this section."}</div>`;
    } finally {
      if (token === loadToken) {
        setBusy(false);
      }
    }
  }

  function readInitialUsersQuery() {
    const url = new URL(window.location.href);
    const page = Number(url.searchParams.get("page") || 1);
    const perPageRaw = Number(url.searchParams.get("per_page"));
    const storedPerPage = window.adminAuthUsersPrefs?.readStoredPerPage?.() || 10;
    const allowed = new Set([5, 10, 25, 50, 100]);
    usersQuery = {
      q: url.searchParams.get("q") || "",
      field: url.searchParams.get("field") || "",
      sort: url.searchParams.get("sort") || "created",
      order: url.searchParams.get("order") === "asc" ? "asc" : "desc",
      page: Number.isFinite(page) && page > 0 ? page : 1,
      per_page: allowed.has(perPageRaw) ? perPageRaw : storedPerPage,
    };
  }

  function readInitialChannelStatus() {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("status");
    if (status && ["pending", "approved", "denied", "all"].includes(status)) {
      channelStatus = status;
    }
  }

  function applyUsersQueryChange(detail = {}) {
    if (typeof detail.q === "string") {
      usersQuery.q = detail.q.trim();
      usersQuery.field = detail.field ?? "";
    }
    if (typeof detail.field === "string" && detail.q === undefined) {
      usersQuery.field = detail.field.trim();
    }
    if (typeof detail.per_page === "number") {
      usersQuery.per_page = detail.per_page;
    }
    if (typeof detail.sort === "string") {
      usersQuery.sort = detail.sort;
      usersQuery.order = detail.order === "desc" ? "desc" : "asc";
    }

    if (typeof detail.pageDelta === "number") {
      usersQuery.page = Math.max(1, (usersQuery.page || 1) + detail.pageDelta);
    } else if (typeof detail.page === "number" && detail.page > 0) {
      usersQuery.page = detail.page;
    } else if (detail.q !== undefined || detail.field !== undefined || detail.per_page !== undefined || detail.sort !== undefined) {
      usersQuery.page = 1;
    }

    invalidateUsersCache();
    loadSection("users", {
      force: true,
      label: detail.q !== undefined ? "Searching users..." : "Loading users...",
    });
  }

  tabBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-auth-tab]");
    if (!button || busy) return;
    const tab = button.dataset.authTab;
    if (!tab || tab === activeTab) return;
    loadSection(tab);
  });

  panel.addEventListener("click", (event) => {
    const statusButton = event.target.closest("[data-channel-status]");
    if (!statusButton || busy) return;
    const status = statusButton.dataset.channelStatus;
    if (!status || status === channelStatus) return;
    channelStatus = status;
    sectionCache.delete("channel-requests");
    loadedSections.delete("channel-requests");
    loadSection("channel-requests", { force: true, label: "Loading channel requests..." });
  });

  document.addEventListener("admin-auth:users-query-change", (event) => {
    if (busy) return;
    applyUsersQueryChange(event.detail || {});
  });

  document.addEventListener("admin-auth:reload-section", () => {
    if (activeTab !== "course-tracking" || busy) return;
    sectionCache.delete("course-tracking");
    loadedSections.delete("course-tracking");
    loadSection("course-tracking", { force: true, label: "Refreshing course tracking..." });
  });

  readInitialUsersQuery();
  readInitialChannelStatus();
  activeTab = normalizeTab(activeTab);
  syncTabButtons(activeTab);
  loadSection(activeTab, { force: true });
})();
