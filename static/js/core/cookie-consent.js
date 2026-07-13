(() => {
    if (window.APStudyCookieConsent) return;

    const STORAGE_KEY = "apstudy_cookie_consent";
    const POLICY_VERSION = 2;
    const MAX_AGE_MS = 183 * 24 * 60 * 60 * 1000;
    const ACCEPTED = "accepted";
    const REJECTED = "rejected";
    const MODE_AUTHENTICATED = "authenticated";
    const MODE_PUBLIC = "public-choice";
    const MODE_OFF = "off";
    const ANALYTICS_SCRIPT_ID = "apstudy-google-analytics";
    let analyticsLoaded = false;
    let preferencesOpen = false;
    let previousFocus = null;

    function analyticsMode() {
        const value = document.body?.dataset?.analyticsMode || MODE_OFF;
        return [MODE_AUTHENTICATED, MODE_PUBLIC, MODE_OFF].includes(value) ? value : MODE_OFF;
    }

    function analyticsId() {
        return document.body?.dataset?.analyticsMeasurementId || "";
    }

    function readStoredDecision() {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
            const decidedAt = Date.parse(parsed?.decidedAt || "");
            const age = Date.now() - decidedAt;
            if (parsed?.version !== POLICY_VERSION) return null;
            if (![ACCEPTED, REJECTED].includes(parsed?.choice)) return null;
            if (!Number.isFinite(decidedAt) || age < 0 || age > MAX_AGE_MS) return null;
            return parsed;
        } catch (_error) {
            return null;
        }
    }

    function storeDecision(choice) {
        const decision = {
            version: POLICY_VERSION,
            choice,
            decidedAt: new Date().toISOString(),
        };
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decision));
        } catch (_error) {
            // The choice still applies to this page when browser storage is unavailable.
        }
        return decision;
    }

    function googleCookieNames() {
        return document.cookie
            .split(";")
            .map((part) => part.trim().split("=")[0])
            .filter((name) => name === "_ga" || name === "_gid" || name.startsWith("_ga_"));
    }

    function cookieDomains() {
        const hostname = window.location.hostname;
        const parts = hostname.split(".").filter(Boolean);
        const domains = ["", hostname, `.${hostname}`];
        if (parts.length > 2) domains.push(parts.slice(-2).join("."), `.${parts.slice(-2).join(".")}`);
        return [...new Set(domains)];
    }

    function clearAnalyticsCookies() {
        googleCookieNames().forEach((name) => {
            cookieDomains().forEach((domain) => {
                const domainAttribute = domain ? `; domain=${domain}` : "";
                document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domainAttribute}; SameSite=Lax`;
            });
        });
    }

    function loadAnalytics() {
        const measurementId = analyticsId();
        if (!measurementId || analyticsLoaded || document.getElementById(ANALYTICS_SCRIPT_ID)) return;

        analyticsLoaded = true;
        window[`ga-disable-${measurementId}`] = false;
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function gtag() {
            window.dataLayer.push(arguments);
        };
        window.gtag("consent", "default", {
            analytics_storage: "granted",
            ad_storage: "denied",
            ad_user_data: "denied",
            ad_personalization: "denied",
        });
        window.gtag("js", new Date());
        window.gtag("config", measurementId, {
            allow_google_signals: false,
            allow_ad_personalization_signals: false,
        });

        const script = document.createElement("script");
        script.id = ANALYTICS_SCRIPT_ID;
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
        document.head.appendChild(script);
    }

    function removeAnalyticsRuntime() {
        const measurementId = analyticsId();
        if (measurementId) window[`ga-disable-${measurementId}`] = true;
        document.getElementById(ANALYTICS_SCRIPT_ID)?.remove();
        analyticsLoaded = false;
        clearAnalyticsCookies();
    }

    function ui() {
        return {
            banner: document.getElementById("apstudy-consent-banner"),
            dialog: document.getElementById("apstudy-consent-dialog"),
        };
    }

    function syncUi(decision = readStoredDecision()) {
        const { banner, dialog } = ui();
        if (banner) banner.hidden = Boolean(decision);
        const closeButton = dialog?.querySelector("[data-apstudy-consent-close]");
        if (closeButton) closeButton.hidden = !decision;
        document.querySelectorAll("[data-apstudy-consent-choice]").forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.apstudyConsentChoice === decision?.choice));
        });
    }

    function closePreferences() {
        const { dialog } = ui();
        if (!dialog || !preferencesOpen || !readStoredDecision()) return;
        preferencesOpen = false;
        dialog.hidden = true;
        document.body.classList.remove("apstudy-consent-open");
        previousFocus?.focus?.({ preventScroll: true });
        previousFocus = null;
    }

    function openPreferences() {
        const { dialog } = ui();
        if (!dialog || preferencesOpen) return;
        preferencesOpen = true;
        previousFocus = document.activeElement;
        dialog.hidden = false;
        document.body.classList.add("apstudy-consent-open");
        syncUi();
        dialog.querySelector("[data-apstudy-consent-choice]")?.focus();
    }

    function keepDialogFocus(event) {
        if (event.key !== "Tab" || !preferencesOpen) return;
        const focusable = [...ui().dialog.querySelectorAll("a[href], button:not([disabled])")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function setChoice(choice) {
        if (![ACCEPTED, REJECTED].includes(choice)) return;
        const hadAnalyticsRuntime = analyticsLoaded || Boolean(document.getElementById(ANALYTICS_SCRIPT_ID));
        const decision = storeDecision(choice);
        syncUi(decision);
        closePreferences();

        if (analyticsMode() === MODE_AUTHENTICATED || choice === ACCEPTED) {
            loadAnalytics();
        } else {
            removeAnalyticsRuntime();
            if (hadAnalyticsRuntime) {
                window.location.reload();
                return;
            }
        }
        window.dispatchEvent(new CustomEvent("apstudy-consent-change", { detail: decision }));
    }

    function renderPublicControls() {
        const root = document.createElement("div");
        root.id = "apstudy-consent-root";
        root.innerHTML = `
            <div class="apstudy-consent-stack">
                <section id="apstudy-consent-banner" class="apstudy-consent-banner" role="region" aria-label="Analytics preference" hidden>
                    <div class="apstudy-consent-banner__copy">
                        <strong>Choose your analytics preference</strong>
                        <p>Google Analytics is active by default on public pages to help improve Nest. You can reject it now or change this choice later. <a href="/privacy-policy#cookie-policy">Privacy details</a>.</p>
                    </div>
                    <div class="apstudy-consent-actions" aria-label="Analytics preference options">
                        <button type="button" data-apstudy-consent-choice="rejected">Reject analytics</button>
                        <button type="button" data-apstudy-consent-choice="accepted">Accept analytics</button>
                    </div>
                </section>
                <button class="apstudy-consent-settings" type="button" data-apstudy-consent-settings aria-haspopup="dialog" aria-label="Cookie settings" title="Cookie settings">
                    <svg class="apstudy-consent-settings__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M20.75 12.3a8.75 8.75 0 1 1-9.05-9.05 3.35 3.35 0 0 0 4.05 4.05 3.35 3.35 0 0 0 4.05 4.05c.39.29.7.62.95.95Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
                        <circle cx="8.5" cy="12" r="1" fill="currentColor" />
                        <circle cx="12" cy="16" r="1" fill="currentColor" />
                        <circle cx="12" cy="8.5" r="1" fill="currentColor" />
                    </svg>
                    <span class="apstudy-consent-settings__label">Cookie settings</span>
                </button>
            </div>
            <div id="apstudy-consent-dialog" class="apstudy-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="apstudy-consent-title" hidden>
                <div class="apstudy-consent-dialog__panel">
                    <button class="apstudy-consent-dialog__close" type="button" data-apstudy-consent-close aria-label="Close cookie settings">&times;</button>
                    <h2 id="apstudy-consent-title">Cookie settings</h2>
                    <p><strong>Essential storage:</strong> Always active where needed for authentication, security, and preferences.</p>
                    <p><strong>Public-page analytics:</strong> Google Analytics is active by default on public content. Rejecting disables it on public pages without limiting core features.</p>
                    <div class="apstudy-consent-actions" aria-label="Analytics preference">
                        <button type="button" data-apstudy-consent-choice="rejected">Reject analytics</button>
                        <button type="button" data-apstudy-consent-choice="accepted">Accept analytics</button>
                    </div>
                    <a class="apstudy-consent-dialog__privacy" href="/privacy-policy#cookie-policy">Read the Privacy Policy</a>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        root.addEventListener("click", (event) => {
            const choiceButton = event.target.closest?.("[data-apstudy-consent-choice]");
            if (choiceButton) {
                setChoice(choiceButton.dataset.apstudyConsentChoice);
                return;
            }
            if (event.target.closest?.("[data-apstudy-consent-settings]")) openPreferences();
            if (event.target.closest?.("[data-apstudy-consent-close]")) closePreferences();
        });
        root.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closePreferences();
            keepDialogFocus(event);
        });
    }

    function initialize() {
        const mode = analyticsMode();
        if (mode === MODE_OFF) return;
        if (mode === MODE_AUTHENTICATED) {
            loadAnalytics();
            return;
        }

        renderPublicControls();
        const decision = readStoredDecision();
        syncUi(decision);
        if (decision?.choice === REJECTED) {
            removeAnalyticsRuntime();
        } else {
            loadAnalytics();
            if (!decision) openPreferences();
        }
    }

    window.APStudyCookieConsent = {
        openPreferences,
        closePreferences,
        getDecision: readStoredDecision,
        getMode: analyticsMode,
        setChoice,
        clearAnalyticsCookies,
        loadAnalytics,
        constants: {
            STORAGE_KEY, POLICY_VERSION, MAX_AGE_MS, ACCEPTED, REJECTED,
            MODE_AUTHENTICATED, MODE_PUBLIC, MODE_OFF,
        },
    };

    window.addEventListener("storage", (event) => {
        if (event.key !== STORAGE_KEY) return;
        const mode = analyticsMode();
        if (mode === MODE_AUTHENTICATED) {
            loadAnalytics();
            return;
        }
        if (mode !== MODE_PUBLIC) return;

        const decision = readStoredDecision();
        syncUi(decision);
        if (!decision) {
            openPreferences();
            loadAnalytics();
            return;
        }
        if (decision?.choice === REJECTED) {
            const hadAnalyticsRuntime = analyticsLoaded || Boolean(document.getElementById(ANALYTICS_SCRIPT_ID));
            removeAnalyticsRuntime();
            if (hadAnalyticsRuntime) window.location.reload();
        } else {
            loadAnalytics();
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();
