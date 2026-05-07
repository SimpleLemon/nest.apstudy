function clearClientState() {
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

    document.cookie.split(";").forEach((cookie) => {
        const name = cookie.split("=")[0].trim();
        if (!name) {
            return;
        }
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
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
    if (!shouldEnforceAuth()) {
        return;
    }
    if (!window.account || typeof account.get !== "function") {
        return;
    }

    try {
        await account.get();
    } catch (error) {
        clearClientState();
        if (window.location.pathname !== "/login") {
            window.location.assign(`${window.location.origin}/login`);
        }
    }
}

async function runLogoutFlow() {
    if (window.account && typeof account.deleteSession === "function") {
        try {
            await account.deleteSession("current");
        } catch (error) {
            console.warn("Failed to clear Appwrite session", error);
        }
    }

    try {
        sessionStorage.setItem("apstudy-logged-out", "true");
    } catch (error) {
        console.warn("Failed to mark logged out", error);
    }
    clearClientState();
    window.location.assign(`${window.location.origin}/logout`);
}

function initializeGlobalChrome() {
    ensureAppwriteSession();

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
        <span class="font-['Inter'] text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50">© 2026 Nest.APStudy.org. Your work, your space, your nest.</span>
        <div class="flex gap-6 mt-4 md:mt-0">
            <a class="font-['Inter'] text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="mailto:derekchenusa@gmail.com">Support</a>
            <a class="font-['Inter'] text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="#">Archive</a>
            <a class="font-['Inter'] text-[11px] uppercase tracking-[0.05em] font-normal text-on-surface-variant/50 hover:text-primary transition-colors" href="#">Privacy</a>
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
