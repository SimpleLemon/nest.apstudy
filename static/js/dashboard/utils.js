(function () {
    const TILE_META = {
        calendar: {
            title: "Monthly Calendar",
            icon: "calendar_today",
            href: "/calendar",
            emptyIcon: "event_busy",
            emptyText: "No events this month.",
            emptyCta: "Open calendar",
        },
        tasks: {
            title: "Upcoming Tasks",
            icon: "check_circle",
            href: "/tasks",
            emptyIcon: "done_all",
            emptyText: "Nothing is due soon.",
            emptyCta: "Open tasks",
        },
        files: {
            title: "Recent Files",
            icon: "folder",
            href: "/files",
            emptyIcon: "upload_file",
            emptyText: "No recent files yet.",
            emptyCta: "Open files",
        },
        notes: {
            title: "Recent Notes",
            icon: "article",
            href: "/notes",
            emptyIcon: "note_stack",
            emptyText: "No recent notes yet.",
            emptyCta: "Open notes",
        },
        messages: {
            title: "Messages",
            icon: "chat_bubble",
            href: "/chat",
            emptyIcon: "chat_bubble",
            emptyText: "No recent message activity.",
            emptyCta: "Open chat",
        },
        courses: {
            title: "Courses",
            icon: "school",
            href: "/courses",
            emptyIcon: "school",
            emptyText: "No saved courses yet.",
            emptyCta: "Open courses",
        },
    };

    const TILE_SIZE_RULES = {
        calendar: ["standard", "tall", "wide"],
        tasks: ["standard", "tall", "wide"],
        files: ["standard", "tall", "wide"],
        notes: ["standard", "tall", "wide"],
        messages: ["standard", "tall", "wide"],
        courses: ["standard", "wide"],
    };

    const DEFAULT_TILE_SIZES = {
        calendar: "standard",
        tasks: "standard",
        files: "standard",
        notes: "standard",
        messages: "standard",
        courses: "wide",
    };

    const TILE_SIZE_LABELS = {
        standard: "Standard",
        tall: "Tall",
        wide: "Wide",
    };

    const CALENDAR_VIEW_RULES = ["month", "week", "upcoming"];
    const DEFAULT_CALENDAR_VIEW = "month";
    const CALENDAR_VIEW_LABELS = {
        month: "Month",
        week: "Week",
        upcoming: "Upcoming",
    };

    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function fetchJson(url, options = {}) {
        return fetch(url, {
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            ...options,
        }).then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "Request failed");
            }
            return data;
        });
    }

    function formatDateTime(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    }

    function formatRelative(value) {
        if (!value) return "Recently";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Recently";
        const diffMs = Date.now() - date.getTime();
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (diffMs < minute) return "Just now";
        if (diffMs < hour) return `${Math.max(1, Math.round(diffMs / minute))}m ago`;
        if (diffMs < day) return `${Math.max(1, Math.round(diffMs / hour))}h ago`;
        if (diffMs < 7 * day) return `${Math.max(1, Math.round(diffMs / day))}d ago`;
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value <= 0) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        let size = value;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }
        return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
    }

    function normalizeTileSize(tileId, size) {
        const allowed = TILE_SIZE_RULES[tileId] || [];
        let normalized = String(size || DEFAULT_TILE_SIZES[tileId] || allowed[0] || "standard").trim().toLowerCase();
        if (normalized === "compact" || normalized === "medium") normalized = "standard";
        if (normalized === "large") normalized = "wide";
        return allowed.includes(normalized) ? normalized : (DEFAULT_TILE_SIZES[tileId] || allowed[0] || "standard");
    }

    function normalizeCalendarView(tileId, view) {
        if (tileId !== "calendar") return "";
        const normalized = String(view || DEFAULT_CALENDAR_VIEW).trim().toLowerCase();
        return CALENDAR_VIEW_RULES.includes(normalized) ? normalized : DEFAULT_CALENDAR_VIEW;
    }

    function tilePayload(tileId, size, view) {
        const payload = {
            id: tileId,
            size: normalizeTileSize(tileId, size),
        };
        if (tileId === "calendar") payload.view = normalizeCalendarView(tileId, view);
        return payload;
    }

    function normalizeTileOrder(preferredOrder, availableTiles) {
        const available = Array.isArray(availableTiles)
            ? availableTiles.filter((tileId) => TILE_META[tileId])
            : Object.keys(TILE_META);
        const ordered = [];
        for (const tileId of Array.isArray(preferredOrder) ? preferredOrder : []) {
            if (available.includes(tileId) && !ordered.includes(tileId)) ordered.push(tileId);
        }
        for (const tileId of Object.keys(TILE_META)) {
            if (available.includes(tileId) && !ordered.includes(tileId)) ordered.push(tileId);
        }
        return ordered;
    }

    function normalizeTileLayout(preferredLayout, availableTiles) {
        const available = Array.isArray(availableTiles)
            ? availableTiles.filter((tileId) => TILE_META[tileId])
            : Object.keys(TILE_META);
        const isVersionThree = Number(preferredLayout?.version || 0) >= 3;
        const source = Array.isArray(preferredLayout)
            ? preferredLayout
            : Array.isArray(preferredLayout?.tiles)
                ? preferredLayout.tiles
                : [];
        const layout = [];
        for (const item of source) {
            const tileId = typeof item === "string" ? item : item?.id;
            if (!available.includes(tileId) || layout.some((tile) => tile.id === tileId)) continue;
            layout.push(tilePayload(tileId, typeof item === "string" ? null : item?.size, typeof item === "string" ? null : item?.view));
        }
        if (!isVersionThree) {
            for (const tileId of Object.keys(TILE_META)) {
                if (available.includes(tileId) && !layout.some((tile) => tile.id === tileId)) {
                    layout.push(tilePayload(tileId));
                }
            }
        }
        return layout;
    }

    function nearestTileSize(tileId, deltaX, deltaY, startSize) {
        const allowed = TILE_SIZE_RULES[tileId] || [];
        const current = normalizeTileSize(tileId, startSize);
        const growX = deltaX > 96;
        const growY = deltaY > 96;
        const shrinkX = deltaX < -96;
        const shrinkY = deltaY < -96;

        if ((shrinkX || shrinkY) && allowed.includes("standard")) {
            if (current === "wide" && shrinkX && !shrinkY && allowed.includes("tall")) return "tall";
            return "standard";
        }
        if ((growX && growY) || (current === "tall" && growX) || ((growX || growY) && !allowed.includes("tall"))) {
            if (allowed.includes("wide")) return "wide";
        }
        if (growY && allowed.includes("tall")) return "tall";
        if (growX && allowed.includes("wide")) return "wide";
        return current;
    }

    function summaryLayoutSource(summary) {
        if (Array.isArray(summary?.tile_layout)) {
            return {
                version: Number(summary.tile_layout_version || 3),
                tiles: summary.tile_layout,
            };
        }
        return summary?.tile_layout || summary?.tile_order;
    }

    function groupEventsByDate(events) {
        const map = new Map();
        for (const event of events) {
            const key = event.date || String(event.start || "").slice(0, 10);
            if (!key) continue;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(event);
        }
        return map;
    }

    function eventDateKey(event) {
        return event?.date || String(event?.start || "").slice(0, 10) || localDateKey(new Date());
    }

    function localDateKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    function tileTitle(tileId, view) {
        const meta = TILE_META[tileId];
        if (tileId !== "calendar") return meta?.title || "";
        const safeView = normalizeCalendarView(tileId, view);
        return `Calendar: ${CALENDAR_VIEW_LABELS[safeView] || "Month"}`;
    }

    window.APStudyDashboardUtils = {
        TILE_META,
        TILE_SIZE_RULES,
        TILE_SIZE_LABELS,
        CALENDAR_VIEW_RULES,
        CALENDAR_VIEW_LABELS,
        escapeHtml,
        escapeAttr,
        fetchJson,
        formatDateTime,
        formatRelative,
        formatBytes,
        normalizeTileOrder,
        normalizeTileLayout,
        normalizeTileSize,
        normalizeCalendarView,
        tilePayload,
        tileTitle,
        eventDateKey,
        groupEventsByDate,
        localDateKey,
        nearestTileSize,
        summaryLayoutSource,
    };
})();
