import * as React from "react";

const h = React.createElement;

export function AddTaskPopover({ popover, onClose, children }) {
    const popoverRef = React.useRef(null);
    const popoverKey = popover ? `${popover.type}:${popover.nonce || 0}` : "";
    const [position, setPosition] = React.useState({ key: "", top: 0, left: 0, ready: false });

    React.useEffect(() => {
        if (!popover) return undefined;
        const onPointerDown = (event) => {
            if (popoverRef.current?.contains(event.target)) return;
            if (event.target?.closest?.("[data-task-add-popover-trigger]")) return;
            onClose();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape") onClose();
        };
        const onScroll = () => onClose();
        const onResize = () => onClose();
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onResize);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
        };
    }, [popover, onClose]);

    React.useLayoutEffect(() => {
        if (!popover || !popoverRef.current) return;
        const popoverRect = popoverRef.current.getBoundingClientRect();
        const anchor = popover.anchor;
        const gap = 6;
        const margin = 8;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let left = anchor.left;
        if (left + popoverRect.width > viewportWidth - margin) {
            left = anchor.right - popoverRect.width;
        }
        left = Math.max(margin, Math.min(viewportWidth - popoverRect.width - margin, left));

        let top = anchor.bottom + gap;
        const aboveTop = anchor.top - popoverRect.height - gap;
        if (top + popoverRect.height > viewportHeight - margin && aboveTop >= margin) {
            top = aboveTop;
        }
        top = Math.max(margin, Math.min(viewportHeight - popoverRect.height - margin, top));
        setPosition({ key: popoverKey, top, left, ready: true });
    }, [popover, popoverKey, children]);

    if (!popover) return null;
    const ready = position.key === popoverKey && position.ready;
    return h("div", {
        ref: popoverRef,
        className: "task-add-popover",
        style: {
            top: `${ready ? position.top : 0}px`,
            left: `${ready ? position.left : 0}px`,
            visibility: ready ? "visible" : "hidden",
        },
    }, children);
}
