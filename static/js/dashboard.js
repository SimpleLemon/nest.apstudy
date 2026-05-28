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

    const state = {
        summary: null,
        sortable: null,
        activePopoverLocked: false,
        editMode: false,
        resize: null,
        controlsBound: false,
    };

    const els = {
        tiles: document.getElementById("dashboard-tiles"),
        checklist: document.getElementById("dashboard-checklist"),
        editToggle: document.getElementById("dashboard-edit-layout"),
        addTile: document.getElementById("dashboard-add-tile"),
        addMenu: document.getElementById("dashboard-add-menu"),
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

    function tileOrderFromDom() {
        return Array.from(els.tiles?.querySelectorAll(".dashboard-tile[data-tile-id]") || [])
            .map((tile) => tile.dataset.tileId)
            .filter(Boolean);
    }

    function tileLayoutFromDom() {
        return Array.from(els.tiles?.querySelectorAll(".dashboard-tile[data-tile-id]") || [])
            .map((tile) => tilePayload(tile.dataset.tileId, tile.dataset.tileSize, tile.dataset.calendarView))
            .filter((tile) => tile.id && TILE_META[tile.id]);
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

    function renderChecklist(checklist) {
        if (!els.checklist || !checklist || checklist.hidden) {
            if (els.checklist) els.checklist.hidden = true;
            return;
        }

        const percent = checklist.total ? Math.round((checklist.completed / checklist.total) * 100) : 0;
        els.checklist.hidden = false;
        els.checklist.innerHTML = `
            <div class="dashboard-checklist-head">
                <div>
                    <h2>${checklist.complete ? "Academic setup complete" : "Complete your academic setup"}</h2>
                    <p>${checklist.complete ? "Everything needed for the dashboard is connected." : "These items update automatically from your account data."}</p>
                </div>
                <button class="dashboard-checklist-hide" type="button" aria-label="Hide checklist" title="Hide">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
            <div class="dashboard-checklist-progress">
                <div class="dashboard-progress-track" aria-hidden="true">
                    <div class="dashboard-progress-fill" style="width:${percent}%"></div>
                </div>
                <span class="dashboard-progress-label">${checklist.completed}/${checklist.total}</span>
            </div>
            <div class="dashboard-checklist-items">
                ${(checklist.items || []).map((item) => `
                    <a class="dashboard-checklist-item ${item.complete ? "is-complete" : ""}" href="${escapeHtml(item.href || "/settings#account")}">
                        <span class="dashboard-check-icon">
                            <span class="material-symbols-outlined" aria-hidden="true">${item.complete ? "check" : "radio_button_unchecked"}</span>
                        </span>
                        <span>${escapeHtml(item.label)}</span>
                    </a>
                `).join("")}
            </div>
        `;
        els.checklist.querySelector(".dashboard-checklist-hide")?.addEventListener("click", hideChecklist);
    }

    async function hideChecklist() {
        if (els.checklist) els.checklist.hidden = true;
        try {
            await fetchJson("/api/dashboard/checklist/hidden", {
                method: "POST",
                body: JSON.stringify({ hidden: true }),
            });
        } catch (error) {
            showToast(error.message || "Unable to hide checklist.");
            if (els.checklist) els.checklist.hidden = false;
        }
    }

    function tileTitle(tileId, view) {
        const meta = TILE_META[tileId];
        if (tileId !== "calendar") return meta?.title || "";
        const safeView = normalizeCalendarView(tileId, view);
        return `Calendar: ${CALENDAR_VIEW_LABELS[safeView] || "Month"}`;
    }

    function tileShell(tileId, size, view, bodyHtml) {
        const meta = TILE_META[tileId];
        const safeSize = normalizeTileSize(tileId, size);
        const safeView = normalizeCalendarView(tileId, view);
        const title = tileTitle(tileId, safeView);
        const sizeOptions = (TILE_SIZE_RULES[tileId] || []).map((option) => `
            <button class="dashboard-config-option ${option === safeSize ? "is-active" : ""}" type="button" data-config-kind="size" data-value="${escapeHtml(option)}" role="menuitemradio" aria-checked="${option === safeSize ? "true" : "false"}">
                ${escapeHtml(TILE_SIZE_LABELS[option] || option)}
            </button>
        `).join("");
        const viewOptions = tileId === "calendar" ? `
            <div class="dashboard-config-group" aria-label="Calendar view">
                <span class="dashboard-config-label">View</span>
                ${CALENDAR_VIEW_RULES.map((option) => `
                    <button class="dashboard-config-option ${option === safeView ? "is-active" : ""}" type="button" data-config-kind="view" data-value="${escapeHtml(option)}" role="menuitemradio" aria-checked="${option === safeView ? "true" : "false"}">
                        ${escapeHtml(CALENDAR_VIEW_LABELS[option] || option)}
                    </button>
                `).join("")}
            </div>
        ` : "";
        return `
            <article class="dashboard-tile" data-tile-id="${escapeHtml(tileId)}" data-tile-size="${escapeHtml(safeSize)}" ${tileId === "calendar" ? `data-calendar-view="${escapeHtml(safeView)}"` : ""} tabindex="0">
                <div class="dashboard-tile-edit-controls" aria-label="${escapeHtml(title)} edit controls">
                    <button class="dashboard-tile-remove" type="button" aria-label="Remove ${escapeHtml(title)} tile">
                        <span class="material-symbols-outlined" aria-hidden="true">remove</span>
                    </button>
                    <button class="dashboard-tile-config-toggle" type="button" aria-label="Configure ${escapeHtml(title)} tile" aria-expanded="false">
                        <span class="material-symbols-outlined" aria-hidden="true">tune</span>
                    </button>
                </div>
                <div class="dashboard-config-menu" role="menu" hidden>
                    <div class="dashboard-config-group" aria-label="Tile size">
                        <span class="dashboard-config-label">Size</span>
                        ${sizeOptions}
                    </div>
                    ${viewOptions}
                </div>
                <div class="dashboard-tile-inner">
                    <header class="dashboard-tile-head">
                        <div class="dashboard-tile-title-row">
                            <span class="dashboard-tile-icon">
                                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(meta.icon)}</span>
                            </span>
                            <div>
                                <h2>${escapeHtml(title)}</h2>
                            </div>
                        </div>
                        <div class="dashboard-tile-actions">
                            <a class="dashboard-tile-link" href="${escapeHtml(meta.href)}" aria-label="Open ${escapeHtml(title)}">
                                <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                            </a>
                        </div>
                    </header>
                    ${bodyHtml}
                </div>
                <button class="dashboard-resize-grip" type="button" aria-label="Resize ${escapeHtml(title)} tile"></button>
            </article>
        `;
    }

    function emptyState(tileId) {
        const meta = TILE_META[tileId];
        return `
            <div class="dashboard-empty">
                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(meta.emptyIcon)}</span>
                <p>${escapeHtml(meta.emptyText)}</p>
                <a class="dashboard-empty-link" href="${escapeHtml(meta.href)}">${escapeHtml(meta.emptyCta)}</a>
            </div>
        `;
    }

    function renderTiles(summary) {
        if (!els.tiles) return;
        const layout = normalizeTileLayout(summaryLayoutSource(summary), summary.available_tiles);
        summary.tile_layout_version = 3;
        summary.tile_layout = layout;
        els.tiles.innerHTML = layout.map((tile) => renderTile(tile.id, tile.size, summary.tiles?.[tile.id] || {}, tile)).join("");
        applyEditMode();
        bindTileControls();
        bindCalendarPopovers();
        setupSortable();
        updateAddTileMenu();
    }

    function renderTile(tileId, size, data, layoutItem = {}) {
        if (tileId === "calendar") return tileShell(tileId, size, layoutItem.view, renderCalendar(data, layoutItem.view));
        if (tileId === "tasks") return tileShell(tileId, size, "", renderTasks(data));
        if (tileId === "files") return tileShell(tileId, size, "", renderFiles(data));
        if (tileId === "notes") return tileShell(tileId, size, "", renderNotes(data));
        if (tileId === "messages") return tileShell(tileId, size, "", renderMessages(data));
        if (tileId === "courses") return tileShell(tileId, size, "", renderCourses(data));
        return "";
    }

    function renderCalendar(data, view) {
        const safeView = normalizeCalendarView("calendar", view);
        if (safeView === "week") return renderCalendarGrid(data, "week");
        if (safeView === "upcoming") return renderUpcomingCalendar(data);
        return renderCalendarGrid(data, "month");
    }

    function renderCalendarGrid(data, view) {
        const events = view === "week"
            ? (Array.isArray(data.week_events) ? data.week_events : [])
            : (Array.isArray(data.events) ? data.events : []);
        const month = String(data.month || new Date().toISOString().slice(0, 7));
        const [yearValue, monthValue] = month.split("-").map((part) => Number(part));
        const year = Number.isFinite(yearValue) ? yearValue : new Date().getFullYear();
        const monthIndex = Number.isFinite(monthValue) ? monthValue - 1 : new Date().getMonth();
        const first = view === "week"
            ? new Date(`${data.week_start || localDateKey(new Date())}T00:00:00`)
            : new Date(year, monthIndex, 1);
        const start = new Date(first);
        if (view !== "week") start.setDate(first.getDate() - first.getDay());
        const todayKey = localDateKey(new Date());
        const eventMap = groupEventsByDate(events);
        const cells = [];
        const cellCount = view === "week" ? 7 : 42;
        for (let index = 0; index < cellCount; index += 1) {
            const day = new Date(start);
            day.setDate(start.getDate() + index);
            const key = localDateKey(day);
            const dayEvents = eventMap.get(key) || [];
            const markerHtml = view === "week"
                ? dayEvents.slice(0, 5).map((event) => `<span class="dashboard-week-event-bar" style="--marker-color:${escapeHtml(event.color || "#6366f1")}"></span>`).join("")
                : dayEvents.slice(0, 5).map((event) => `<span class="dashboard-marker" style="--marker-color:${escapeHtml(event.color || "#6366f1")}"></span>`).join("");
            cells.push(`
                <button class="dashboard-day ${day.getMonth() === monthIndex ? "" : "is-muted"} ${key === todayKey ? "is-today" : ""}" type="button" data-date="${escapeHtml(key)}" ${dayEvents.length ? "" : "aria-disabled=\"true\""}>
                    <span class="dashboard-day-number">${escapeHtml(formatMonthGridDayLabel(day))}</span>
                    <span class="dashboard-day-markers" aria-hidden="true">
                        ${markerHtml}
                    </span>
                </button>
            `);
        }
        return `
            <div class="dashboard-calendar" data-calendar-events="${escapeAttr(JSON.stringify(events))}" data-calendar-view="${escapeHtml(view)}">
                <div class="dashboard-calendar-weekdays" aria-hidden="true">
                    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}
                </div>
                <div class="dashboard-calendar-grid">${cells.join("")}</div>
            </div>
        `;
    }

    function renderUpcomingCalendar(data) {
        const items = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
        if (!items.length) return emptyState("calendar");
        return `
            <div class="dashboard-calendar-upcoming">
                ${items.map((event) => `
                    <button class="dashboard-list-item dashboard-calendar-upcoming-item" type="button" data-date="${escapeHtml(event.date || String(event.start || "").slice(0, 10))}" data-calendar-event="${escapeAttr(JSON.stringify(event))}">
                        <div class="dashboard-list-main">
                            <span class="dashboard-list-title">${escapeHtml(event.title || "Untitled event")}</span>
                            <span class="dashboard-list-meta">${escapeHtml(formatDateTime(event.start) || event.date || "Upcoming")}</span>
                        </div>
                        <span class="dashboard-marker" style="--marker-color:${escapeHtml(event.color || "#6366f1")}" aria-hidden="true"></span>
                    </button>
                `).join("")}
            </div>
        `;
    }

    function formatMonthGridDayLabel(date) {
        if (date.getDate() !== 1) return String(date.getDate());
        return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

    function renderTasks(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return emptyState("tasks");
        return `
            <div class="dashboard-list">
                ${items.map((task) => `
                    <div class="dashboard-list-item">
                        <div class="dashboard-list-main">
                            <span class="dashboard-list-title">${escapeHtml(task.title)}</span>
                            <span class="dashboard-list-meta">${escapeHtml(formatDateTime(task.deadline_at) || "No deadline")}</span>
                        </div>
                        <span class="dashboard-pill ${task.overdue ? "is-overdue" : ""}">${task.overdue ? "Overdue" : escapeHtml(task.priority || "Task")}</span>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function renderFiles(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return emptyState("files");
        return `
            <div class="dashboard-list">
                ${items.map((file) => `
                    <a class="dashboard-list-item" href="${escapeHtml(file.href || "/files")}">
                        <div class="dashboard-list-main">
                            <span class="dashboard-list-title">${escapeHtml(file.name)}</span>
                            <span class="dashboard-list-meta">${escapeHtml(formatRelative(file.updated_at))}</span>
                        </div>
                        <span class="dashboard-pill">${escapeHtml(formatBytes(file.size_bytes))}</span>
                    </a>
                `).join("")}
            </div>
        `;
    }

    function renderNotes(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return emptyState("notes");
        return `
            <div class="dashboard-list">
                ${items.map((note) => `
                    <a class="dashboard-list-item" href="${escapeHtml(note.href || "/notes")}">
                        <div class="dashboard-list-main">
                            <span class="dashboard-list-title">${escapeHtml(note.title)}</span>
                            <span class="dashboard-list-meta">${escapeHtml(formatRelative(note.updated_at))}</span>
                        </div>
                        <span class="dashboard-pill">Note</span>
                    </a>
                `).join("")}
            </div>
        `;
    }

    function renderMessages(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return emptyState("messages");
        return `
            <div class="dashboard-list">
                ${items.map((room) => `
                    <a class="dashboard-list-item" href="${escapeHtml(room.href || "/chat")}">
                        <div class="dashboard-list-main">
                            <span class="dashboard-list-title">${escapeHtml(room.label)}</span>
                            <span class="dashboard-list-meta">${escapeHtml(formatRelative(room.last_activity_at))}</span>
                        </div>
                        <span class="dashboard-pill">${room.type === "thread" ? "DM" : "Channel"}</span>
                    </a>
                `).join("")}
            </div>
        `;
    }

    function renderCourses(data) {
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return emptyState("courses");
        return `
            <div class="dashboard-courses-list">
                ${items.map((course) => `
                    <div class="dashboard-course">
                        <strong>${escapeHtml(course.code)}</strong>
                        <span>${escapeHtml(course.name || course.term || "Saved course")}</span>
                        <span>${escapeHtml([course.term, course.section].filter(Boolean).join(" · "))}</span>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function bindTileControls() {
        if (!state.controlsBound) {
            bindPageControls();
            state.controlsBound = true;
        }
        els.tiles?.querySelectorAll(".dashboard-tile-remove").forEach((button) => {
            button.addEventListener("click", () => {
                const tile = button.closest(".dashboard-tile");
                removeTile(tile);
            });
        });
        els.tiles?.querySelectorAll(".dashboard-tile-config-toggle").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const tile = button.closest(".dashboard-tile");
                toggleTileConfig(tile, button);
            });
        });
        els.tiles?.querySelectorAll(".dashboard-config-option").forEach((button) => {
            button.addEventListener("click", () => {
                const tile = button.closest(".dashboard-tile");
                applyTileOption(tile, button.dataset.configKind, button.dataset.value);
            });
        });
        els.tiles?.querySelectorAll(".dashboard-resize-grip").forEach((grip) => {
            grip.addEventListener("pointerdown", startResize);
        });
    }

    function bindPageControls() {
        els.editToggle?.addEventListener("click", () => {
            state.editMode = !state.editMode;
            applyEditMode();
            setupSortable();
            updateAddTileMenu();
        });
        els.addTile?.addEventListener("click", (event) => {
            event.stopPropagation();
            const isOpen = els.addTile.getAttribute("aria-expanded") === "true";
            setAddMenuOpen(!isOpen);
        });
        els.addMenu?.addEventListener("click", (event) => {
            const button = event.target.closest("[data-add-tile-id]");
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            addTile(button.dataset.addTileId);
        });
    }

    function applyEditMode() {
        document.body.classList.toggle("dashboard-editing-layout", state.editMode);
        if (els.editToggle) {
            els.editToggle.setAttribute("aria-pressed", state.editMode ? "true" : "false");
            const label = els.editToggle.querySelector("span:last-child");
            if (label) label.textContent = state.editMode ? "Done" : "Edit layout";
        }
        els.tiles?.querySelectorAll(".dashboard-tile-inner").forEach((inner) => {
            inner.inert = state.editMode;
            inner.setAttribute("aria-hidden", state.editMode ? "true" : "false");
        });
        if (!state.editMode) {
            closeTileConfigMenus();
            setAddMenuOpen(false);
        }
    }

    function setTileSize(tile, size) {
        if (!tile) return;
        const tileId = tile.dataset.tileId;
        const nextSize = normalizeTileSize(tileId, size);
        tile.dataset.tileSize = nextSize;
    }

    function setCalendarView(tile, view) {
        if (!tile || tile.dataset.tileId !== "calendar") return;
        tile.dataset.calendarView = normalizeCalendarView("calendar", view);
    }

    function applyTileOption(tile, kind, value) {
        if (!tile) return;
        if (kind === "size") {
            setTileSize(tile, value);
        } else if (kind === "view") {
            setCalendarView(tile, value);
        }
        syncSummaryLayoutFromDom();
        renderTiles(state.summary);
        void persistLayout();
    }

    function startResize(event) {
        const tile = event.currentTarget?.closest(".dashboard-tile");
        if (!tile || !state.editMode || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        closeTileConfigMenus();
        const startSize = normalizeTileSize(tile.dataset.tileId, tile.dataset.tileSize);
        state.resize = {
            tile,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startSize,
            targetSize: startSize,
        };
        tile.classList.add("is-resizing");
        tile.dataset.previewSize = startSize;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.addEventListener("pointermove", updateResize);
        document.addEventListener("pointerup", finishResize);
    }

    function updateResize(event) {
        if (!state.resize || event.pointerId !== state.resize.pointerId) return;
        const { tile, startX, startY, startSize } = state.resize;
        const targetSize = nearestTileSize(tile.dataset.tileId, event.clientX - startX, event.clientY - startY, startSize);
        state.resize.targetSize = targetSize;
        tile.dataset.previewSize = TILE_SIZE_LABELS[targetSize] || targetSize;
        setTileSize(tile, targetSize);
    }

    function finishResize(event) {
        if (!state.resize || event.pointerId !== state.resize.pointerId) return;
        const { tile, targetSize } = state.resize;
        tile.classList.remove("is-resizing");
        delete tile.dataset.previewSize;
        state.resize = null;
        document.removeEventListener("pointermove", updateResize);
        document.removeEventListener("pointerup", finishResize);
        setTileSize(tile, targetSize);
        syncSummaryLayoutFromDom();
        void persistLayout();
    }

    function cancelResize() {
        if (!state.resize) return false;
        const { tile, startSize } = state.resize;
        tile.classList.remove("is-resizing");
        delete tile.dataset.previewSize;
        state.resize = null;
        document.removeEventListener("pointermove", updateResize);
        document.removeEventListener("pointerup", finishResize);
        setTileSize(tile, startSize);
        return true;
    }

    function toggleTileConfig(tile, button) {
        if (!tile || !state.editMode) return;
        const menu = tile.querySelector(".dashboard-config-menu");
        if (!menu) return;
        const shouldOpen = menu.hidden;
        closeTileConfigMenus();
        menu.hidden = !shouldOpen;
        button?.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    }

    function closeTileConfigMenus() {
        els.tiles?.querySelectorAll(".dashboard-config-menu").forEach((menu) => {
            menu.hidden = true;
        });
        els.tiles?.querySelectorAll(".dashboard-tile-config-toggle").forEach((button) => {
            button.setAttribute("aria-expanded", "false");
        });
    }

    function syncSummaryLayoutFromDom() {
        if (!state.summary) return;
        state.summary.tile_layout_version = 3;
        state.summary.tile_layout = tileLayoutFromDom();
        state.summary.tile_order = state.summary.tile_layout.map((tile) => tile.id);
    }

    function removeTile(tile) {
        if (!tile) return;
        tile.remove();
        syncSummaryLayoutFromDom();
        updateAddTileMenu();
        void persistLayout();
    }

    function addTile(tileId) {
        if (!state.summary || !TILE_META[tileId]) return;
        const available = Array.isArray(state.summary.available_tiles) ? state.summary.available_tiles : Object.keys(TILE_META);
        if (!available.includes(tileId)) return;
        const layout = normalizeTileLayout({ version: 3, tiles: state.summary.tile_layout || [] }, available);
        if (layout.some((tile) => tile.id === tileId)) return;
        layout.push(tilePayload(tileId));
        state.summary.tile_layout_version = 3;
        state.summary.tile_layout = layout;
        state.summary.tile_order = layout.map((tile) => tile.id);
        setAddMenuOpen(false);
        renderTiles(state.summary);
        void persistLayout();
    }

    function hiddenTileIds() {
        const available = Array.isArray(state.summary?.available_tiles)
            ? state.summary.available_tiles.filter((tileId) => TILE_META[tileId])
            : Object.keys(TILE_META);
        const visible = new Set((state.summary?.tile_layout || tileLayoutFromDom()).map((tile) => tile.id));
        return available.filter((tileId) => !visible.has(tileId));
    }

    function updateAddTileMenu() {
        if (!els.addTile || !els.addMenu) return;
        const hidden = hiddenTileIds();
        const shouldShow = state.editMode && hidden.length > 0;
        els.addTile.hidden = !shouldShow;
        els.addTile.disabled = !shouldShow;
        if (!shouldShow) {
            setAddMenuOpen(false);
            return;
        }
        els.addMenu.innerHTML = hidden.map((tileId) => `
            <button class="dashboard-add-menu-item" type="button" role="menuitem" data-add-tile-id="${escapeHtml(tileId)}">
                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(TILE_META[tileId].icon)}</span>
                <span>${escapeHtml(TILE_META[tileId].title)}</span>
            </button>
        `).join("");
    }

    function setAddMenuOpen(isOpen) {
        if (!els.addTile || !els.addMenu) return;
        els.addMenu.hidden = !isOpen;
        els.addTile.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    function setupSortable() {
        if (!els.tiles || typeof Sortable === "undefined") return;
        if (state.sortable) state.sortable.destroy();
        state.sortable = null;
        if (!state.editMode) return;
        state.sortable = Sortable.create(els.tiles, {
            animation: 150,
            draggable: ".dashboard-tile",
            filter: ".dashboard-tile-edit-controls,.dashboard-tile-edit-controls *, .dashboard-config-menu, .dashboard-config-menu *, .dashboard-resize-grip",
            ghostClass: "dashboard-tile-ghost",
            dragClass: "is-dragging",
            preventOnFilter: false,
            onStart: closeTileConfigMenus,
            onEnd: () => {
                syncSummaryLayoutFromDom();
                updateAddTileMenu();
                void persistLayout();
            },
        });
    }

    async function persistLayout() {
        const tile_layout = tileLayoutFromDom();
        try {
            await fetchJson("/api/dashboard/layout", {
                method: "PATCH",
                body: JSON.stringify({ tile_layout: { version: 3, tiles: tile_layout } }),
            });
        } catch (error) {
            showToast(error.message || "Unable to save dashboard layout.");
        }
    }

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

    function showToast(message) {
        const existing = document.querySelector(".dashboard-toast");
        existing?.remove();
        const toast = document.createElement("div");
        toast.className = "dashboard-toast";
        toast.textContent = message;
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3200);
    }

    async function loadDashboard() {
        try {
            const summary = await fetchJson("/api/dashboard/summary");
            state.summary = summary;
            renderChecklist(summary.checklist);
            renderTiles(summary);
        } catch (error) {
            if (els.tiles) {
                els.tiles.innerHTML = `
                    <div class="dashboard-empty">
                        <span class="material-symbols-outlined" aria-hidden="true">error</span>
                        <p>${escapeHtml(error.message || "Unable to load dashboard.")}</p>
                        <a class="dashboard-empty-link" href="/calendar">Open calendar</a>
                    </div>
                `;
            }
        }
    }

    document.addEventListener("click", () => {
        state.activePopoverLocked = false;
        hidePopover();
        closeTileConfigMenus();
        setAddMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (cancelResize()) {
            event.preventDefault();
            return;
        }
        state.activePopoverLocked = false;
        hidePopover();
        closeTileConfigMenus();
        setAddMenuOpen(false);
    });
    document.addEventListener("DOMContentLoaded", loadDashboard);

    window.APStudyDashboardUtils = {
        groupEventsByDate,
        formatBytes,
        formatRelative,
        normalizeTileOrder,
        normalizeTileLayout,
        normalizeTileSize,
        normalizeCalendarView,
        tileTitle,
        eventDateKey,
        escapeAttr,
        nearestTileSize,
        summaryLayoutSource,
        tileOrderFromDom,
        tileLayoutFromDom,
    };
})();
