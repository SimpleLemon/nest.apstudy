(() => {
  function initAdminUsersTable(root) {
    const scope = root || document;
    const table = scope.querySelector(".admin-table--directory");
    if (!table) return;

    const desktopQuery = window.matchMedia("(min-width: 721px)");

    const syncTruncation = () => {
      const cells = table.querySelectorAll(".admin-table__trunc");
      cells.forEach((cell) => {
        const truncated = cell.scrollWidth > cell.clientWidth + 1;
        cell.classList.toggle("is-truncated", truncated);
        if (!truncated) {
          cell.removeAttribute("aria-label");
          return;
        }
        const tooltip = cell.getAttribute("data-tooltip");
        if (tooltip) {
          cell.setAttribute("aria-label", tooltip);
        }
      });
    };

    const scheduleSync = () => {
      window.requestAnimationFrame(syncTruncation);
    };

    if (desktopQuery.matches) {
      scheduleSync();
    }

    const onDesktopChange = (event) => {
      if (event.matches) {
        scheduleSync();
        return;
      }
      table.querySelectorAll(".admin-table__trunc.is-truncated").forEach((cell) => {
        cell.classList.remove("is-truncated");
        cell.removeAttribute("aria-label");
      });
    };

    desktopQuery.addEventListener("change", onDesktopChange);

    const onResize = () => {
      if (desktopQuery.matches) {
        scheduleSync();
      }
    };

    window.addEventListener("resize", onResize);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scheduleSync);
      observer.observe(table);
    }
  }

  window.initAdminUsersTable = initAdminUsersTable;

  if (document.querySelector(".admin-table--directory") && !document.getElementById("admin-auth-panel")) {
    initAdminUsersTable(document);
  }
})();
