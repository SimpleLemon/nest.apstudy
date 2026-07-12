import("/static/js/core/cookie-consent.js").catch((error) => {
    console.error("Unable to initialize cookie consent", error);
});

(() => {
    if (window.__apstudyCsrfFetchInstalled || typeof window.fetch !== "function") return;
    window.__apstudyCsrfFetchInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const csrfFailureHeader = "X-APStudy-CSRF-Error";
    let csrfRefreshPromise = null;

    function csrfToken() {
        const entry = document.cookie
            .split(";")
            .map((item) => item.trim())
            .find((item) => item.startsWith("csrf_token="));
        return entry ? decodeURIComponent(entry.slice("csrf_token=".length)) : "";
    }

    function requestWithCsrfHeader(input, init = {}) {
        const request = input instanceof Request ? input : null;
        const headers = new Headers(request?.headers || undefined);
        new Headers(init.headers || undefined).forEach((value, key) => headers.set(key, value));
        const token = csrfToken();
        if (token && !headers.has("X-CSRFToken")) headers.set("X-CSRFToken", token);
        return new Request(request ? request.clone() : input, { ...init, headers });
    }

    async function refreshCsrfToken() {
        if (!csrfRefreshPromise) {
            csrfRefreshPromise = nativeFetch("/auth/csrf", {
                credentials: "same-origin",
                cache: "no-store",
                headers: { Accept: "application/json" },
            }).then((response) => {
                if (!response.ok || !csrfToken()) {
                    throw new Error("Unable to refresh CSRF token");
                }
            }).finally(() => {
                csrfRefreshPromise = null;
            });
        }
        return csrfRefreshPromise;
    }

    function isCsrfFailure(response) {
        return response.status === 400 && response.headers.get(csrfFailureHeader) === "1";
    }

    window.fetch = async (input, init = {}) => {
        const request = input instanceof Request ? input : null;
        const method = String(init.method || request?.method || "GET").toUpperCase();
        const url = new URL(request?.url || String(input), window.location.href);
        if (!unsafeMethods.has(method) || url.origin !== window.location.origin) {
            return nativeFetch(input, init);
        }

        const firstRequest = requestWithCsrfHeader(input, init);
        const response = await nativeFetch(firstRequest.clone());
        if (!isCsrfFailure(response)) return response;

        await refreshCsrfToken();
        const retryHeaders = new Headers(firstRequest.headers);
        const token = csrfToken();
        if (token) retryHeaders.set("X-CSRFToken", token);
        const retryRequest = new Request(firstRequest.clone(), { headers: retryHeaders });
        return nativeFetch(retryRequest);
    };
})();

(() => {
    if (window.APStudyPendingMutations) return;

    const activeTokens = new Set();

    function notify() {
        document.documentElement.toggleAttribute("data-pending-save", activeTokens.size > 0);
        window.dispatchEvent(new CustomEvent("apstudy-pending-save-change", {
            detail: { pending: activeTokens.size },
        }));
    }

    function begin(label = "save") {
        const token = { label, startedAt: Date.now() };
        activeTokens.add(token);
        notify();
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            activeTokens.delete(token);
            notify();
        };
    }

    function track(promise, label = "save") {
        const end = begin(label);
        return Promise.resolve(promise).finally(end);
    }

    window.APStudyPendingMutations = {
        begin,
        track,
        hasPending: () => activeTokens.size > 0,
        count: () => activeTokens.size,
    };

    window.addEventListener("beforeunload", (event) => {
        if (!activeTokens.size) return;
        event.preventDefault();
        event.returnValue = "";
    });
})();

(() => {
    if (window.APStudyAccessibility) return;

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
        modalRecords.set(dialog, { previousFocus: candidate });
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

        for (const [dialog, record] of modalRecords) {
            if (visible.includes(dialog)) continue;
            modalRecords.delete(dialog);
            const focused = document.activeElement;
            if ((!focused || focused === document.body || dialog.contains(focused)) && record.previousFocus?.isConnected) {
                record.previousFocus.focus?.({ preventScroll: true });
            }
        }
        activeDialog = visible.at(-1) || null;
        syncModalInertness(activeDialog);
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

    window.APStudyAccessibility = {
        prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        syncDialogs,
    };
})();

(() => {
    if (window.APStudyFormField) return;

    const autoClearHandlers = new WeakMap();

    function normalizeFields(fields) {
        if (!fields) return [];
        return (Array.isArray(fields) ? fields : [fields]).filter(Boolean);
    }

    function markInvalid(fields, { focus = true } = {}) {
        const list = normalizeFields(fields);
        list.forEach((field) => field.setAttribute("aria-invalid", "true"));
        if (focus && list[0]?.focus) {
            list[0].focus({ preventScroll: true });
        }
        return list[0] || null;
    }

    function clearInvalid(fields) {
        normalizeFields(fields).forEach((field) => field.removeAttribute("aria-invalid"));
    }

    function clearAll(root = document) {
        if (!root?.querySelectorAll) return;
        root.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
            field.removeAttribute("aria-invalid");
        });
    }

    function bindAutoClear(fields) {
        normalizeFields(fields).forEach((field) => {
            if (autoClearHandlers.has(field)) return;
            const handler = () => clearInvalid(field);
            field.addEventListener("input", handler);
            field.addEventListener("change", handler);
            autoClearHandlers.set(field, handler);
        });
    }

    window.APStudyFormField = {
        markInvalid,
        clearInvalid,
        clearAll,
        bindAutoClear,
    };
})();

(() => {
    if (window.APStudyConfirm) return;

    let activeRequest = null;

    function ensureDialog() {
        let root = document.getElementById("apstudy-confirm-root");
        if (root) return root;

        root = document.createElement("div");
        root.id = "apstudy-confirm-root";
        root.className = "apstudy-confirm";
        root.hidden = true;
        root.innerHTML = `
            <div class="apstudy-confirm__panel" role="dialog" aria-modal="true" aria-labelledby="apstudy-confirm-title" aria-describedby="apstudy-confirm-message">
                <div class="apstudy-confirm__icon" aria-hidden="true">
                    <span class="material-symbols-outlined">warning</span>
                </div>
                <div class="apstudy-confirm__copy">
                    <h2 id="apstudy-confirm-title">Are you sure?</h2>
                    <p id="apstudy-confirm-message"></p>
                </div>
                <div class="apstudy-confirm__actions">
                    <button type="button" class="apstudy-confirm__cancel">Cancel</button>
                    <button type="button" class="apstudy-confirm__accept">Delete</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        root.addEventListener("pointerdown", (event) => {
            if (event.target === root) closeDialog(false);
        });
        root.querySelector(".apstudy-confirm__cancel")?.addEventListener("click", () => closeDialog(false));
        root.querySelector(".apstudy-confirm__accept")?.addEventListener("click", () => closeDialog(true));
        document.addEventListener("keydown", (event) => {
            if (!activeRequest || event.key !== "Escape") return;
            event.preventDefault();
            closeDialog(false);
        });

        return root;
    }

    function closeDialog(value) {
        if (!activeRequest) return;
        const request = activeRequest;
        activeRequest = null;
        request.root.hidden = true;
        request.root.classList.remove("is-danger");
        document.body.classList.remove("apstudy-confirm-open");
        request.resolve(Boolean(value));
        request.previousFocus?.focus?.({ preventScroll: true });
    }

    function request(options = {}) {
        if (activeRequest) closeDialog(false);

        const root = ensureDialog();
        const title = String(options.title || "Are you sure?");
        const message = String(options.message || "This action cannot be undone.");
        const acceptLabel = String(options.acceptLabel || options.confirmLabel || "Delete");
        const cancelLabel = String(options.cancelLabel || "Cancel");
        const danger = options.danger !== false;

        root.querySelector("#apstudy-confirm-title").textContent = title;
        root.querySelector("#apstudy-confirm-message").textContent = message;
        root.querySelector(".apstudy-confirm__accept").textContent = acceptLabel;
        root.querySelector(".apstudy-confirm__cancel").textContent = cancelLabel;
        root.classList.toggle("is-danger", danger);
        root.hidden = false;
        document.body.classList.add("apstudy-confirm-open");

        return new Promise((resolve) => {
            activeRequest = {
                root,
                resolve,
                previousFocus: document.activeElement,
            };
            requestAnimationFrame(() => {
                root.querySelector(".apstudy-confirm__cancel")?.focus({ preventScroll: true });
            });
        });
    }

    window.APStudyConfirm = { request };
})();

(() => {
    if (window.APStudyToast) return;

    const VALID_TYPES = new Set(["info", "success", "warning", "error"]);
    const DEFAULT_DURATION = 3000;

    const ICONS = {
        info:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none"></circle></svg>',
        success:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.5 2.5L16 9.5"></path></svg>',
        warning:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3z"></path><line x1="12" y1="10" x2="12" y2="14.5"></line><circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none"></circle></svg>',
        error:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="7.5" x2="12" y2="13"></line><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"></circle></svg>',
    };

    function ensureHost() {
        let host = document.getElementById("apstudy-toast-host");
        if (host) return host;
        host = document.createElement("div");
        host.id = "apstudy-toast-host";
        host.className = "apstudy-toast-host";
        host.setAttribute("role", "region");
        host.setAttribute("aria-label", "Notifications");
        host.setAttribute("aria-live", "polite");
        (document.body || document.documentElement).appendChild(host);
        return host;
    }

    function normalizeType(value) {
        const type = String(value || "info").toLowerCase();
        return VALID_TYPES.has(type) ? type : "info";
    }

    function show(options = {}) {
        if (typeof options === "string") {
            options = { message: options };
        }

        const type = normalizeType(options.type);
        const message = options.message == null ? "" : String(options.message);
        const title = options.title == null ? "" : String(options.title);
        if (!message && !title) {
            return { dismiss: () => {} };
        }

        const rawDuration = Number(options.duration);
        const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : DEFAULT_DURATION;

        const host = ensureHost();
        const toast = document.createElement("div");
        toast.className = `apstudy-toast is-${type}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");

        const icon = document.createElement("span");
        icon.className = "apstudy-toast__icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = ICONS[type] || ICONS.info;

        const copy = document.createElement("div");
        copy.className = "apstudy-toast__copy";
        if (title) {
            const titleEl = document.createElement("p");
            titleEl.className = "apstudy-toast__title";
            titleEl.textContent = title;
            copy.appendChild(titleEl);
        }
        if (message) {
            const messageEl = document.createElement("p");
            messageEl.className = "apstudy-toast__message";
            messageEl.textContent = message;
            copy.appendChild(messageEl);
        }

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "apstudy-toast__close";
        closeButton.setAttribute("aria-label", "Dismiss notification");
        closeButton.innerHTML = "&times;";

        toast.appendChild(icon);
        toast.appendChild(copy);
        toast.appendChild(closeButton);

        const action = options.action;
        if (action && (action.label || action.text)) {
            const actionButton = document.createElement("button");
            actionButton.type = "button";
            actionButton.className = "apstudy-toast__action";
            actionButton.textContent = String(action.label || action.text);
            actionButton.addEventListener("click", () => {
                let keepOpen = false;
                try {
                    if (typeof action.onClick === "function") {
                        keepOpen = action.onClick() === true;
                    } else if (action.href) {
                        window.location.assign(action.href);
                        keepOpen = true;
                    }
                } catch (error) {
                    console.warn("Toast action failed", error);
                }
                if (!keepOpen) dismiss();
            });
            copy.appendChild(actionButton);
        }

        const progress = document.createElement("div");
        progress.className = "apstudy-toast__progress";
        toast.appendChild(progress);

        let dismissed = false;
        let timerId = null;
        let remaining = duration;
        let startedAt = 0;

        function clearTimer() {
            if (timerId !== null) {
                window.clearTimeout(timerId);
                timerId = null;
            }
        }

        function dismiss() {
            if (dismissed) return;
            dismissed = true;
            clearTimer();
            toast.classList.add("is-leaving");
            toast.classList.remove("is-visible");
            let removed = false;
            const finalize = () => {
                if (removed) return;
                removed = true;
                toast.removeEventListener("transitionend", finalize);
                toast.remove();
            };
            toast.addEventListener("transitionend", finalize);
            window.setTimeout(finalize, 400);
        }

        function startTimer() {
            if (duration === 0 || dismissed) return;
            startedAt = Date.now();
            timerId = window.setTimeout(dismiss, remaining);
        }

        function pause() {
            if (duration === 0 || dismissed || timerId === null) return;
            clearTimer();
            remaining -= Date.now() - startedAt;
            toast.classList.add("is-paused");
        }

        function resume() {
            if (duration === 0 || dismissed) return;
            toast.classList.remove("is-paused");
            if (remaining <= 0) {
                dismiss();
                return;
            }
            startTimer();
        }

        closeButton.addEventListener("click", dismiss);
        toast.addEventListener("mouseenter", pause);
        toast.addEventListener("mouseleave", resume);
        toast.addEventListener("focusin", pause);
        toast.addEventListener("focusout", resume);

        host.prepend(toast);

        requestAnimationFrame(() => {
            toast.classList.add("is-visible");
            if (duration > 0) {
                progress.style.setProperty("--toast-duration", `${duration}ms`);
                progress.classList.add("is-running");
                startTimer();
            } else {
                progress.remove();
            }
        });

        return { dismiss };
    }

    const api = {
        show,
        info: (message, options = {}) => show({ ...options, message, type: "info" }),
        success: (message, options = {}) => show({ ...options, message, type: "success" }),
        warning: (message, options = {}) => show({ ...options, message, type: "warning" }),
        error: (message, options = {}) => show({ ...options, message, type: "error" }),
    };

    window.APStudyToast = api;
})();

(() => {
    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function loadingHtml(label = "Loading...", options = {}) {
        const sizePx = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
        const textToneClass = options.textToneClass || "text-on-surface-variant";
        return `
            <div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${escapeHtml(textToneClass)}">
                <span class="loader" style="width:${sizePx}px; height:${sizePx}px;" aria-hidden="true"></span>
                <span>${escapeHtml(label)}</span>
            </div>
        `;
    }

    window.APStudyLoader = {
        html: loadingHtml,
    };
})();

(() => {
    if (window.APStudySkeleton) return;

    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function skeletonBlock(className) {
        return `<div data-slot="skeleton" class="bg-muted rounded-md animate-pulse ${escapeHtml(className)}"></div>`;
    }

    function shell(label, className, bodyHtml) {
        const statusLabel = escapeHtml(label || "Loading...");
        return `
            <div class="apstudy-skeleton ${escapeHtml(className || "")}" role="status" aria-live="polite" aria-busy="true">
                <span class="sr-only">${statusLabel}</span>
                <div class="contents" aria-hidden="true">${bodyHtml}</div>
            </div>
        `;
    }

    function table(options = {}) {
        const rows = Math.max(1, Number(options.rows || 4));
        const columns = Math.max(2, Number(options.columns || 4));
        const className = options.className || "";
        const headerCells = Array.from({ length: columns }, (_, index) => (
            skeletonBlock(index % 2 === 0 ? "h-3 w-20" : "h-3 w-16")
        )).join("");
        const rowCells = Array.from({ length: columns }, (_, index) => {
            if (index === 0) {
                return `
                    <div class="flex items-center gap-3">
                        ${skeletonBlock("size-8 shrink-0 rounded-full")}
                        ${skeletonBlock("h-4 flex-1")}
                    </div>
                `;
            }
            if (index === columns - 1) return skeletonBlock("h-6 w-16 rounded-full");
            return skeletonBlock("h-4 w-full");
        }).join("");
        const bodyRows = Array.from({ length: rows }, () => `
            <div class="grid items-center gap-4 border-b pb-3 last:border-0 last:pb-0" style="grid-template-columns: repeat(${columns}, minmax(0, 1fr)); opacity: 1; transform: none;">
                ${rowCells}
            </div>
        `).join("");

        return shell(options.label || "Loading table...", `apstudy-skeleton-table ${className}`, `
            <div class="flex w-full max-w-2xl flex-col gap-4 rounded-md border p-4" style="opacity: 1; transform: none;">
                <div class="flex items-center justify-between" style="opacity: 1; transform: none;">
                    ${skeletonBlock("h-5 w-32")}
                    ${skeletonBlock("h-8 w-20")}
                </div>
                <div class="grid gap-4 rounded-md bg-muted px-3 py-2" style="grid-template-columns: repeat(${columns}, minmax(0, 1fr)); opacity: 1; transform: none;">
                    ${headerCells}
                </div>
                <div class="flex flex-col gap-3">${bodyRows}</div>
            </div>
        `);
    }

    function cards(options = {}) {
        const count = Math.max(1, Number(options.count || 3));
        const className = options.className || "";
        const cardClassName = options.cardClassName || "";
        const cardsHtml = Array.from({ length: count }, (_, index) => `
            <div class="apstudy-skeleton-card rounded-md border p-4 ${escapeHtml(cardClassName)}" style="opacity: 1; transform: none;">
                <div class="flex items-center gap-3">
                    ${skeletonBlock(index % 2 === 0 ? "size-8 shrink-0 rounded-full" : "h-8 w-8 shrink-0")}
                    <div class="flex flex-1 flex-col gap-2">
                        ${skeletonBlock("h-4 w-32")}
                        ${skeletonBlock("h-3 w-20")}
                    </div>
                </div>
                <div class="mt-4 flex flex-col gap-2">
                    ${skeletonBlock("h-3 w-full")}
                    ${skeletonBlock("h-3 w-3/4")}
                    ${skeletonBlock("h-6 w-16 rounded-full")}
                </div>
            </div>
        `).join("");

        return shell(options.label || "Loading cards...", `apstudy-skeleton-cards ${className}`, cardsHtml);
    }

    function fieldSet(options = {}) {
        const sections = Math.max(1, Number(options.sections || 2));
        const fields = Math.max(1, Number(options.fields || 4));
        const className = options.className || "";
        const sectionHtml = Array.from({ length: sections }, () => `
            <div class="apstudy-skeleton-fieldset-section rounded-md border p-4" style="opacity: 1; transform: none;">
                <div class="flex items-center justify-between gap-4">
                    <div class="flex flex-col gap-2">
                        ${skeletonBlock("h-5 w-32")}
                        ${skeletonBlock("h-3 w-48")}
                    </div>
                    ${skeletonBlock("h-8 w-20")}
                </div>
                <div class="mt-4 grid gap-4 md:grid-cols-2">
                    ${Array.from({ length: fields }, () => `
                        <div class="flex flex-col gap-2">
                            ${skeletonBlock("h-3 w-20")}
                            ${skeletonBlock("h-10 w-full")}
                        </div>
                    `).join("")}
                </div>
            </div>
        `).join("");

        return shell(options.label || "Loading form...", `apstudy-skeleton-fieldset ${className}`, sectionHtml);
    }

    window.APStudySkeleton = {
        block: skeletonBlock,
        table,
        cards,
        fieldSet,
    };
})();

(() => {
    const pad2 = (value) => String(value).padStart(2, "0");

    function toLocalInputValue(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function isoToLocalInput(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : toLocalInputValue(date);
    }

    function localInputToIso(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    window.APStudyDate = {
        toLocalInputValue,
        isoToLocalInput,
        localInputToIso,
    };
})();

function clearClientState(options = {}) {
    const includeCookies = options.includeCookies !== false;
    try {
        sessionStorage.clear();
    } catch (error) {
        console.warn("Failed to clear session storage", error);
    }

    try {
        localStorage.clear();
    } catch (error) {
        console.warn("Failed to clear local storage", error);
    }

    try {
        if (window.indexedDB?.deleteDatabase) {
            window.indexedDB.deleteDatabase("apstudy-chat-cache");
        }
    } catch (error) {
        console.warn("Failed to clear chat cache", error);
    }

    if (includeCookies) {
        document.cookie.split(";").forEach((cookie) => {
            const name = cookie.split("=")[0].trim();
            if (!name) {
                return;
            }
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        });
    }
}

function markClientLoggedOut() {
    try {
        sessionStorage.setItem("apstudy-logged-out", "true");
    } catch (error) {
        console.warn("Failed to mark logged out", error);
    }
}

function shouldEnforceAuth() {
    if (window.location.pathname === "/login") {
        return false;
    }
    const nav = document.querySelector("global.thenav");
    if (nav && nav.hasAttribute("data-profile-picture")) {
        return true;
    }
    return document.body?.dataset?.requiresAuth === "true";
}

async function ensureAppwriteSession() {
    if (document.body?.dataset?.probeAppwriteSession !== "true" || !shouldEnforceAuth()) return;
    if (typeof window.APStudyAppwriteSessionProbe !== "function") return;
    await window.APStudyAppwriteSessionProbe();
}

async function runLogoutFlow() {
    window.APStudyPresenceHeartbeat?.stop?.();
    try {
        await window.APStudyNotifications?.disableCurrent?.();
    } catch (error) {
        console.warn('Unable to revoke this browser notification subscription during logout.', error);
    }
    if (window.account && typeof account.deleteSession === "function") {
        try {
            await account.deleteSession("current");
        } catch (error) {
            console.warn("Failed to clear Appwrite session", error);
        }
    }

    clearClientState({ includeCookies: false });
    markClientLoggedOut();
    try {
        const response = await fetch("/logout", {
            method: "POST",
            credentials: "same-origin",
        });
        if (!response.ok) throw new Error("Logout failed");
        window.location.assign(`${window.location.origin}/login`);
    } catch (error) {
        console.error(error);
        window.APStudyToast?.show?.({
            title: "Could not log out",
            message: "Refresh the page and try again.",
            type: "error",
        });
    }
}

function drainServerToasts() {
    if (window.__apstudyToastsDrained) return;
    window.__apstudyToastsDrained = true;
    if (!window.APStudyToast || typeof fetch !== "function") return;

    const toastRequest = {
        method: "GET",
        headers: { Accept: "application/json" },
    };
    toastRequest["credentials"] = "same-origin";
    fetch("/api/toasts", toastRequest)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
            const toasts = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.toasts)
                  ? payload.toasts
                  : [];
            toasts.forEach((entry) => {
                if (!entry || typeof entry !== "object") return;
                window.APStudyToast.show({
                    message: entry.message,
                    title: entry.title,
                    type: entry.type,
                    duration: entry.duration,
                    action: entry.action,
                });
            });
        })
        .catch(() => {});
}

window.APStudyHttp = window.APStudyHttp || {
    async fetchJson(url, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
        }
        const method = String(options.method || "GET").toUpperCase();
        let request = fetch(url, { ...options, headers });
        const pendingLabel = options.pendingLabel || null;
        if (method !== "GET" && pendingLabel && window.APStudyPendingMutations?.track) {
            request = window.APStudyPendingMutations.track(request, pendingLabel);
        }
        const response = await request;
        const contentType = response.headers.get("Content-Type") || "";
        const payload = contentType.includes("application/json") ? await response.json() : null;
        if (!response.ok) {
            const message = payload?.error || payload?.message || response.statusText || "Request failed.";
            throw new Error(message);
        }
        return payload ?? {};
    },
};

function initializePresenceHeartbeat() {
    if (window.APStudyPresenceHeartbeatStarted) return;
    const nav = document.querySelector("global.thenav[data-user-email]");
    if (!nav || typeof fetch !== "function") return;
    window.APStudyPresenceHeartbeatStarted = true;

    const tabKey = "apstudy-presence-tab-id";
    const siteHeartbeatMs = 60000;
    const chatHeartbeatMs = 5000;
    const chatRoomScopeKey = "chat-room";
    const extraScopes = new Map();
    let intervalId = null;
    let stopped = false;
    let tabId = "";
    try {
        tabId = sessionStorage.getItem(tabKey) || "";
    } catch (_) {
        tabId = "";
    }
    if (!tabId) {
        const random = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        tabId = random.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
        try {
            sessionStorage.setItem(tabKey, tabId);
        } catch (_) {
            // In private or locked-down contexts, a memory-only tab id is fine.
        }
    }

    function isChatPage() {
        return window.location.pathname === "/chat";
    }

    function heartbeatIntervalMs() {
        return isChatPage() ? chatHeartbeatMs : siteHeartbeatMs;
    }

    function pageScopes() {
        if (!isChatPage()) return [{ scope_type: "site", scope_id: "global" }];
        const scopes = [{ scope_type: "chat", scope_id: "global" }];
        for (const scope of extraScopes.values()) {
            if (scope?.scope_type && scope?.scope_id) scopes.push(scope);
        }
        return scopes;
    }

    function postHeartbeat(scope, keepalive) {
        if (stopped) return Promise.resolve();
        const body = JSON.stringify({ ...scope, tab_id: tabId });
        return fetch("/api/presence/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body,
            credentials: "same-origin",
            keepalive,
        }).catch(() => {});
    }

    function sendHeartbeat({ keepalive = false } = {}) {
        if (stopped) return Promise.resolve([]);
        return Promise.all(pageScopes().map((scope) => postHeartbeat(scope, keepalive)));
    }

    function startTimer() {
        if (intervalId) window.clearInterval(intervalId);
        intervalId = window.setInterval(sendHeartbeat, heartbeatIntervalMs());
    }

    function stopTimer() {
        if (!intervalId) return;
        window.clearInterval(intervalId);
        intervalId = null;
    }

    function stopHeartbeat() {
        stopped = true;
        stopTimer();
        extraScopes.clear();
    }

    function pauseHeartbeat() {
        void sendHeartbeat({ keepalive: true });
        stopTimer();
    }

    function resumeHeartbeat() {
        void sendHeartbeat();
        startTimer();
    }

    function setChatRoom(roomId) {
        const scopeId = String(roomId || "").trim();
        const previous = extraScopes.get(chatRoomScopeKey)?.scope_id || "";
        if (scopeId) {
            extraScopes.set(chatRoomScopeKey, { scope_type: "chat", scope_id: scopeId });
        } else {
            extraScopes.delete(chatRoomScopeKey);
        }
        if (isChatPage() && previous !== scopeId) void sendHeartbeat();
    }

    sendHeartbeat();
    startTimer();
    document.addEventListener("visibilitychange", () => sendHeartbeat({ keepalive: true }));
    if (window.APStudyPageLifecycle?.register) {
        window.APStudyPageLifecycle.register({
            pause: pauseHeartbeat,
            resume: resumeHeartbeat,
            dispose: pauseHeartbeat,
        });
    } else {
        window.addEventListener("pagehide", pauseHeartbeat, { once: true });
    }
    window.APStudyPresenceHeartbeat = {
        send: sendHeartbeat,
        setChatRoom,
        clearChatRoom: () => setChatRoom(null),
        pause: pauseHeartbeat,
        resume: resumeHeartbeat,
        stop: stopHeartbeat,
        tabId,
        siteHeartbeatMs,
        chatHeartbeatMs,
    };
}

function initializeGlobalChrome() {
    ensureAppwriteSession();
    drainServerToasts();
    initializePresenceHeartbeat();
    initializeTierBadgeTooltips();

    // Bind any links/buttons that request logout
    const logoutLinks = document.querySelectorAll("[data-logout]");
    if (logoutLinks.length) {
        logoutLinks.forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                runLogoutFlow();
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

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeGlobalChrome);
} else {
    initializeGlobalChrome();
}
