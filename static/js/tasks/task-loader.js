(function () {
    const DEFAULT_TIMEOUT_MS = 12000;
    let state = "loading";
    let timeoutId = null;

    function taskRoot() {
        return document.getElementById("task-root");
    }

    function renderError() {
        const root = taskRoot();
        if (!root || state !== "error") return;
        root.dataset.taskAppState = "error";
        root.replaceChildren();

        const panel = document.createElement("section");
        panel.className = "task-load-error";
        panel.setAttribute("role", "alert");
        panel.setAttribute("aria-live", "assertive");

        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "error";

        const title = document.createElement("h1");
        title.textContent = "Tasks couldn’t start";
        const message = document.createElement("p");
        message.textContent = "The local Tasks application failed to initialize. Reload the page to try again.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Reload Tasks";
        retry.addEventListener("click", () => window.location.reload());
        panel.append(icon, title, message, retry);
        root.appendChild(panel);
        retry.focus();
    }

    function fail() {
        if (state === "error") return;
        state = "error";
        if (timeoutId) window.clearTimeout(timeoutId);
        renderError();
    }

    function ready() {
        if (state !== "loading") return;
        state = "ready";
        if (timeoutId) window.clearTimeout(timeoutId);
        const root = taskRoot();
        if (root) root.dataset.taskAppState = "ready";
    }

    function startWatchdog() {
        if (state === "error") {
            renderError();
            return;
        }
        if (state !== "loading") return;
        const configuredTimeout = Number(window.APSTUDY_TASK_LOAD_TIMEOUT_MS);
        const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
            ? configuredTimeout
            : DEFAULT_TIMEOUT_MS;
        timeoutId = window.setTimeout(fail, timeoutMs);
    }

    window.addEventListener("error", (event) => {
        const target = event.target;
        if (state === "loading" && target?.matches?.("script[data-task-app-entry]")) fail();
    }, true);
    document.addEventListener("DOMContentLoaded", startWatchdog, { once: true });
    window.APStudyTaskLoader = { fail, ready };
}());
