(() => {
    if (window.__apstudyConsoleDiscord) return;
    window.__apstudyConsoleDiscord = true;

    const ENDPOINT = "/api/debug/console";
    const FLUSH_MS = 750;
    const MAX_BUFFER_LINES = 200;
    const MAX_LINE_CHARS = 4000;

    let buffer = [];
    let flushTimer = null;
    let forwarding = false;

    function formatArg(value) {
        if (value instanceof Error) {
            return value.stack || `${value.name}: ${value.message}`;
        }
        if (typeof value === "undefined") {
            return "undefined";
        }
        if (value === null) {
            return "null";
        }
        if (typeof value === "object") {
            try {
                return JSON.stringify(value);
            } catch (error) {
                return String(value);
            }
        }
        return String(value);
    }

    function formatLine(level, args) {
        const body = args.map(formatArg).join(" ");
        const line = `[${level}] ${body}`;
        return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
    }

    function pushLine(level, args) {
        if (forwarding || !args.length) return;
        buffer.push(formatLine(level, args));
        if (buffer.length > MAX_BUFFER_LINES) {
            buffer = buffer.slice(buffer.length - MAX_BUFFER_LINES);
        }
        scheduleFlush();
    }

    function scheduleFlush() {
        if (flushTimer !== null) return;
        flushTimer = window.setTimeout(() => {
            flushTimer = null;
            flush(false);
        }, FLUSH_MS);
    }

    function flush(sync) {
        if (!buffer.length || typeof fetch !== "function") return;

        const lines = buffer.splice(0, buffer.length);
        if (flushTimer !== null) {
            window.clearTimeout(flushTimer);
            flushTimer = null;
        }

        const payload = JSON.stringify({
            page: `${window.location.pathname || "/"}${window.location.search || ""}`,
            lines,
        });

        forwarding = true;
        try {
            if (sync && typeof navigator.sendBeacon === "function") {
                const blob = new Blob([payload], { type: "application/json" });
                if (navigator.sendBeacon(ENDPOINT, blob)) {
                    return;
                }
            }

            fetch(ENDPOINT, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: payload,
                keepalive: true,
            }).catch(() => {});
        } finally {
            forwarding = false;
        }
    }

    ["log", "info", "warn", "error", "debug"].forEach((level) => {
        const original = console[level];
        if (typeof original !== "function") return;
        console[level] = (...args) => {
            original.apply(console, args);
            pushLine(level, args);
        };
    });

    window.addEventListener("error", (event) => {
        const parts = [event.message || "Script error"];
        if (event.filename) {
            parts.push(`at ${event.filename}${event.lineno ? `:${event.lineno}` : ""}${event.colno ? `:${event.colno}` : ""}`);
        }
        pushLine("error", parts);
    });

    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        if (reason instanceof Error) {
            pushLine("error", [reason.stack || `${reason.name}: ${reason.message}`]);
            return;
        }
        pushLine("error", [formatArg(reason)]);
    });

    window.addEventListener("beforeunload", () => flush(true));
    window.addEventListener("pagehide", () => flush(true));
})();
