(() => {
    const resolveLandingTheme = () => (
        window.matchMedia("(prefers-color-scheme: dark)").matches ? "nest-dark" : "parchment-light"
    );

    const applyLandingTheme = () => {
        if (typeof window.APSTUDY_SET_THEME_PREFERENCE !== "function") return;
        window.APSTUDY_SET_THEME_PREFERENCE(resolveLandingTheme(), { persist: false, silent: true });
    };

    applyLandingTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLandingTheme);
})();

(() => {
    const GA_ID = "G-0NT330ZX5L";
    window.dataLayer = window.dataLayer || [];
    function gtag() {
        window.dataLayer.push(arguments);
    }
    window.gtag = window.gtag || gtag;
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
})();

(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nav = document.querySelector("[data-landing-nav]");
    const navToggle = document.querySelector("[data-landing-nav-toggle]");
    const navMenu = document.querySelector("[data-landing-nav-menu]");
    const hero = document.querySelector(".landing-hero");

    if (navToggle && navMenu) {
        navToggle.addEventListener("click", () => {
            const open = navMenu.classList.toggle("is-open");
            navToggle.setAttribute("aria-expanded", String(open));
            navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
        });

        navMenu.addEventListener("click", (event) => {
            if (!(event.target instanceof HTMLAnchorElement)) return;
            navMenu.classList.remove("is-open");
            navToggle.setAttribute("aria-expanded", "false");
            navToggle.setAttribute("aria-label", "Open navigation");
        });
    }

    const syncNav = () => {
        nav?.classList.toggle("is-scrolled", window.scrollY > 12);
        if (hero && !reducedMotion) {
            const progress = Math.min(window.scrollY / Math.max(hero.offsetHeight, 1), 1);
            hero.style.setProperty("--hero-parallax", String(progress));
        }
    };

    syncNav();
    window.addEventListener("scroll", syncNav, { passive: true });

    const revealItems = document.querySelectorAll("[data-reveal]");
    const sketchItems = document.querySelectorAll("[data-sketch]");
    if (!reducedMotion && "IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            });
        }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
        revealItems.forEach((item) => observer.observe(item));

        const sketchObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("is-drawn");
                sketchObserver.unobserve(entry.target);
            });
        }, { threshold: 0.36, rootMargin: "0px 0px -10% 0px" });
        sketchItems.forEach((item) => sketchObserver.observe(item));
    } else {
        revealItems.forEach((item) => item.classList.add("is-visible"));
        sketchItems.forEach((item) => item.classList.add("is-drawn"));
    }
})();

(() => {
    const tabsRoot = document.querySelector("[data-landing-tabs]");
    if (!tabsRoot) return;

    const tabs = Array.from(tabsRoot.querySelectorAll("[data-landing-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-landing-panel]"));

    function activateTab(nextTab, shouldFocus = false) {
        const target = nextTab?.dataset?.landingTab;
        if (!target) return;

        tabs.forEach((tab) => {
            const selected = tab === nextTab;
            tab.classList.toggle("is-active", selected);
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });

        panels.forEach((panel) => {
            const selected = panel.dataset.landingPanel === target;
            panel.classList.toggle("is-active", selected);
            panel.hidden = !selected;
        });

        if (shouldFocus) nextTab.focus({ preventScroll: true });
    }

    tabs.forEach((tab) => {
        tab.addEventListener("click", () => activateTab(tab));
        tab.addEventListener("keydown", (event) => {
            const currentIndex = tabs.indexOf(tab);
            let nextIndex = currentIndex;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (currentIndex + 1) % tabs.length;
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
            } else if (event.key === "Home") {
                nextIndex = 0;
            } else if (event.key === "End") {
                nextIndex = tabs.length - 1;
            } else {
                return;
            }

            event.preventDefault();
            activateTab(tabs[nextIndex], true);
        });
    });
})();

(() => {
    const weekGrid = document.querySelector("[data-dashboard-week-grid]");
    if (!weekGrid) return;

    const dateCells = Array.from(weekGrid.querySelectorAll("[data-week-date]"));
    if (dateCells.length !== 7) return;

    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(today.getDate() - today.getDay());

    dateCells.forEach((cell, index) => {
        const cellDate = new Date(weekStart);
        cellDate.setDate(weekStart.getDate() + index);
        cell.textContent = String(cellDate.getDate());
        cell.classList.toggle("is-current", index === today.getDay());
        cell.setAttribute("aria-label", cellDate.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
        }));
    });

    const events = Array.from(weekGrid.querySelectorAll("i"));
    const dayClasses = ["day-monday", "day-tuesday", "day-wednesday", "day-thursday", "day-friday"];
    const colorClasses = ["event-blue", "event-orange", "event-red"];
    const slotClasses = ["event-slot-2", "event-slot-3"];
    const denseDayIndex = today.getDate() % dayClasses.length;
    const doubleDayIndex = (denseDayIndex + 2) % dayClasses.length;
    const eventPlan = dayClasses.flatMap((dayClass, dayIndex) => {
        const count = dayIndex === denseDayIndex ? 3 : dayIndex === doubleDayIndex ? 2 : 1;
        return Array.from({ length: count }, (_, slotIndex) => ({ dayClass, slotIndex }));
    });

    events.forEach((event, index) => {
        const plan = eventPlan[index];
        if (!plan) {
            event.hidden = true;
            return;
        }

        event.hidden = false;
        event.classList.remove(...dayClasses, ...colorClasses, ...slotClasses);
        event.classList.add(plan.dayClass, colorClasses[(index + today.getDay()) % colorClasses.length]);
        if (plan.slotIndex > 0) event.classList.add(slotClasses[plan.slotIndex - 1]);
