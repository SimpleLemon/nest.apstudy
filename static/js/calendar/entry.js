import { createCalendarLifecycle } from "./lifecycle.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { mountCalendar } from "./index.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarDataAdapter } from "./adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

let activeDispose = null;

export function bootCalendar(root = document.querySelector("#calendar-view-root"), capabilities = {}) {
    activeDispose?.();
    activeDispose = null;
    if (!root || root.nodeType !== 1) return () => {};

    const pageRoot = capabilities.pageRoot?.nodeType === 1
        ? capabilities.pageRoot
        : root.closest?.("#calendar-app-root") || root;
    const runtimeWindow = capabilities.window || capabilities.view || root.ownerDocument?.defaultView || globalThis;
    const lifecycle = capabilities.lifecycle || createCalendarLifecycle({
        view: runtimeWindow,
    });
    const handle = mountCalendar(root, createCalendarDataAdapter(capabilities.adapterOverrides, { window: runtimeWindow }), {
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
