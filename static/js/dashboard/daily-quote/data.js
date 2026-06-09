(function registerDashboardDailyQuoteData(global) {
    "use strict";

    const CACHE_KEY = "apstudy.dashboard.eggCrackQuote.v2";
    const VISIBILITY_KEY = "apstudy.dashboard.eggCrackQuote.visible.v1";
    const QUOTE_API_URL = "/api/dashboard/quote/today";
    const ERROR_REPORT_URL = "/api/dashboard/quote/error";
    const FALLBACK_QUOTE = {
        text: "Small steps every day become the work you are proud of.",
        author: "APStudy Nest",
        fallback: true,
    };

    function getDailyKey() {
        return new Date().toISOString().slice(0, 10);
    }

    function errorMessage(error) {
        if (!error) return "";
        return String(error.message || error.name || error);
    }

    function reportQuoteError(reason, details = {}) {
        try {
            if (typeof fetch !== "function") return;
            const payload = {
                reason,
                message: String(details.message || "").slice(0, 500),
                status: details.status,
                dateKey: details.dateKey,
                quoteUrl: details.quoteUrl || QUOTE_API_URL,
                phase: details.phase,
            };
            fetch(ERROR_REPORT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                keepalive: true,
            }).catch(() => {});
        } catch (error) {
            void error;
            // Reporting should never affect quote rendering.
        }
    }

    function readCache(dateKey) {
        try {
            const raw = global.localStorage.getItem(CACHE_KEY);
            const cached = raw ? JSON.parse(raw) : null;
            if (cached?.dateKey === dateKey && cached?.completed && cached?.quote?.text) {
                return cached.quote;
            }
        } catch (error) {
            reportQuoteError("cache_read_failed", {
                message: errorMessage(error),
                dateKey,
                phase: "cache",
            });
            return null;
        }
        return null;
    }

    function isVisible() {
        try {
            return global.localStorage.getItem(VISIBILITY_KEY) !== "hidden";
        } catch (error) {
            reportQuoteError("visibility_storage_failed", {
                message: errorMessage(error),
                phase: "visibility_read",
            });
            return true;
        }
    }

    function setVisible(visible) {
        try {
            if (visible) {
                global.localStorage.removeItem(VISIBILITY_KEY);
            } else {
                global.localStorage.setItem(VISIBILITY_KEY, "hidden");
            }
        } catch (error) {
            reportQuoteError("visibility_storage_failed", {
                message: errorMessage(error),
                phase: visible ? "visibility_show" : "visibility_hide",
            });
        }
        global.dispatchEvent(new CustomEvent("apstudy:dashboard-quote-visibility", {
            detail: { visible },
        }));
    }

    function writeCache(dateKey, quote) {
        if (quote?.fallback) return;
        try {
            global.localStorage.setItem(CACHE_KEY, JSON.stringify({
                dateKey,
                completed: true,
                fetchedAt: new Date().toISOString(),
                quote,
            }));
        } catch (error) {
            reportQuoteError("cache_write_failed", {
                message: errorMessage(error),
                dateKey,
                phase: "cache",
            });
        }
    }

    function normalizeQuote(data, context = {}) {
        const item = data?.quote || data;
        const text = String(item?.text || "").trim();
        const author = String(item?.author || "").trim();
        if (!text) {
            reportQuoteError("invalid_payload", {
                message: "Daily quote endpoint response did not include quote text.",
                dateKey: context.dateKey,
                phase: context.phase || "normalize",
            });
            return FALLBACK_QUOTE;
        }
        return {
            text,
            author: author || FALLBACK_QUOTE.author,
            date: String(item?.date || "").trim(),
            fallback: Boolean(item?.fallback),
        };
    }

    function fetchQuote(signal, context = {}) {
        return fetch(QUOTE_API_URL, { signal })
            .then((response) => {
                if (!response.ok) {
                    reportQuoteError("http_error", {
                        message: `Daily quote endpoint failed with status ${response.status}.`,
                        status: response.status,
                        dateKey: context.dateKey,
                        phase: context.phase || "fetch",
                    });
                    const error = new Error("Quote request failed");
                    error.quoteErrorReported = true;
                    throw error;
                }
                return response.json();
            })
            .then((data) => normalizeQuote(data, context))
            .catch((error) => {
                if (!error?.quoteErrorReported) {
                    reportQuoteError("fetch_failed", {
                        message: errorMessage(error),
                        dateKey: context.dateKey,
                        phase: context.phase || "fetch",
                    });
                }
                if (error?.name === "AbortError") return FALLBACK_QUOTE;
                return FALLBACK_QUOTE;
            });
    }

    global.APStudyDashboardDailyQuoteData = {
        fetchQuote,
        getDailyKey,
        isVisible,
        readCache,
        setVisible,
        writeCache,
    };
})(window);
