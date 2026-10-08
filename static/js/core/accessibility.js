/* global window, MutationObserver */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function installAccessibility({ window, document }) {
        const FOCUSABLE_SELECTOR = [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled]):not([type='hidden'])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            "summary",
            "[contenteditable='true']",
            "[tabindex]:not([tabindex='-1'])",
        ].join(",");
        const modalRecords = new Map();
        const managedInertElements = new Set();
        let activeDialog = null;

        function isRendered(element) {
            if (!element?.isConnected || element.closest("[hidden]")) return false;
            const style = window.getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
        }

        function focusableElements(dialog) {
            return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
                if (!isRendered(element) || element.closest("[inert]")) return false;
                return element.getAttribute("aria-hidden") !== "true";
            });
        }

        function activateDialog(dialog, previousFocus = null) {
            if (!dialog || modalRecords.has(dialog)) return;
            const candidate = previousFocus && !dialog.contains(previousFocus)
                ? previousFocus
                : document.activeElement && !dialog.contains(document.activeElement)
                    ? document.activeElement
                    : null;
            const replaced = Array.from(modalRecords).find(([previous, record]) => (
                !previous.isConnected && record.parent === dialog.parentElement
            ))?.[1];
            const returnFocus = (!candidate?.isConnected || candidate === document.body)
                ? replaced?.previousFocus || candidate
                : candidate;
            modalRecords.set(dialog, { previousFocus: returnFocus, parent: dialog.parentElement });
            if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
        }

        function syncModalInertness(dialog) {
            for (const element of managedInertElements) element.removeAttribute("inert");
            managedInertElements.clear();
            if (!dialog) return;

            let branch = dialog;
            while (branch?.parentElement) {
                const parent = branch.parentElement;
                for (const sibling of parent.children) {
                    if (sibling === branch || sibling.hasAttribute("inert")) continue;
                    if (sibling.matches("[data-event-close], [data-discord-modal-close], .calendar-event-backdrop, [class*='backdrop']")) continue;
                    sibling.setAttribute("inert", "");
                    managedInertElements.add(sibling);
                }
                if (parent === document.body) break;
                branch = parent;
            }
        }

        function syncDialogs() {
            const visible = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).filter(isRendered);
            visible.forEach((dialog) => activateDialog(dialog));
            activeDialog = visible.at(-1) || null;
            syncModalInertness(activeDialog);

            for (const [dialog, record] of modalRecords) {
                if (visible.includes(dialog)) continue;
                modalRecords.delete(dialog);
                const focused = document.activeElement;
                if ((!focused || focused === document.body || dialog.contains(focused))
                    && record.previousFocus?.isConnected
                    && (!activeDialog || activeDialog.contains(record.previousFocus))) {
                    record.previousFocus.focus?.({ preventScroll: true });
                }
            }
        }

        function installSkipLink() {
            const main = document.querySelector("main");
            if (!main || document.querySelector(".apstudy-skip-link")) return;
            if (!main.id) main.id = "main-content";
            if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
            const link = document.createElement("a");
            link.className = "apstudy-skip-link";
            link.href = `#${main.id}`;
            link.textContent = "Skip to main content";
            document.body.prepend(link);
        }

        document.addEventListener("focusin", (event) => {
            const dialog = event.target?.closest?.('[role="dialog"][aria-modal="true"]');
            if (dialog && isRendered(dialog)) {
                activateDialog(dialog, event.relatedTarget);
                activeDialog = dialog;
                return;
            }
            if (activeDialog?.matches('[role="dialog"][aria-modal="true"]') && isRendered(activeDialog)) {
                const target = focusableElements(activeDialog)[0] || activeDialog;
                target.focus?.({ preventScroll: true });
            }
        }, true);

        document.addEventListener("keydown", (event) => {
            const menu = event.target?.closest?.('[role="menu"]');
            if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                const items = Array.from(menu.querySelectorAll('[role^="menuitem"]:not([disabled])')).filter(isRendered);
                if (items.length) {
                    event.preventDefault();
                    const current = items.indexOf(document.activeElement);
                    if (event.key === "Home") items[0].focus();
                    else if (event.key === "End") items.at(-1).focus();
                    else if (event.key === "ArrowDown") items[(current + 1 + items.length) % items.length].focus();
                    else items[(current - 1 + items.length) % items.length].focus();
                }
                return;
            }
            if (event.key !== "Tab" || !activeDialog?.matches('[role="dialog"][aria-modal="true"]') || !isRendered(activeDialog)) return;
            const focusable = focusableElements(activeDialog);
            if (!focusable.length) {
                event.preventDefault();
                activeDialog.focus({ preventScroll: true });
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && (document.activeElement === first || !activeDialog.contains(document.activeElement))) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && (document.activeElement === last || !activeDialog.contains(document.activeElement))) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        }, true);

        const start = () => {
            installSkipLink();
            syncDialogs();
            new MutationObserver(syncDialogs).observe(document.body, {
                attributes: true,
                attributeFilter: ["hidden", "style", "class", "aria-modal", "role"],
                childList: true,
                subtree: true,
            });
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();

        return {
            prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            syncDialogs,
        };}

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.accessibility = Object.freeze({ installAccessibility });
})();
