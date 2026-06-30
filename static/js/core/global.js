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
