(function () {
    function createCalendarUiActions({
        state,
        callbacks,
        formatters,
    }) {
        const {
            getCalendarEventColor,
            getCalendarEventCount,
            getCalendarLabel,
            getEventBadgeColors,
            getEventBadgeStyle,
            getEventElementAttributes,
            openCalendarInfoModal,
            openRgbModal,
            setCalendarColor,
        } = callbacks;
        const {
            escapeHtml,
            isTaskEvent,
        } = formatters;

        function closeCalendarContextMenu() {
            if (state.ui.contextMenuEl) {
                state.ui.contextMenuEl.remove();
                state.ui.contextMenuEl = null;
            }
            state.ui.contextAnchorEl = null;
            state.ui.contextCalendarName = null;
        }

        function openCalendarContextMenu(calendarName, anchorEl) {
            closeCalendarContextMenu();
            state.ui.contextCalendarName = calendarName;
            state.ui.contextAnchorEl = anchorEl;
            const currentColor = state.calendars[calendarName]?.color || "#6366f1";
            const eventCount = getCalendarEventCount(calendarName);
            const label = getCalendarLabel(calendarName);
            const menu = document.createElement("div");
            menu.className = "calendar-context-menu fixed";
            menu.innerHTML = `
                <div class="calendar-context-header">
                    <div class="calendar-context-title">${escapeHtml(label)}</div>
                    <div class="calendar-context-meta">${eventCount} event${eventCount === 1 ? "" : "s"}</div>
                </div>
                <div class="calendar-context-body">
                    <button type="button" class="js-context-info calendar-context-action">
                        <span class="material-symbols-outlined calendar-context-action-icon">info</span>
                        <span>Get Info</span>
                    </button>
                    <div class="calendar-context-separator"></div>
                    <div class="calendar-context-colors">
                        <div class="calendar-context-section-label">Colors</div>
                        <div class="calendar-context-color-grid">
                            ${state.calendarColors.map((color) => `
                                <button type="button"
                                    class="js-context-preset calendar-context-preset"
                                    data-color="${color}"
                                    aria-label="Use ${escapeHtml(color)}"
                                    style="background:${color}; border-color:${currentColor === color ? "var(--color-on-surface)" : "transparent"};">
                                </button>
                            `).join("")}
                        </div>
                    </div>
                    <div class="calendar-context-separator"></div>
                    <button type="button" class="js-context-custom calendar-context-action">
                        <span class="material-symbols-outlined calendar-context-action-icon">palette</span>
                        <span>Custom Color...</span>
                    </button>
                </div>
            `;
            menu.addEventListener("click", async (event) => {
                const infoBtn = event.target.closest(".js-context-info");
                if (infoBtn) {
                    openCalendarInfoModal(calendarName);
                    closeCalendarContextMenu();
                    return;
                }
                const presetBtn = event.target.closest(".js-context-preset");
                if (presetBtn) {
                    const color = presetBtn.getAttribute("data-color");
                    if (color) {
                        setCalendarColor(calendarName, color);
                        closeCalendarContextMenu();
                    }
                    return;
                }
                const customBtn = event.target.closest(".js-context-custom");
                if (customBtn) {
                    openRgbModal(calendarName);
                }
            });
            document.body.appendChild(menu);
            state.ui.contextMenuEl = menu;
            positionCalendarContextMenu();
        }

        function positionCalendarContextMenu() {
            if (!state.ui.contextMenuEl || !state.ui.contextAnchorEl) return;
            const menu = state.ui.contextMenuEl;
            const anchorRect = state.ui.contextAnchorEl.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            let left = anchorRect.right - menuRect.width;
            let top = anchorRect.bottom + 8;
            if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
            if (left < 8) left = 8;
            if (top + menuRect.height > window.innerHeight - 8) {
                top = anchorRect.top - menuRect.height - 8;
            }
            if (top < 8) top = 8;
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        }

        function buildEventChip(event, options = {}) {
            const sizeClass = options.compact ? "text-xs px-2 py-1" : "text-xs px-2 py-1";
            const badgeStyle = getEventBadgeStyle(event);
            const badgeColors = getEventBadgeColors(event);
            const calendarColor = getCalendarEventColor(event);
            const isMonthTimedChip = Boolean(options.monthView) && !event.isAllDay;
            if (isMonthTimedChip) {
                const taskLabel = isTaskEvent(event) && event.priority && event.priority !== "none" ? event.priority.slice(0, 1).toUpperCase() : "";
                const completedClass = isTaskEvent(event) && event.completed ? " is-completed" : "";
                return `
                    <div ${getEventElementAttributes(event)} class="calendar-event-shell relative${completedClass}">
                        <div class="${sizeClass} rounded-md border bg-surface-container-high/50 truncate flex items-center gap-2" style="border-color: ${badgeColors.border};">
                            <span class="inline-block h-4 w-1 rounded-full shrink-0" style="background-color: ${calendarColor};"></span>
                            ${taskLabel ? `<span class="text-xs font-bold uppercase" style="color:${badgeColors.text};">${escapeHtml(taskLabel)}</span>` : ""}
                            <span class="truncate text-on-surface font-medium">${isTaskEvent(event) && event.completed ? "✓ " : ""}${escapeHtml(event.title || "Untitled")}</span>
                        </div>
                    </div>
                `;
            }
            return `
                <div ${getEventElementAttributes(event)} class="calendar-event-shell relative">
                    <div class="${sizeClass} rounded-md border truncate" style="${badgeStyle}">
                        ${escapeHtml(event.title || "Untitled")}
                    </div>
                </div>
            `;
        }

        return {
            buildEventChip,
            closeCalendarContextMenu,
            openCalendarContextMenu,
            positionCalendarContextMenu,
        };
    }

    window.APStudyCalendarUiActions = { createCalendarUiActions };
})();
