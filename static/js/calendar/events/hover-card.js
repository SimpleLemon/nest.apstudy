// Event hover and keyboard-focus previews share one tooltip and mounted lifecycle.
export function createCalendarHoverCard({ root, runtimeWindow: view, lifecycle, state,
    getCalendarEventByRef, getEventCalendarLabel, formatters }) {
    const { escapeHtml, formatAllDayRange, formatMultilineText, formatTimedEventRange } = formatters;
    const doc = root.ownerDocument || root;
    const ElementConstructor = view.Element || globalThis.Element;
    const query = (selector) => root?.querySelector?.(selector);
    const listen = (target, type, handler, options) => lifecycle?.addEventListener
        ? lifecycle.addEventListener(target, type, handler, options)
        : target?.addEventListener(type, handler, options);

    function wireCalendarHoverCard() {
        const viewRoot = query("#calendar-view-root");
        if (!viewRoot) return;
        listen(viewRoot, "pointerover", (event) => {
            if (event.pointerType === "touch") return;
            const eventEl = getCalendarEventElement(event.target);
            if (!eventEl) return;
            if (event.relatedTarget && eventEl.contains(event.relatedTarget)) return;
            showCalendarHoverCard(eventEl);
        });
        listen(viewRoot, "pointerout", (event) => {
            const eventEl = getCalendarEventElement(event.target);
            if (!eventEl) return;
            const related = event.relatedTarget;
            if (related && (eventEl.contains(related) || state.ui.hoverCardEl?.contains(related))) return;
            scheduleCalendarHoverCardHide();
        });
        listen(viewRoot, "focusin", (event) => {
            const eventEl = getCalendarEventElement(event.target);
            if (eventEl) showCalendarHoverCard(eventEl);
        });
        listen(viewRoot, "focusout", (event) => {
            const related = event.relatedTarget;
            if (related && state.ui.hoverCardEl?.contains(related)) return;
            scheduleCalendarHoverCardHide(80);
        });
    }

    function getCalendarEventElement(target) {
        if (ElementConstructor && !(target instanceof ElementConstructor)) return null;
        const viewRoot = query("#calendar-view-root");
        const eventEl = target.closest("[data-event-ref]");
        return eventEl && viewRoot?.contains(eventEl) ? eventEl : null;
    }

    function ensureCalendarHoverCard() {
        if (state.ui.hoverCardEl) return state.ui.hoverCardEl;
        const card = doc.createElement("div");
        card.className = "calendar-event-hover-card";
        card.setAttribute("role", "tooltip");
        card.hidden = true;
        listen(card, "pointerenter", () => {
            if (state.ui.hoverCardHideTimer) {
                lifecycle?.clearTimeout?.(state.ui.hoverCardHideTimer);
                state.ui.hoverCardHideTimer = null;
            }
        });
        listen(card, "pointerleave", () => scheduleCalendarHoverCardHide());
        root.appendChild(card);
        lifecycle?.trackNode?.(card);
        state.ui.hoverCardEl = card;
        return card;
    }

    function showCalendarHoverCard(anchorEl) {
        const eventRef = anchorEl.getAttribute("data-event-ref");
        const event = getCalendarEventByRef(eventRef);
        if (!event) return;
        if (state.ui.hoverCardHideTimer) {
            lifecycle?.clearTimeout?.(state.ui.hoverCardHideTimer);
            state.ui.hoverCardHideTimer = null;
        }
        const card = ensureCalendarHoverCard();
        state.ui.hoverCardAnchorEl = anchorEl;
        card.innerHTML = buildCalendarHoverCardHtml(event);
        card.hidden = false;
        card.style.visibility = "hidden";
        positionCalendarHoverCard();
        card.style.visibility = "";
    }

    function scheduleCalendarHoverCardHide(delayMs = 120) {
        if (state.ui.hoverCardHideTimer) lifecycle?.clearTimeout?.(state.ui.hoverCardHideTimer);
        const schedule = lifecycle?.setTimeout || view.setTimeout.bind(view);
        state.ui.hoverCardHideTimer = schedule(() => {
            hideCalendarHoverCard();
        }, delayMs);
    }

    function hideCalendarHoverCard() {
        if (state.ui.hoverCardHideTimer) {
            lifecycle?.clearTimeout?.(state.ui.hoverCardHideTimer);
            state.ui.hoverCardHideTimer = null;
        }
        if (state.ui.hoverCardEl) {
            state.ui.hoverCardEl.hidden = true;
            state.ui.hoverCardEl.innerHTML = "";
        }
        state.ui.hoverCardAnchorEl = null;
    }

    function positionCalendarHoverCard() {
        const card = state.ui.hoverCardEl;
        const anchorEl = state.ui.hoverCardAnchorEl;
        if (!card || card.hidden || !anchorEl || !root.contains(anchorEl)) return;
        const margin = 12;
        const gap = 8;
        const wide = view.innerWidth >= 900;
        const preferredWidth = wide ? 420 : 320;
        const width = Math.max(260, Math.min(preferredWidth, view.innerWidth - margin * 2));
        card.style.width = `${width}px`;
        card.style.maxHeight = `${Math.max(180, view.innerHeight - margin * 2)}px`;
        card.style.left = "0px";
        card.style.top = "0px";
        const anchorRect = anchorEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        let left = anchorRect.left;
        let top = anchorRect.bottom + gap;
        if (wide && anchorRect.right + gap + cardRect.width + margin <= view.innerWidth) {
            left = anchorRect.right + gap;
            top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
        } else if (wide && anchorRect.left - gap - cardRect.width >= margin) {
            left = anchorRect.left - cardRect.width - gap;
            top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
        } else {
            const availableBelow = Math.max(0, view.innerHeight - anchorRect.bottom - gap - margin);
            const availableAbove = Math.max(0, anchorRect.top - gap - margin);
            const placeBelow = availableBelow >= availableAbove;
            const availableHeight = Math.max(120, placeBelow ? availableBelow : availableAbove);
            card.style.maxHeight = `${availableHeight}px`;
            const adjustedRect = card.getBoundingClientRect();
            if (left + cardRect.width + margin > view.innerWidth) {
                left = view.innerWidth - adjustedRect.width - margin;
            }
            if (left < margin) left = margin;
            top = placeBelow ? anchorRect.bottom + gap : anchorRect.top - adjustedRect.height - gap;
        }
        const finalRect = card.getBoundingClientRect();
        top = Math.min(Math.max(top, margin), Math.max(margin, view.innerHeight - finalRect.height - margin));
        card.style.left = `${Math.round(left)}px`;
        card.style.top = `${Math.round(top)}px`;
    }

    function buildCalendarHoverCardHtml(event) {
        const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
        const calendarLabel = getEventCalendarLabel(event);
        return `
            <div class="calendar-event-hover-title">${escapeHtml(event.title || "Untitled")}</div>
            <div class="calendar-event-hover-meta">${escapeHtml(timeDisplay)}</div>
            <div class="calendar-event-hover-calendar">${escapeHtml(calendarLabel)}</div>
            ${event.description ? `<div class="calendar-event-hover-description">${formatMultilineText(event.description)}</div>` : ""}
        `;
    }

    return { wire: wireCalendarHoverCard, hide: hideCalendarHoverCard, position: positionCalendarHoverCard };
}
