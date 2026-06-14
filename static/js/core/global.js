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
    if (window.account && typeof account.deleteSession === "function") {
        try {
            await account.deleteSession("current");
        } catch (error) {
            console.warn("Failed to clear Appwrite session", error);
        }
    }

    clearClientState({ includeCookies: false });
    markClientLoggedOut();
    window.location.assign(`${window.location.origin}/logout`);
}

function drainServerToasts() {
    if (window.__apstudyToastsDrained) return;
    window.__apstudyToastsDrained = true;
    if (!window.APStudyToast || typeof fetch !== "function") return;

    fetch("/api/toasts", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
    })
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

function initializeGlobalChrome() {
    ensureAppwriteSession();
    drainServerToasts();

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
        <span class="font-body text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50">© 2026 Nest.APStudy.org. Your work, your space, your nest.</span>
        <div class="flex flex-wrap justify-center gap-6 mt-4 md:mt-0">
            <a class="font-body text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="mailto:derek.chen@emory.edu">Support</a>
            <a class="font-body text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="/privacy-policy">Privacy</a>
            <a class="font-body text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="/terms-of-service">Terms</a>
        </div>
    </div>
</footer>
`;
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeGlobalChrome);
} else {
    initializeGlobalChrome();
}
