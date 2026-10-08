/* global window, Request, Headers, URL */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function installCsrfFetch({ window, document }) {
        if (window.__apstudyCsrfFetchInstalled || typeof window.fetch !== "function") return window.APStudyCsrf;
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

        function isCsrfFailureStatus(status, getHeader) {
            return Number(status) === 400 && getHeader?.(csrfFailureHeader) === "1";
        }

        const csrf = {
            token: csrfToken,
            refresh: refreshCsrfToken,
            isFailure: isCsrfFailureStatus,
        };

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
        window.APStudyCsrf = csrf;
        window.__apstudyCsrfFetchInstalled = true;
        return csrf;
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.csrf = Object.freeze({ installCsrfFetch });
})();
