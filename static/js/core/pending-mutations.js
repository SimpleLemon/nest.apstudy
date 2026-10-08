/* global window, CustomEvent */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function createPendingMutations({ window, document }) {
        const activeTokens = new Set();

        function notify() {
            document.documentElement.toggleAttribute("data-pending-save", activeTokens.size > 0);
            window.dispatchEvent(new CustomEvent("apstudy-pending-save-change", {
                detail: { pending: activeTokens.size },
            }));
        }

        function begin(label = "save") {
            const token = { label, startedAt: Date.now() };
            activeTokens.add(token);
            notify();
            let ended = false;
            return () => {
                if (ended) return;
                ended = true;
                activeTokens.delete(token);
                notify();
            };
        }

        function track(promise, label = "save") {
            const end = begin(label);
            return Promise.resolve(promise).finally(end);
        }

        const pendingMutations = {
            begin,
            track,
            hasPending: () => activeTokens.size > 0,
            count: () => activeTokens.size,
        };

        window.addEventListener("beforeunload", (event) => {
            if (!activeTokens.size) return;
            event.preventDefault();
            event.returnValue = "";
        });
        return pendingMutations;
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.pendingMutations = Object.freeze({ createPendingMutations });
})();
