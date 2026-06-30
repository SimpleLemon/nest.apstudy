(() => {
  const body = document.body;
  const toggle = document.querySelector("[data-admin-menu-toggle]");
  const drawer = document.getElementById("admin-sidebar-drawer");
  const scrim = document.querySelector("[data-admin-sidebar-scrim]");
  const mobileQuery = window.matchMedia("(max-width: 720px)");

  if (!body || !toggle || !drawer || !scrim) return;

  const syncDrawerAccessibility = (isOpen) => {
    if (mobileQuery.matches) {
      drawer.toggleAttribute("inert", !isOpen);
      drawer.setAttribute("aria-hidden", String(!isOpen));
      return;
    }
    drawer.removeAttribute("inert");
    drawer.removeAttribute("aria-hidden");
  };

  const setOpen = (isOpen) => {
    body.classList.toggle("admin-nav-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close admin navigation" : "Open admin navigation");
    scrim.hidden = !isOpen;
    syncDrawerAccessibility(isOpen);
  };

  toggle.addEventListener("click", () => {
    setOpen(!body.classList.contains("admin-nav-open"));
  });

  scrim.addEventListener("click", () => {
    setOpen(false);
  });

  drawer.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      setOpen(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 721px)").matches) {
      setOpen(false);
    } else {
      syncDrawerAccessibility(body.classList.contains("admin-nav-open"));
    }
  });

  setOpen(false);
})();
