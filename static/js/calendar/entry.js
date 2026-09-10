import "./events/mirrors.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "../core/ui-primitives-module.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./utils.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./state.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./core.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./integrations/course-modal.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./integrations/courses.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./menu.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./preferences.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./integrations/data.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./views/event-render.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./events/ui-actions.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./views/agenda.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./views/month-view.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./views/week-view.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./views/render-shell.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./integrations/sources.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./integrations/share.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./controls.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./bootstrap.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./events/context-menu.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import "./events/event-form.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import { createCalendarLifecycle } from "./lifecycle.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import { mountCalendar } from "./index.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";
import { createCalendarDataAdapter } from "./adapter.js?v=1e75801d25f6271e96ea7e96b04b0ba16d0d8f7c77974becbf1d7022ca58f4d3";

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
