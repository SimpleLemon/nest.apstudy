/* global window, console */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function createSessionService({ window, document }) {
        function clearClientState(options = {}) {
            const includeCookies = options.includeCookies !== false;
            try {
                window.sessionStorage.clear();
            } catch (error) {
                console.warn("Failed to clear session storage", error);
            }

            try {
                window.localStorage.clear();
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
                window.sessionStorage.setItem("apstudy-logged-out", "true");
            } catch (error) {
                console.warn("Failed to mark logged out", error);
            }
        }

        async function runLogoutFlow() {
            window.APStudyPresenceHeartbeat?.stop?.();
            try {
                await window.APStudyNotifications?.disableCurrent?.();
            } catch (error) {
                console.warn('Unable to revoke this browser notification subscription during logout.', error);
            }
            clearClientState({ includeCookies: false });
            markClientLoggedOut();
            try {
                const response = await window.fetch("/logout", {
                    method: "POST",
                    credentials: "same-origin",
                });
                if (!response.ok) throw new Error("Logout failed");
                window.location.assign(`${window.location.origin}/login`);
            } catch (error) {
                console.error(error);
                window.APStudyToast?.show?.({
                    title: "Couldn’t log out",
                    message: "Refresh the page and try again.",
                    type: "error",
                });
            }
        }

        return { clearClientState, markClientLoggedOut, logout: runLogoutFlow };
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.session = Object.freeze({ createSessionService });
})();
