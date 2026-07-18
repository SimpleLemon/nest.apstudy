export function createViewportSizingController({
    root = document.documentElement,
    viewport = window.visualViewport,
    windowTarget = window,
    isCoarsePointer = () => window.matchMedia("(pointer: coarse)").matches,
} = {}) {
    let installed = false;

    function update() {
        if (!isCoarsePointer() || !viewport || !Number.isFinite(viewport.height)) {
            root.style.removeProperty("--app-viewport-height");
            return;
        }
        root.style.setProperty("--app-viewport-height", `${Math.round(viewport.height)}px`);
    }

    function install() {
        if (installed) return update;
        installed = true;
        viewport?.addEventListener?.("resize", update, { passive: true });
        viewport?.addEventListener?.("scroll", update, { passive: true });
        windowTarget?.addEventListener?.("orientationchange", update, { passive: true });
        update();
        return update;
    }

    function dispose() {
        if (!installed) return;
        installed = false;
        viewport?.removeEventListener?.("resize", update);
        viewport?.removeEventListener?.("scroll", update);
        windowTarget?.removeEventListener?.("orientationchange", update);
        root.style.removeProperty("--app-viewport-height");
    }

    return { install, update, dispose };
}

let activeController;

export function installViewportSizing() {
    if (activeController) return activeController;
    activeController = createViewportSizingController();
    activeController.install();
    return activeController;
}
