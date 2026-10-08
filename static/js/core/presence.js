/* global window */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function initializePresenceHeartbeat({ window, document }) {
        if (window.APStudyPresenceHeartbeatStarted) return window.APStudyPresenceHeartbeat;
        const nav = document.querySelector("global.thenav[data-user-email]");
        if (!nav || typeof window.fetch !== "function") return;
        window.APStudyPresenceHeartbeatStarted = true;

        const tabKey = "apstudy-presence-tab-id";
        const siteHeartbeatMs = 60000;
        const chatHeartbeatMs = 15000;
        const chatRoomScopeKey = "chat-room";
        const extraScopes = new Map();
        let intervalId = null;
        let stopped = false;
        let focusPaused = false;
        let tabId = "";
        try {
            tabId = window.sessionStorage.getItem(tabKey) || "";
        } catch {
            tabId = "";
        }
        if (!tabId) {
            const random = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            tabId = random.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
            try {
                window.sessionStorage.setItem(tabKey, tabId);
            } catch {
                // In private or locked-down contexts, a memory-only tab id is fine.
            }
        }

        function isChatPage() {
            return window.location.pathname === "/chat";
        }

        function heartbeatIntervalMs() {
            return document.hidden ? siteHeartbeatMs : (isChatPage() ? chatHeartbeatMs : siteHeartbeatMs);
        }

        function pageScopes() {
            if (!isChatPage()) return [{ scope_type: "site", scope_id: "global" }];
            const scopes = [{ scope_type: "chat", scope_id: "global" }];
            for (const scope of extraScopes.values()) {
                if (scope?.scope_type && scope?.scope_id) scopes.push(scope);
            }
            return scopes;
        }

        function postHeartbeat(scopes, keepalive) {
            if (stopped) return Promise.resolve();
            const body = JSON.stringify({ scopes, tab_id: tabId });
            return window.fetch("/api/presence/heartbeat", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body,
                credentials: "same-origin",
                keepalive,
            }).catch(() => {});
        }

        function sendHeartbeat({ keepalive = false } = {}) {
            if (stopped) return Promise.resolve();
            return postHeartbeat(pageScopes(), keepalive);
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
            if (focusPaused) return;
            void sendHeartbeat();
            startTimer();
        }

        function setFocusPaused(active) {
            focusPaused = active === true;
            if (focusPaused) pauseHeartbeat();
            else resumeHeartbeat();
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

        focusPaused = document.body.classList.contains("focus-mode-active");
        if (!focusPaused) {
            sendHeartbeat();
            startTimer();
        }
        window.addEventListener("apstudy:focus-state", (event) => {
            setFocusPaused(event.detail?.active === true);
        });
        document.addEventListener("visibilitychange", () => {
            void sendHeartbeat({ keepalive: true });
            if (!focusPaused && !stopped) startTimer();
        });
        if (window.APStudyPageLifecycle?.register) {
            window.APStudyPageLifecycle.register({
                pause: pauseHeartbeat,
                resume: resumeHeartbeat,
                dispose: pauseHeartbeat,
            });
        } else {
            window.addEventListener("pagehide", pauseHeartbeat, { once: true });
        }
        return {
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

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.presence = Object.freeze({ initializePresenceHeartbeat });
})();
