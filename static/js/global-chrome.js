(() => {
    if (window.APStudyPendingMutations) return;

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

    window.APStudyPendingMutations = {
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
})();

(() => {
    if (window.APStudyConfirm) return;

    let activeRequest = null;

    function ensureDialog() {
        let root = document.getElementById("apstudy-confirm-root");
        if (root) return root;

        root = document.createElement("div");
        root.id = "apstudy-confirm-root";
        root.className = "apstudy-confirm";
        root.hidden = true;
        root.innerHTML = `
            <div class="apstudy-confirm__panel" role="dialog" aria-modal="true" aria-labelledby="apstudy-confirm-title" aria-describedby="apstudy-confirm-message">
                <div class="apstudy-confirm__icon" aria-hidden="true">
                    <span class="material-symbols-outlined">warning</span>
                </div>
                <div class="apstudy-confirm__copy">
                    <h2 id="apstudy-confirm-title">Are you sure?</h2>
                    <p id="apstudy-confirm-message"></p>
                </div>
                <div class="apstudy-confirm__actions">
                    <button type="button" class="apstudy-confirm__cancel">Cancel</button>
                    <button type="button" class="apstudy-confirm__accept">Delete</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        root.addEventListener("pointerdown", (event) => {
            if (event.target === root) closeDialog(false);
        });
        root.querySelector(".apstudy-confirm__cancel")?.addEventListener("click", () => closeDialog(false));
        root.querySelector(".apstudy-confirm__accept")?.addEventListener("click", () => closeDialog(true));
        document.addEventListener("keydown", (event) => {
            if (!activeRequest || event.key !== "Escape") return;
            event.preventDefault();
            closeDialog(false);
        });

        return root;
    }

    function closeDialog(value) {
        if (!activeRequest) return;
        const request = activeRequest;
        activeRequest = null;
        request.root.hidden = true;
        request.root.classList.remove("is-danger");
        document.body.classList.remove("apstudy-confirm-open");
        request.resolve(Boolean(value));
        request.previousFocus?.focus?.({ preventScroll: true });
    }

    function request(options = {}) {
        if (activeRequest) closeDialog(false);

        const root = ensureDialog();
        const title = String(options.title || "Are you sure?");
        const message = String(options.message || "This action cannot be undone.");
        const acceptLabel = String(options.acceptLabel || options.confirmLabel || "Delete");
        const cancelLabel = String(options.cancelLabel || "Cancel");
        const danger = options.danger !== false;

        root.querySelector("#apstudy-confirm-title").textContent = title;
        root.querySelector("#apstudy-confirm-message").textContent = message;
        root.querySelector(".apstudy-confirm__accept").textContent = acceptLabel;
        root.querySelector(".apstudy-confirm__cancel").textContent = cancelLabel;
        root.classList.toggle("is-danger", danger);
        root.hidden = false;
        document.body.classList.add("apstudy-confirm-open");

        return new Promise((resolve) => {
            activeRequest = {
                root,
                resolve,
                previousFocus: document.activeElement,
            };
            requestAnimationFrame(() => {
                root.querySelector(".apstudy-confirm__cancel")?.focus({ preventScroll: true });
            });
        });
    }

    window.APStudyConfirm = { request };
})();

(() => {
    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function loadingHtml(label = "Loading...", options = {}) {
        const sizePx = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
        const textToneClass = options.textToneClass || "text-on-surface-variant";
        return `
            <div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${escapeHtml(textToneClass)}">
                <span class="loader" style="width:${sizePx}px; height:${sizePx}px;" aria-hidden="true"></span>
                <span>${escapeHtml(label)}</span>
            </div>
        `;
    }

    window.APStudyLoader = {
        html: loadingHtml,
    };
})();

(() => {
    const pad2 = (value) => String(value).padStart(2, "0");

    function toLocalInputValue(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function isoToLocalInput(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : toLocalInputValue(date);
    }

    function localInputToIso(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    window.APStudyDate = {
        toLocalInputValue,
        isoToLocalInput,
        localInputToIso,
    };
})();
