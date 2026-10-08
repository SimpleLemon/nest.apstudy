import * as React from "react";
import { getFloatingPosition, shouldCloseFloatingLayer } from "./task-floating.js";

// Controls retain their sizing, focus and selection rules; this hook owns the
// resources attached to an open anchored layer.
export function useTaskFloatingLayer({ open, setOpen, rootRef, triggerRef, floatingRef, initialWidth, getWidth, repositionOn = [] }) {
    const [position, setPosition] = React.useState({ top: 0, left: 0, width: initialWidth, ready: false });
    React.useLayoutEffect(() => {
        if (!open || !triggerRef.current || !floatingRef.current) return undefined;
        const closeOutside = (event) => {
            if (shouldCloseFloatingLayer(event, { layers: [rootRef.current, floatingRef.current] })) setOpen(false);
        };
        const reposition = () => {
            const anchor = triggerRef.current?.getBoundingClientRect();
            const layer = floatingRef.current;
            if (!anchor || !layer) return;
            const width = getWidth(anchor);
            layer.style.width = `${width}px`;
            const next = getFloatingPosition(anchor, layer.getBoundingClientRect(), { align: "start", gap: 5 });
            setPosition({ ...next, width, ready: true });
        };
        reposition();
        document.addEventListener("pointerdown", closeOutside);
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", reposition);
        window.visualViewport?.addEventListener("resize", reposition);
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
        observer?.observe(floatingRef.current);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
            window.visualViewport?.removeEventListener("resize", reposition);
            observer?.disconnect();
        };
    }, [open, setOpen, rootRef, triggerRef, floatingRef, getWidth, ...repositionOn]);
    return position;
}
