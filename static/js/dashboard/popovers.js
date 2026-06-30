(function () {
    function create({ state, escapeHtml, eventDateKey, groupEventsByDate }) {
        function bindCalendarPopoverTrigger(trigger, date, events) {
            if (!trigger || !date || !events.length) return;
            trigger.addEventListener("mouseenter", () => {
                if (!state.editMode && !state.activePopoverLocked) showPopover(trigger, date, events);
            });
            trigger.addEventListener("mouseleave", () => {
                if (!state.editMode && !state.activePopoverLocked) hidePopover();
            });
            trigger.addEventListener("focus", () => {
                if (!state.editMode && !state.activePopoverLocked) showPopover(trigger, date, events);
            });
            trigger.addEventListener("blur", () => {
                if (!state.editMode && !state.activePopoverLocked) hidePopover();
            });
            trigger.addEventListener("click", (event) => {
                if (state.editMode) return;
                event.stopPropagation();
                state.activePopoverLocked = true;
                showPopover(trigger, date, events);
            });
        }

        function bindCalendarPopovers() {
            document.querySelectorAll(".dashboard-calendar").forEach((root) => {
                let events = [];
                try {
                    events = JSON.parse(root.dataset.calendarEvents || "[]");
                } catch {
                    events = [];
                }
                const eventsByDate = groupEventsByDate(events);
                root.querySelectorAll(".dashboard-day").forEach((dayButton) => {
                    const date = dayButton.dataset.date;
                    bindCalendarPopoverTrigger(dayButton, date, eventsByDate.get(date) || []);
                });
            });
            document.querySelectorAll(".dashboard-calendar-upcoming-item").forEach((item) => {
                let eventData = null;
                try {
                    eventData = JSON.parse(item.dataset.calendarEvent || "null");
                } catch {
                    eventData = null;
                }
                if (!eventData) return;
                bindCalendarPopoverTrigger(item, item.dataset.date || eventDateKey(eventData), [eventData]);
            });
        }

        function ensurePopover() {
            let popover = document.getElementById("dashboard-popover");
            if (popover) return popover;
            popover = document.createElement("div");
            popover.id = "dashboard-popover";
            popover.className = "dashboard-popover";
            popover.hidden = true;
            document.body.appendChild(popover);
            return popover;
        }

        function showPopover(anchor, date, events) {
            const popover = ensurePopover();
            const labelDate = new Date(`${date}T00:00:00`);
            const title = Number.isNaN(labelDate.getTime())
                ? date
                : labelDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
            popover.innerHTML = `
                <h3>${escapeHtml(title)}</h3>
                <ul>
                    ${events.slice(0, 8).map((event) => `
                        <li>
                            <span class="dashboard-popover-dot" style="--marker-color:${escapeHtml(event.color || "#6366f1")}"></span>
                            <span>${escapeHtml(event.title || "Untitled event")}</span>
                        </li>
                    `).join("")}
                </ul>
            `;
            popover.hidden = false;
            const rect = anchor.getBoundingClientRect();
            const popoverRect = popover.getBoundingClientRect();
            const gap = 8;
            let left = rect.left;
            let top = rect.bottom + gap;
            if (left + popoverRect.width > window.innerWidth - gap) {
                left = window.innerWidth - popoverRect.width - gap;
            }
            if (top + popoverRect.height > window.innerHeight - gap) {
                top = Math.max(gap, rect.top - popoverRect.height - gap);
            }
            popover.style.left = `${Math.max(gap, left)}px`;
            popover.style.top = `${top}px`;
        }

        function hidePopover() {
            const popover = document.getElementById("dashboard-popover");
            if (popover) popover.hidden = true;
        }

        return {
            bindCalendarPopoverTrigger,
            bindCalendarPopovers,
            hidePopover,
        };
    }

    window.APStudyDashboardPopovers = { create };
}());
