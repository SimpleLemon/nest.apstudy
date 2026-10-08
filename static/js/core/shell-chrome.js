/* global window */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function createShellChrome({ window, document, logout }) {
        function showServerToast(entry) {
            if (!entry || typeof entry !== "object") return;
            window.APStudyToast.show({
                id: entry.id,
                message: entry.message,
                title: entry.title,
                type: entry.type,
                duration: entry.duration,
                action: entry.action,
            });
        }

        function readEmbeddedServerToasts() {
            const node = document.getElementById("apstudy-server-toasts");
            if (!node) return null;
            try {
                const parsed = JSON.parse(node.textContent || "[]");
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }

        function drainServerToasts() {
            if (window.__apstudyToastsDrained) return;
            window.__apstudyToastsDrained = true;
            if (!window.APStudyToast) return;

            const embedded = readEmbeddedServerToasts();
            if (embedded !== null) {
                embedded.forEach(showServerToast);
                return;
            }
            if (typeof window.fetch !== "function") return;

            window.fetch("/api/toasts", {
                method: "GET",
                headers: { Accept: "application/json" },
                credentials: "same-origin",
                cache: "no-store",
            })
                .then((response) => (response.ok ? response.json() : null))
                .then((payload) => {
                    const toasts = Array.isArray(payload)
                        ? payload
                        : Array.isArray(payload?.toasts)
                          ? payload.toasts
                          : [];
                    toasts.forEach(showServerToast);
                })
                .catch(() => {});
        }

        function initializeGlobalChrome() {
            initializeTierBadgeTooltips();

            // Bind any links/buttons that request logout
            const logoutLinks = document.querySelectorAll("[data-logout]");
            if (logoutLinks.length) {
                logoutLinks.forEach((link) => {
                    link.addEventListener("click", (event) => {
                        event.preventDefault();
                        logout();
                    });
                });
            }

            // Render footer
            const footer = document.querySelector("global.thefooter");
            if (footer) {
                footer.innerHTML = `
        <footer class="bg-surface w-full py-12 border-t border-outline-variant/30">
            <div class="flex flex-col md:flex-row justify-between items-center px-12 max-w-7xl mx-auto">
                <span class="font-body text-xs uppercase tracking-[0.05em] font-normal text-on-surface-variant">© 2026 Nest.APStudy.org. Your work, your space, your nest.</span>
                <div class="flex flex-wrap justify-center gap-6 mt-4 md:mt-0">
                    <a class="font-body text-xs uppercase tracking-[0.05em] font-normal text-on-surface-variant hover:text-primary transition-colors" href="mailto:derek.chen@emory.edu">Support</a>
                    <a class="font-body text-xs uppercase tracking-[0.05em] font-normal text-on-surface-variant hover:text-primary transition-colors" href="/privacy-policy">Privacy</a>
                    <a class="font-body text-xs uppercase tracking-[0.05em] font-normal text-on-surface-variant hover:text-primary transition-colors" href="/terms-of-service">Terms</a>
                </div>
            </div>
        </footer>
        `;
            }
        }

        function initializeTierBadgeTooltips() {
            const interactiveBadges = () => [...document.querySelectorAll('.tier-badge-trigger:not([aria-hidden="true"])')];
            const closeBadges = (except = null) => {
                interactiveBadges().forEach((badge) => {
                    if (badge === except) return;
                    badge.classList.remove('is-tooltip-open');
                    badge.setAttribute('aria-expanded', 'false');
                });
            };

            interactiveBadges().forEach((badge) => {
                badge.setAttribute('role', 'button');
                badge.setAttribute('aria-expanded', 'false');
            });

            document.addEventListener('click', (event) => {
                const badge = event.target.closest('.tier-badge-trigger:not([aria-hidden="true"])');
                if (!badge) {
                    closeBadges();
                    return;
                }

                const willOpen = !badge.classList.contains('is-tooltip-open');
                closeBadges(badge);
                badge.classList.toggle('is-tooltip-open', willOpen);
                badge.setAttribute('aria-expanded', String(willOpen));
            });

            document.addEventListener('keydown', (event) => {
                const badge = event.target.closest?.('.tier-badge-trigger:not([aria-hidden="true"])');
                if (badge && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    badge.click();
                } else if (event.key === 'Escape') {
                    closeBadges();
                }
            });
        }

        return { drainServerToasts, initializeGlobalChrome };
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.shellChrome = Object.freeze({ createShellChrome });
})();
