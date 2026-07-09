(() => {
  const COLUMN_STORAGE_KEY = "nest-admin-auth-user-columns-v2";
  const PER_PAGE_STORAGE_KEY = "nest-admin-auth-users-per-page";
  const ALLOWED_PER_PAGE = new Set([5, 10, 25, 50, 100]);
  const DEFAULT_COLUMNS = ["identity", "status", "profile", "activity", "created"];
  const AVAILABLE_COLUMNS = ["identity", "status", "profile", "activity", "created", "id"];

  function readStoredColumns() {
    try {
      const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (!raw) return [...DEFAULT_COLUMNS];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_COLUMNS];
      const filtered = parsed.filter((key) => AVAILABLE_COLUMNS.includes(key));
      return filtered.length ? filtered : [...DEFAULT_COLUMNS];
    } catch {
      return [...DEFAULT_COLUMNS];
    }
  }

  function writeStoredColumns(columns) {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
  }

  function readStoredPerPage() {
    const raw = Number(localStorage.getItem(PER_PAGE_STORAGE_KEY));
    return ALLOWED_PER_PAGE.has(raw) ? raw : 10;
  }

  function writeStoredPerPage(value) {
    localStorage.setItem(PER_PAGE_STORAGE_KEY, String(value));
  }

  function dispatchUsersQueryChange(partial) {
    document.dispatchEvent(new CustomEvent("admin-auth:users-query-change", {
      detail: partial,
      bubbles: true,
    }));
  }

  let activeColumnsWrap = null;

  function closeColumnsMenu(wrap, restoreFocus = false) {
    const target = wrap || activeColumnsWrap;
    if (!target) return;
    const trigger = target.querySelector("[data-auth-columns-trigger]");
    const menu = target.querySelector("[data-auth-columns-menu]");
    if (!trigger || !menu) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (activeColumnsWrap === target) {
      activeColumnsWrap = null;
    }
    if (restoreFocus) {
      trigger.focus();
    }
  }

  if (!window.__adminAuthUsersColumnsBound) {
    window.__adminAuthUsersColumnsBound = true;
    document.addEventListener("click", (event) => {
      if (!activeColumnsWrap) return;
      if (!activeColumnsWrap.contains(event.target)) {
        closeColumnsMenu(activeColumnsWrap);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeColumnsMenu(activeColumnsWrap, true);
    });
  }

  function applyColumnVisibility(root, visibleColumns) {
    const visible = new Set(visibleColumns);
    visible.add("identity");
    root.querySelectorAll("[data-column]").forEach((cell) => {
      const key = cell.getAttribute("data-column");
      cell.hidden = !visible.has(key);
    });

    const countEl = root.querySelector("[data-auth-columns-count]");
    if (countEl) countEl.textContent = String(visible.size);

    root.querySelectorAll("[data-auth-column-toggle]").forEach((input) => {
      input.checked = visible.has(input.value);
    });
  }

  function initAdminAuthUsers(root) {
    const scope = root || document;
    const section = scope.querySelector("[data-auth-users-section]");
    if (!section) return;

    let visibleColumns = Array.from(new Set([...readStoredColumns(), "identity"]));
    applyColumnVisibility(section, visibleColumns);

    const columnsWrap = section.querySelector(".admin-auth-columns-wrap");
    const columnsTrigger = section.querySelector("[data-auth-columns-trigger]");
    const columnsMenu = section.querySelector("[data-auth-columns-menu]");
    const searchForm = section.querySelector("[data-auth-users-search]");
    const searchInput = section.querySelector("[data-auth-users-search-input]");
    const searchField = section.querySelector("[data-auth-users-search-field]");
    const clearSearchButton = section.querySelector("[data-auth-users-clear-search]");
    const perPageSelect = section.querySelector("[data-auth-users-per-page]");

    columnsTrigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!columnsMenu) return;
      const willOpen = columnsMenu.hidden;
      if (willOpen) {
        closeColumnsMenu(activeColumnsWrap);
        activeColumnsWrap = columnsWrap;
      }
      columnsMenu.hidden = !willOpen;
      columnsTrigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (!willOpen) {
        activeColumnsWrap = null;
      }
    });

    columnsMenu?.addEventListener("change", (event) => {
      const input = event.target.closest("[data-auth-column-toggle]");
      if (!input) return;

      const key = input.value;
      const next = new Set(visibleColumns);
      if (input.checked) {
        next.add(key);
      } else {
        if (next.size < 1) {
          input.checked = true;
          return;
        }
        next.delete(key);
      }

      visibleColumns = [...next];
      writeStoredColumns(visibleColumns);
      applyColumnVisibility(section, visibleColumns);
      if (typeof window.initAdminUsersTable === "function") {
        window.initAdminUsersTable(section);
      }
    });

    columnsMenu?.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    searchForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const q = String(searchInput?.value || "").trim();
      const field = String(searchField?.value || "").trim();
      dispatchUsersQueryChange({ q, page: 1, field });
    });

    clearSearchButton?.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      if (searchField) searchField.value = "";
      dispatchUsersQueryChange({ q: "", page: 1, field: "" });
    });

    perPageSelect?.addEventListener("change", () => {
      const perPage = Number(perPageSelect.value);
      if (!ALLOWED_PER_PAGE.has(perPage)) return;
      writeStoredPerPage(perPage);
      dispatchUsersQueryChange({ per_page: perPage, page: 1 });
    });

    section.addEventListener("click", (event) => {
      const pageButton = event.target.closest("[data-auth-users-page]");
      if (!pageButton || pageButton.disabled) return;
      const direction = pageButton.dataset.authUsersPage;
      if (direction === "prev") {
        dispatchUsersQueryChange({ pageDelta: -1 });
      } else if (direction === "next") {
        dispatchUsersQueryChange({ pageDelta: 1 });
      }
    });
  }

  window.initAdminAuthUsers = initAdminAuthUsers;
  window.adminAuthUsersPrefs = {
    readStoredPerPage,
    readStoredColumns,
  };
})();
