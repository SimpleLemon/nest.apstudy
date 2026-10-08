/* global window, document, console */

import("/static/js/core/cookie-consent.js").catch((error) => {
    console.error("Unable to initialize cookie consent", error);
});
import("/static/js/core/viewport-sizing.js")
    .then(({ installViewportSizing }) => installViewportSizing())
    .catch((error) => console.error("Unable to initialize viewport sizing", error));

// These definitions load synchronously before this deferred classic entry point.
// Keep the compatibility bridge here so classic feature consumers retain their order.
const coreServices = window.APStudyCoreServices;
window.APStudyCsrf = coreServices.csrf.installCsrfFetch({ window, document });
window.APStudyPendingMutations = window.APStudyPendingMutations
    || coreServices.pendingMutations.createPendingMutations({ window, document });
window.APStudyAccessibility = window.APStudyAccessibility
    || coreServices.accessibility.installAccessibility({ window, document });
window.APStudyDate = { ...coreServices.dateTime };
window.APStudyHttp = window.APStudyHttp || coreServices.http.createHttpService({
    window,
    csrf: window.APStudyCsrf,
    pendingMutations: window.APStudyPendingMutations,
});
const sessionService = coreServices.session.createSessionService({ window, document });
function runLogoutFlow() {
    return sessionService.logout();
}
window.APStudyAuth = window.APStudyAuth || {};
window.APStudyAuth.logout = runLogoutFlow;

const shellChrome = coreServices.shellChrome.createShellChrome({ window, document, logout: runLogoutFlow });
function initializeGlobalChrome() {
    shellChrome.drainServerToasts();
    window.APStudyPresenceHeartbeat = coreServices.presence.initializePresenceHeartbeat({ window, document })
        || window.APStudyPresenceHeartbeat;
    shellChrome.initializeGlobalChrome();
}
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeGlobalChrome);
} else {
    initializeGlobalChrome();
}
