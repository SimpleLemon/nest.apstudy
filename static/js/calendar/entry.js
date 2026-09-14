import "./events/mirrors.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "../core/ui-primitives-module.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./utils.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./state.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./core.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./integrations/course-modal.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./integrations/courses.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./menu.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./preferences.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./integrations/data.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./views/event-render.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./events/ui-actions.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./views/agenda.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./views/month-view.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./views/week-view.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./views/render-shell.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./integrations/sources.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./integrations/share.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./controls.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./bootstrap.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./events/context-menu.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import "./events/event-form.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import { createCalendarLifecycle } from "./lifecycle.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import { mountCalendar } from "./index.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";
import { createCalendarDataAdapter } from "./adapter.js?v=7e3e3ee30482c8c534bd8b5f6c9bec6885ade0f3e55fdd15db3757768a8aede1";

let activeDispose = null;

export function bootCalendar(root = document.querySelector("#calendar-view-root"), capabilities = {}) {
    activeDispose?.();
    activeDispose = null;
    if (!root || root.nodeType !== 1) return () => {};

    const pageRoot = capabilities.pageRoot?.nodeType === 1
        ? capabilities.pageRoot
        : root.closest?.("#calendar-app-root") || root;
    const lifecycle = capabilities.lifecycle || createCalendarLifecycle({
        view: capabilities.view || root.ownerDocument?.defaultView || globalThis,
    });
    const handle = mountCalendar(root, createCalendarDataAdapter(capabilities.adapterOverrides), {
        ...capabilities,
        lifecycle,
        pageRoot,
    });
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        handle();
        if (activeDispose === dispose) activeDispose = null;
    };
    activeDispose = dispose;
    return dispose;
}

if (typeof document !== "undefined") bootCalendar();
