(function () {
    function createCalendarEventRender({
        state,
        callbacks,
        formatters,
    }) {
        const {
            getCalendarEventColor,
            getCalendarEventRef,
            getVisibleEvents,
        } = callbacks;
        const {
            adjustHexLuminance,
            escapeHtml,
            getTaskPriorityColor,
            hexToRgba,
            isTaskEvent,
        } = formatters;

        function getEventElementAttributes(event) {
            const dataId = event.id || event.uid || "";
            const eventRef = getCalendarEventRef(event) || dataId;
            const sourceType = event.source_type || event.source || (event.id ? "user" : "feed");
            const taskId = event.task_id ? ` data-task-id="${escapeHtml(event.task_id)}"` : "";
            return `data-event-id="${escapeHtml(dataId)}" data-event-ref="${escapeHtml(eventRef)}" data-event-source="${escapeHtml(sourceType)}"${taskId} tabindex="0"`;
        }

        function getEventsForDay(date) {
            const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
            const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
            return getVisibleEvents().filter((e) => {
                const eStart = e.startDate;
                const eEnd = e.endDate || e.startDate;
                if (e.isAllDay) {
                    const eventStartDay = new Date(eStart.getFullYear(), eStart.getMonth(), eStart.getDate());
                    const eventEndDay = new Date(eEnd.getFullYear(), eEnd.getMonth(), eEnd.getDate());
                    const nextDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
                    return eventStartDay < nextDayStart && eventEndDay > dayStart;
                }
                return eStart <= dayEnd && eEnd >= dayStart;
            });
        }

        function getEventBadgeStyle(event) {
            const colors = getEventBadgeColors(event);
            return `background-color: ${colors.background}; color: ${colors.text}; border: 1px solid ${colors.border};`;
        }

        function getEventBadgeColors(event) {
            if (isTaskEvent(event)) {
                if (event.completed) {
                    const muted = document.documentElement.classList.contains("dark") ? "#94a3b8" : "#64748b";
                    return {
                        background: hexToRgba(muted, document.documentElement.classList.contains("dark") ? 0.18 : 0.12),
                        text: muted,
                        border: hexToRgba(muted, 0.34),
                    };
                }
                const priorityColor = getTaskPriorityColor(event.priority);
                const isDarkTask = document.documentElement.classList.contains("dark");
                return {
                    background: hexToRgba(priorityColor, isDarkTask ? 0.24 : 0.13),
                    text: adjustHexLuminance(priorityColor, isDarkTask ? 0.28 : -0.22),
                    border: hexToRgba(priorityColor, isDarkTask ? 0.5 : 0.36),
                };
            }
            const color = getCalendarEventColor(event);
            const isDark = document.documentElement.classList.contains("dark");
            return {
                background: hexToRgba(color, isDark ? 0.24 : 0.13),
                text: adjustHexLuminance(color, isDark ? 0.34 : -0.30),
                border: hexToRgba(color, isDark ? 0.48 : 0.34),
            };
        }

        return {
            getEventBadgeColors,
            getEventBadgeStyle,
            getEventElementAttributes,
            getEventsForDay,
        };
    }

    window.APStudyCalendarEventRender = { createCalendarEventRender };
})();
