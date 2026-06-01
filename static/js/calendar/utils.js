(function () {
    const TASK_CALENDAR_ID = "local:tasks";

    function formatDateKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function formatMonthGridDayLabel(date) {
        if (date.getDate() !== 1) return String(date.getDate());
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function dateToDayIndex(date, weekDays) {
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const weekStartDay = new Date(weekDays[0].getFullYear(), weekDays[0].getMonth(), weekDays[0].getDate());
        const diffMs = dayStart - weekStartDay;
        return Math.round(diffMs / (1000 * 60 * 60 * 24));
    }

    function layoutTimedEvents(events) {
        const items = events.map((event) => {
            const startMin = event.startDate.getHours() * 60 + event.startDate.getMinutes();
            const endDate = event.endDate || event.startDate;
            const durMin = Math.max(30, Math.ceil((endDate - event.startDate) / 60000));
            return {
                ...event,
                layoutStartMinutes: startMin,
                layoutDurationMinutes: durMin,
                layoutLane: 0,
                layoutLaneCount: 1,
            };
        }).sort((a, b) => a.layoutStartMinutes - b.layoutStartMinutes || a.layoutDurationMinutes - b.layoutDurationMinutes);
        const laneEnds = [];
        for (const item of items) {
            let lane = 0;
            while (lane < laneEnds.length && laneEnds[lane] > item.layoutStartMinutes) lane++;
            if (lane === laneEnds.length) laneEnds.push(0);
            laneEnds[lane] = item.layoutStartMinutes + item.layoutDurationMinutes;
            item.layoutLane = lane;
        }
        const count = Math.max(1, laneEnds.length);
        items.forEach((item) => { item.layoutLaneCount = count; });
        return items;
    }

    function formatHourLabel(hour) {
        if (hour === 0) return "12 AM";
        if (hour < 12) return `${hour} AM`;
        if (hour === 12) return "12 PM";
        return `${hour - 12} PM`;
    }

    function formatTimeOnly(date) {
        return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }

    function formatDateTime(value) {
        return value.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    function formatTimedEventRange(event) {
        const start = event.startDate;
        const end = event.endDate || event.startDate;
        const sameDay =
            start.getFullYear() === end.getFullYear()
            && start.getMonth() === end.getMonth()
            && start.getDate() === end.getDate();
        if (sameDay) {
            const dateLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            return `${dateLabel}, ${formatTimeOnly(start)} - ${formatTimeOnly(end)}`;
        }
        return `${formatDateTime(start)} - ${formatDateTime(end)}`;
    }

    function formatAllDayRange(event) {
        const startStr = event.startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        if (!event.isMultiDay || event.spanDays <= 1) {
            return `${startStr} (All day)`;
        }
        const displayEnd = new Date(event.endDate);
        displayEnd.setDate(displayEnd.getDate() - 1);
        const endStr = displayEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return `${startStr} - ${endStr} (All day)`;
    }

    function getStartOfWeek(date) {
        const day = new Date(date);
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() - day.getDay());
        return day;
    }

    function isToday(date) {
        const now = new Date();
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    }

    function getUrgencyLabel(startDate) {
        const diffDays = Math.floor((startDate - new Date()) / (1000 * 60 * 60 * 24));
        if (diffDays < 0) return "Past";
        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Tomorrow";
        if (diffDays < 7) return `In ${diffDays} days`;
        return startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function getUrgencyLabelAllDay(event) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const eventStartDay = new Date(event.startDate.getFullYear(), event.startDate.getMonth(), event.startDate.getDate());
        const eventLastDay = new Date(event.endDate);
        eventLastDay.setDate(eventLastDay.getDate() - 1);
        const eventEndDayStart = new Date(eventLastDay.getFullYear(), eventLastDay.getMonth(), eventLastDay.getDate());
        if (eventEndDayStart < todayStart) return "Past";
        if (eventStartDay <= todayStart && eventEndDayStart >= todayStart) return "Today";
        const diffDays = Math.floor((eventStartDay - todayStart) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) return "Tomorrow";
        if (diffDays < 7) return `In ${diffDays} days`;
        return event.startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function getAccent(type, startDate) {
        const soon = (startDate - new Date()) / (1000 * 60 * 60 * 24) <= 1;
        if (soon) return { bar: "bg-error", tag: "bg-error-container/20 text-error" };
        if (type === "task") return { bar: "bg-secondary", tag: "bg-secondary-container/30 text-secondary" };
        if (type === "quiz") return { bar: "bg-tertiary", tag: "bg-tertiary-container/30 text-tertiary" };
        return { bar: "bg-primary", tag: "bg-primary/20 text-primary-fixed" };
    }

    function getEventBadgeClass(type, event) {
        if (event) {
            return "border-2";
        }
        if (type === "quiz") return "bg-tertiary-container/20 text-tertiary border-tertiary/30";
        if (type === "assignment") return "bg-primary/10 text-primary-fixed border-primary/30";
        return "bg-secondary-container/25 text-on-secondary-container border-secondary-container/30";
    }

    function isTaskEvent(event) {
        return event?.source_type === "task" || event?.type === "task" || event?.calendar_id === TASK_CALENDAR_ID;
    }

    function getTaskPriorityColor(priority) {
        const value = String(priority || "none").toLowerCase();
        if (value === "high") return "#ef4444";
        if (value === "medium") return "#f59e0b";
        if (value === "low") return "#22c55e";
        return "#0ea5e9";
    }

    function adjustHexLuminance(hex, amount) {
        const rgb = hexToRgb(hex);
        if (!rgb) return hex;
        const channel = (value) => {
            if (amount >= 0) {
                return Math.round(value + (255 - value) * amount);
            }
            return Math.round(value * (1 + amount));
        };
        return rgbToHex(channel(rgb.r), channel(rgb.g), channel(rgb.b));
    }

    function rgbToHex(r, g, b) {
        const toHex = (value) => {
            const hex = Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
            return hex;
        };
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    function hexToRgb(hex) {
        const normalized = String(hex || "").trim().replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
        return {
            r: parseInt(normalized.slice(0, 2), 16),
            g: parseInt(normalized.slice(2, 4), 16),
            b: parseInt(normalized.slice(4, 6), 16),
        };
    }

    function hexToRgba(hex, alpha) {
        const rgb = hexToRgb(hex);
        if (!rgb) return `rgba(99, 102, 241, ${alpha})`;
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    function escapeHtml(value) {
        return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function formatMultilineText(text) {
        return escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
    }

    window.APStudyCalendarUtils = {
        formatDateKey,
        formatMonthGridDayLabel,
        dateToDayIndex,
        layoutTimedEvents,
        formatHourLabel,
        formatTimeOnly,
        formatDateTime,
        formatTimedEventRange,
        formatAllDayRange,
        getStartOfWeek,
        isToday,
        getUrgencyLabel,
        getUrgencyLabelAllDay,
        getAccent,
        getEventBadgeClass,
        isTaskEvent,
        getTaskPriorityColor,
        adjustHexLuminance,
        hexToRgb,
        hexToRgba,
        escapeHtml,
        formatMultilineText,
    };
}());
