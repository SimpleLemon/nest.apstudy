// Calendar context menu: intercept right-clicks and show custom menu
(function () {
    const rootSelector = "#calendar-view-root";
    let menuEl = null;
    let currentContext = null;

    function ensureMenu() {
        if (menuEl) return menuEl;
        menuEl = document.createElement("div");
        menuEl.setAttribute("role", "menu");
        menuEl.setAttribute("aria-label", "Calendar context menu");
        menuEl.className = "calendar-right-click-menu";
        menuEl.style.position = "fixed";
        menuEl.style.minWidth = "170px";
        menuEl.style.display = "none";
        document.body.appendChild(menuEl);

        return menuEl;
    }

    function closeMenu() {
        if (!menuEl) return;
        menuEl.style.display = "none";
        menuEl.innerHTML = "";
        currentContext = null;
    }

    function buildMenu(items) {
        const el = ensureMenu();
        el.innerHTML = "";
        items.forEach((it, i) => {
            const btn = document.createElement("button");
            btn.setAttribute("role", "menuitem");
            btn.className = `calendar-right-click-item${it.danger ? " is-danger" : ""}`;
            btn.disabled = Boolean(it.disabled);
            btn.innerHTML = `
                <span class="material-symbols-outlined calendar-right-click-icon">${it.icon || "radio_button_unchecked"}</span>
                <span>${it.label}</span>
            `;
            btn.tabIndex = i === 0 ? 0 : -1;
            btn.addEventListener("click", (e) => {
                if (btn.disabled) return;
                it.onClick(currentContext);
                closeMenu();
            });
            el.appendChild(btn);
        });
        return el;
    }

    function onContextMenu(e) {
        const root = document.querySelector(rootSelector);
        if (!root) return;
        // only handle right-clicks within calendar root
        if (!root.contains(e.target)) return;

        e.preventDefault();
        const context = {
            x: e.clientX,
            y: e.clientY,
            eventId: null,
            eventRef: null,
            event: null,
            date: null,
            time: null,
            anchorEl: null,
        };
        // detect event element
        const eventEl = e.target.closest && e.target.closest('[data-event-ref], [data-event-id]');
        const dateAttrEl = e.target.closest && e.target.closest('[data-date]');
        const timeAttrEl = e.target.closest && e.target.closest('[data-time]');

        context.eventId = eventEl ? eventEl.getAttribute('data-event-id') : null;
        context.eventRef = eventEl ? (eventEl.getAttribute('data-event-ref') || context.eventId) : null;
        context.event = context.eventRef && window.getCalendarEventByRef ? window.getCalendarEventByRef(context.eventRef) : null;
        context.date = dateAttrEl ? dateAttrEl.getAttribute('data-date') : null;
        context.time = timeAttrEl ? timeAttrEl.getAttribute('data-time') : null;
        context.anchorEl = eventEl || dateAttrEl || e.target;

        // prepare context
        currentContext = context;

        // if menu open, replace
        closeMenu();
        currentContext = context;

        if (context.eventId) {
            const isSimulated = context.event?.source === "simulated";
            const items = [
                { label: 'View / Edit Event', icon: 'edit_calendar', onClick: openEdit, disabled: isSimulated || !context.event },
                { label: 'Duplicate Event', icon: 'content_copy', onClick: duplicateEvent, disabled: !context.event },
                { label: 'Delete Event', icon: 'delete', onClick: deleteEvent, danger: true, disabled: isSimulated || !context.event },
            ];
            const el = buildMenu(items);
            showMenuAt(context.x, context.y, el);
            return;
        }

        // empty slot
        const items = [
            { label: 'Create New Event', icon: 'calendar_add_on', onClick: createNewFromContext },
            { label: 'Go to Today', icon: 'today', onClick: goToToday },
        ];
        const el = buildMenu(items);
        showMenuAt(context.x, context.y, el);
    }

    function showMenuAt(x, y, el) {
        const menu = ensureMenu();
        menu.style.display = "block";
        // position and avoid overflow
        const pad = 8;
        const rect = menu.getBoundingClientRect();
        let left = x;
        let top = y;
        if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
        if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        // focus first item
        const first = menu.querySelector("[role=menuitem]");
        if (first) {
            menu.querySelectorAll("[role=menuitem]").forEach((it) => (it.tabIndex = -1));
            first.tabIndex = 0;
            first.focus();
        }
    }

    // action handlers
    function createNewFromContext(ctx) {
        const startDate = ctx.date;
        const time = ctx.time;
        const payload = {};
        if (startDate && time) {
            payload.start = `${startDate}T${time}:00`;
            // compute end one hour later
            const dt = new Date(`${startDate}T${time}:00`);
            dt.setHours(dt.getHours() + 1);
            payload.end = dt.toISOString();
        } else if (startDate) {
            payload.start = `${startDate}T09:00:00`;
            payload.end = `${startDate}T10:00:00`;
        }
        // open form
        window.openCalendarEventForm && window.openCalendarEventForm({ mode: 'create', data: payload });
    }

    function goToToday() {
        if (window.state) {
            window.state.anchorDate = new Date();
            window.render && window.render();
            if (window.ensureEventsForRange && window.getBufferedRangeForView) {
                window.ensureEventsForRange(window.getBufferedRangeForView());
            }
        }
    }

    function formDataForEvent(event) {
        if (!event) return null;
        return {
            ...event,
            start: event.start || event.startDate,
            end: event.end || event.endDate,
            all_day: event.all_day || event.is_all_day || event.isAllDay,
        };
    }

    function isImportedEvent(event) {
        return Boolean(event?.event_ref && String(event.event_ref).startsWith("feed:"));
    }

    function openEdit(ctx) {
        const event = ctx.event || null;
        const data = formDataForEvent(event);
        if (!data) return;
        const mode = isImportedEvent(event) ? 'override' : 'edit';
        window.openCalendarEventForm && window.openCalendarEventForm({ mode, data });
    }

    function duplicateEvent(ctx) {
        const event = ctx.event || null;
        const data = formDataForEvent(event);
        if (!data) return;
        data.title = `${data.title || 'Untitled'} (Copy)`;
        delete data.id;
        delete data.event_ref;
        window.openCalendarEventForm && window.openCalendarEventForm({ mode: 'create', data });
    }

    async function deleteEvent(ctx) {
        const event = ctx.event || null;
        if (!event) return;
        if (!confirm('Are you sure you want to delete this event?')) return;
        try {
            const res = isImportedEvent(event)
                ? await fetch('/api/calendar/event-overrides/hide', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ event_ref: event.event_ref }),
                })
                : await fetch(`/api/calendar/events/${encodeURIComponent(event.id || ctx.eventId)}`, { method: 'DELETE', credentials: 'same-origin' });
            if (!res.ok) throw new Error('delete failed');
            localStorage.removeItem('calendarEventsCache');
            window.loadCalendarData && window.loadCalendarData();
        } catch (err) {
            alert('Unable to delete event');
        }
    }

    // attach
    document.addEventListener('DOMContentLoaded', () => {
        const root = document.querySelector(rootSelector);
        if (!root) return;
        root.addEventListener('contextmenu', onContextMenu);
        // close on scroll of the calendar scroller
        const scroller = document.getElementById('calendar-week-time-scroller');
        if (scroller) scroller.addEventListener('scroll', closeMenu);
        // persistent document listeners for dismissal and keyboard handling
        document.addEventListener('click', (e) => {
            // ignore right-click mouse events which have button === 2
            if (e instanceof MouseEvent && e.button === 2) return;
            if (!menuEl) return;
            if (menuEl.style.display === 'none') return;
            if (!menuEl.contains(e.target)) closeMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (!menuEl || menuEl.style.display === 'none') return;
            const items = Array.from(menuEl.querySelectorAll('[role=menuitem]'));
            const idx = items.findIndex((it) => it.tabIndex === 0);
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMenu();
                (currentContext && currentContext.anchorEl)?.focus?.();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = items[(idx + 1) % items.length] || items[0];
                items.forEach((it) => (it.tabIndex = -1));
                next.tabIndex = 0;
                next.focus();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = items[(idx - 1 + items.length) % items.length] || items[items.length - 1];
                items.forEach((it) => (it.tabIndex = -1));
                prev.tabIndex = 0;
                prev.focus();
                return;
            }
            if (e.key === 'Tab') {
                closeMenu();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                items[idx] && items[idx].click();
            }
        });
    });

})();
