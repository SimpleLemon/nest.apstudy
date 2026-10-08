export function createCalendarLifecycle({ view = globalThis.window || globalThis } = {}) {
    const cleanups = new Set();
    const controllers = new Set();
    const timers = new Map();
    const frames = new Map();
    const observers = new Map();
    let disposed = false;

    // Returned releases are idempotent and relinquish their captured resources.
    function addCleanup(cleanup) {
        if (typeof cleanup !== "function") return cleanup;
        let pending = true;
        const release = () => {
            if (!pending) return;
            pending = false;
            cleanups.delete(release);
            cleanup();
        };
        if (disposed) release();
        else cleanups.add(release);
        return release;
    }

    function addEventListener(target, type, listener, options) {
        if (disposed || !target?.addEventListener || typeof listener !== "function") return () => {};
        target.addEventListener(type, listener, options);
        return addCleanup(() => target.removeEventListener(type, listener, options));
    }

    function setTimeoutTracked(callback, delay, ...args) {
        if (disposed) return null;
        const timer = (view.setTimeout || setTimeout).call(view, () => {
            timers.delete(timer);
            cleanups.delete(cancel);
            if (!disposed) callback(...args);
        }, delay);
        const cancel = addCleanup(() => {
            timers.delete(timer);
            (view.clearTimeout || clearTimeout).call(view, timer);
        });
        timers.set(timer, cancel);
        return timer;
    }

    function clearTimeoutTracked(timer) {
        if (timer == null) return;
        const cancel = timers.get(timer);
        if (cancel) cancel();
        else (view.clearTimeout || clearTimeout).call(view, timer);
    }

    function requestAnimationFrameTracked(callback) {
        if (disposed) return null;
        if (typeof view.requestAnimationFrame !== "function") return setTimeoutTracked(callback, 0);
        const frame = view.requestAnimationFrame(() => {
            frames.delete(frame);
            cleanups.delete(cancel);
            if (!disposed) callback();
        });
        const cancel = addCleanup(() => {
            frames.delete(frame);
            view.cancelAnimationFrame?.(frame);
        });
        frames.set(frame, cancel);
        return frame;
    }

    function cancelAnimationFrameTracked(frame) {
        if (frame == null) return;
        const cancel = frames.get(frame);
        if (cancel) cancel();
        else if (typeof view.requestAnimationFrame !== "function") clearTimeoutTracked(frame);
        else view.cancelAnimationFrame?.(frame);
    }

    function trackAbortController(controller) {
        const AbortControllerConstructor = view.AbortController || globalThis.AbortController;
        controller ||= new AbortControllerConstructor();
        if (disposed) controller.abort();
        else controllers.add(controller);
        return controller;
    }

    function releaseAbortController(controller) {
        controllers.delete(controller);
    }

    function trackObserver(observer) {
        if (!observer || typeof observer.disconnect !== "function") return observer;
        if (observers.has(observer)) return observers.get(observer);
        const release = addCleanup(() => {
            observers.delete(observer);
            observer.disconnect();
        });
        if (!disposed) observers.set(observer, release);
        return release;
    }

    function trackNode(node) {
        if (!node) return node;
        addCleanup(() => node.remove?.());
        return node;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const controller of controllers) controller.abort();
        controllers.clear();
        for (const release of Array.from(cleanups).reverse()) {
            try { release(); }
            catch (error) { console.warn("Calendar cleanup failed:", error); }
        }
        cleanups.clear();
    }

    return {
        addCleanup,
        addEventListener,
        cancelAnimationFrame: cancelAnimationFrameTracked,
        clearTimeout: clearTimeoutTracked,
        dispose,
        isDisposed: () => disposed,
        requestAnimationFrame: requestAnimationFrameTracked,
        releaseAbortController,
        setTimeout: setTimeoutTracked,
        trackAbortController,
        trackObserver,
        trackNode,
    };
}
