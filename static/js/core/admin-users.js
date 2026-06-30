(() => {
  const table = document.querySelector(".admin-table--directory");
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

  desktopQuery.addEventListener("change", (event) => {
    if (event.matches) {
      scheduleSync();
      return;
    }
    table.querySelectorAll(".admin-table__trunc.is-truncated").forEach((cell) => {
      cell.classList.remove("is-truncated");
      cell.removeAttribute("aria-label");
    });
  });

  window.addEventListener("resize", () => {
    if (desktopQuery.matches) {
      scheduleSync();
    }
  });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(table);
  }
})();
