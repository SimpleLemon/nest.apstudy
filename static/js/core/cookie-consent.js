(() => {
    if (window.APStudyCookieConsent) return;

    const STORAGE_KEY = "apstudy_cookie_consent";
    const POLICY_VERSION = 1;
    const MAX_AGE_MS = 183 * 24 * 60 * 60 * 1000;
    const ACCEPTED = "accepted";
    const REJECTED = "rejected";
    const ANALYTICS_SCRIPT_ID = "apstudy-google-analytics";
    let analyticsLoaded = false;
    let preferencesOpen = false;
    let previousFocus = null;

    function analyticsId() {
        return document.body?.dataset?.analyticsMeasurementId || "";
    }

    function privacySignalEnabled() {
        const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
        return navigator.globalPrivacyControl === true || dnt === "1" || dnt === "yes";
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
            // Consent remains valid for this page even when storage is unavailable.
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
        clearAnalyticsCookies();
    }

    function ui() {
        return {
            banner: document.getElementById("apstudy-consent-banner"),
            dialog: document.getElementById("apstudy-consent-dialog"),
            signal: document.getElementById("apstudy-consent-signal"),
        };
    }

    function syncUi(decision = readStoredDecision()) {
        const elements = ui();
        if (elements.banner) elements.banner.hidden = Boolean(decision);
        if (elements.signal) elements.signal.hidden = !privacySignalEnabled();
        document.querySelectorAll("[data-apstudy-consent-choice]").forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.apstudyConsentChoice === decision?.choice));
        });
    }

    function closePreferences() {
        const { dialog } = ui();
        if (!dialog || !preferencesOpen) return;
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

        if (choice === ACCEPTED) {
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

    function render() {
        const root = document.createElement("div");
        root.id = "apstudy-consent-root";
        root.innerHTML = `
            <section id="apstudy-consent-banner" class="apstudy-consent-banner" role="region" aria-label="Cookie consent" hidden>
                <div class="apstudy-consent-banner__copy">
                    <strong>Choose your analytics preference</strong>
                    <p>Essential storage keeps Nest secure and working. Optional Google Analytics helps us understand usage and stays off unless you accept. <a href="/privacy-policy#cookie-policy">Privacy and cookie details</a>.</p>
                    <p id="apstudy-consent-signal" class="apstudy-consent-signal" hidden>Your browser is sending a privacy signal, so analytics remains off unless you explicitly accept.</p>
                </div>
                <div class="apstudy-consent-actions" aria-label="Analytics consent options">
                    <button type="button" data-apstudy-consent-choice="rejected">Reject analytics</button>
                    <button type="button" data-apstudy-consent-choice="accepted">Accept analytics</button>
                </div>
            </section>
            <button class="apstudy-consent-settings" type="button" data-apstudy-consent-settings aria-haspopup="dialog">Cookie settings</button>
            <div id="apstudy-consent-dialog" class="apstudy-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="apstudy-consent-title" hidden>
                <div class="apstudy-consent-dialog__panel">
                    <button class="apstudy-consent-dialog__close" type="button" data-apstudy-consent-close aria-label="Close cookie settings">&times;</button>
                    <h2 id="apstudy-consent-title">Cookie settings</h2>
                    <p><strong>Essential storage:</strong> Always active where needed for authentication, security, and preferences.</p>
                    <p><strong>Optional analytics:</strong> Google Analytics is loaded only after you accept. Rejecting or withdrawing consent does not limit core features.</p>
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
            if (event.target.closest?.("[data-apstudy-consent-close]") || event.target === ui().dialog) closePreferences();
        });
        root.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closePreferences();
            keepDialogFocus(event);
        });
    }

    function initialize() {
        render();
        const decision = readStoredDecision();
        syncUi(decision);
        if (decision?.choice === ACCEPTED) loadAnalytics();
        if (!decision || decision.choice === REJECTED) clearAnalyticsCookies();
    }

    window.APStudyCookieConsent = {
        openPreferences,
        closePreferences,
        getDecision: readStoredDecision,
        setChoice,
        clearAnalyticsCookies,
        loadAnalytics,
        constants: { STORAGE_KEY, POLICY_VERSION, MAX_AGE_MS, ACCEPTED, REJECTED },
    };

    window.addEventListener("storage", (event) => {
        if (event.key !== STORAGE_KEY) return;
        const decision = readStoredDecision();
        syncUi(decision);
        if (decision?.choice === ACCEPTED) {
            loadAnalytics();
        } else {
            const hadAnalyticsRuntime = analyticsLoaded || Boolean(document.getElementById(ANALYTICS_SCRIPT_ID));
            removeAnalyticsRuntime();
            if (hadAnalyticsRuntime) window.location.reload();
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();
