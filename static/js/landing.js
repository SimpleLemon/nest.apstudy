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
    if (!reducedMotion && "IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            });
        }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
        revealItems.forEach((item) => observer.observe(item));
    } else {
        revealItems.forEach((item) => item.classList.add("is-visible"));
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
