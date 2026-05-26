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
        calendar: ["medium", "wide", "large"],
        tasks: ["compact", "medium", "wide"],
        files: ["compact", "medium", "wide"],
        notes: ["compact", "medium", "wide"],
        messages: ["compact", "medium", "wide"],
        courses: ["wide", "large"],
    };

    const DEFAULT_TILE_SIZES = {
        calendar: "medium",
        tasks: "medium",
        files: "medium",
        notes: "medium",
        messages: "medium",
        courses: "wide",
    };

    const TILE_SIZE_LABELS = {
        compact: "Compact",
        medium: "Medium",
        wide: "Wide",
        large: "Large",
    };

    const state = {
        summary: null,
        sortable: null,
        activePopoverLocked: false,
        editMode: false,
        resize: null,
    };

    const els = {
        tiles: document.getElementById("dashboard-tiles"),
        checklist: document.getElementById("dashboard-checklist"),
        editToggle: document.getElementById("dashboard-edit-layout"),
    };

    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
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
            .map((tile) => ({
                id: tile.dataset.tileId,
                size: normalizeTileSize(tile.dataset.tileId, tile.dataset.tileSize),
            }))
            .filter((tile) => tile.id && TILE_META[tile.id]);
    }

    function normalizeTileSize(tileId, size) {
        const allowed = TILE_SIZE_RULES[tileId] || [];
        const normalized = String(size || DEFAULT_TILE_SIZES[tileId] || allowed[0] || "medium").trim();
        return allowed.includes(normalized) ? normalized : (DEFAULT_TILE_SIZES[tileId] || allowed[0] || "medium");
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
        const source = Array.isArray(preferredLayout)
            ? preferredLayout
            : Array.isArray(preferredLayout?.tiles)
                ? preferredLayout.tiles
                : [];
        const layout = [];
        for (const item of source) {
            const tileId = typeof item === "string" ? item : item?.id;
            if (!available.includes(tileId) || layout.some((tile) => tile.id === tileId)) continue;
            layout.push({
                id: tileId,
                size: normalizeTileSize(tileId, typeof item === "string" ? null : item?.size),
            });
        }
        for (const tileId of Object.keys(TILE_META)) {
            if (available.includes(tileId) && !layout.some((tile) => tile.id === tileId)) {
                layout.push({ id: tileId, size: normalizeTileSize(tileId) });
            }
        }
        return layout;
    }

    function nextTileSize(tileId, currentSize, direction) {
        const allowed = TILE_SIZE_RULES[tileId] || [];
        if (!allowed.length) return currentSize;
        const currentIndex = Math.max(0, allowed.indexOf(normalizeTileSize(tileId, currentSize)));
        const nextIndex = Math.min(allowed.length - 1, Math.max(0, currentIndex + direction));
        return allowed[nextIndex];
    }

    function nearestTileSize(tileId, deltaX, deltaY, startSize) {
        const allowed = TILE_SIZE_RULES[tileId] || [];
        if (!allowed.length) return startSize;
        const startIndex = Math.max(0, allowed.indexOf(normalizeTileSize(tileId, startSize)));
        const step = Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : deltaX;
        const threshold = 72;
        const offset = Math.trunc(step / threshold);
        const targetIndex = Math.min(allowed.length - 1, Math.max(0, startIndex + offset));
        return allowed[targetIndex];
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

    function tileShell(tileId, size, bodyHtml) {
        const meta = TILE_META[tileId];
        const safeSize = normalizeTileSize(tileId, size);
        const sizeOptions = (TILE_SIZE_RULES[tileId] || []).map((option) => `
            <button class="dashboard-layout-button dashboard-resize-step ${option === safeSize ? "is-active" : ""}" type="button" data-size="${escapeHtml(option)}" aria-label="Set ${escapeHtml(meta.title)} tile to ${escapeHtml(TILE_SIZE_LABELS[option] || option)}">
                ${escapeHtml(TILE_SIZE_LABELS[option] || option)}
            </button>
        `).join("");
        return `
            <article class="dashboard-tile" data-tile-id="${escapeHtml(tileId)}" data-tile-size="${escapeHtml(safeSize)}" tabindex="0">
                <div class="dashboard-tile-inner">
                    <header class="dashboard-tile-head">
                        <div class="dashboard-tile-title-row">
                            <span class="dashboard-tile-icon">
                                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(meta.icon)}</span>
                            </span>
                            <div>
                                <h2>${escapeHtml(meta.title)}</h2>
                            </div>
                        </div>
                        <div class="dashboard-tile-actions">
                            <a class="dashboard-tile-link" href="${escapeHtml(meta.href)}" aria-label="Open ${escapeHtml(meta.title)}">
                                <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                            </a>
                        </div>
                    </header>
                    ${bodyHtml}
                    <div class="dashboard-layout-controls" aria-label="${escapeHtml(meta.title)} layout controls">
                        ${sizeOptions}
                    </div>
                    <button class="dashboard-resize-grip" type="button" aria-label="Resize ${escapeHtml(meta.title)} tile"></button>
                </div>
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
        const layout = normalizeTileLayout(summary.tile_layout || summary.tile_order, summary.available_tiles);
        els.tiles.innerHTML = layout.map((tile) => renderTile(tile.id, tile.size, summary.tiles?.[tile.id] || {})).join("");
        applyEditMode();
        bindTileControls();
        bindCalendarPopovers();
        setupSortable();
    }

    function renderTile(tileId, size, data) {
        if (tileId === "calendar") return tileShell(tileId, size, renderCalendar(data));
        if (tileId === "tasks") return tileShell(tileId, size, renderTasks(data));
        if (tileId === "files") return tileShell(tileId, size, renderFiles(data));
        if (tileId === "notes") return tileShell(tileId, size, renderNotes(data));
        if (tileId === "messages") return tileShell(tileId, size, renderMessages(data));
        if (tileId === "courses") return tileShell(tileId, size, renderCourses(data));
        return "";
    }

    function renderCalendar(data) {
        const events = Array.isArray(data.events) ? data.events : [];
        const month = String(data.month || new Date().toISOString().slice(0, 7));
        const [yearValue, monthValue] = month.split("-").map((part) => Number(part));
        const year = Number.isFinite(yearValue) ? yearValue : new Date().getFullYear();
        const monthIndex = Number.isFinite(monthValue) ? monthValue - 1 : new Date().getMonth();
        const first = new Date(year, monthIndex, 1);
        const start = new Date(first);
        start.setDate(first.getDate() - first.getDay());
        const todayKey = localDateKey(new Date());
        const eventMap = groupEventsByDate(events);
        const cells = [];
        for (let index = 0; index < 42; index += 1) {
            const day = new Date(start);
            day.setDate(start.getDate() + index);
            const key = localDateKey(day);
            const dayEvents = eventMap.get(key) || [];
            cells.push(`
                <button class="dashboard-day ${day.getMonth() === monthIndex ? "" : "is-muted"} ${key === todayKey ? "is-today" : ""}" type="button" data-date="${escapeHtml(key)}" ${dayEvents.length ? "" : "aria-disabled=\"true\""}>
                    <span class="dashboard-day-number">${escapeHtml(formatMonthGridDayLabel(day))}</span>
                    <span class="dashboard-day-markers" aria-hidden="true">
                        ${dayEvents.slice(0, 5).map((event) => `<span class="dashboard-marker" style="--marker-color:${escapeHtml(event.color || "#6366f1")}"></span>`).join("")}
                    </span>
                </button>
            `);
        }
        return `
            <div class="dashboard-calendar" data-calendar-events="${escapeHtml(JSON.stringify(events))}">
                <div class="dashboard-calendar-weekdays" aria-hidden="true">
                    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<span>${day}</span>`).join("")}
                </div>
                <div class="dashboard-calendar-grid">${cells.join("")}</div>
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
        els.editToggle?.addEventListener("click", () => {
            state.editMode = !state.editMode;
            applyEditMode();
        });
        els.tiles?.querySelectorAll(".dashboard-resize-step").forEach((button) => {
            button.addEventListener("click", () => {
                const tile = button.closest(".dashboard-tile");
                setTileSize(tile, button.dataset.size, true);
            });
        });
        els.tiles?.querySelectorAll(".dashboard-resize-grip").forEach((grip) => {
            grip.addEventListener("pointerdown", startResize);
        });
    }

    function applyEditMode() {
        document.body.classList.toggle("dashboard-editing-layout", state.editMode);
        if (els.editToggle) {
            els.editToggle.setAttribute("aria-pressed", state.editMode ? "true" : "false");
            const label = els.editToggle.querySelector("span:last-child");
            if (label) label.textContent = state.editMode ? "Done" : "Edit layout";
        }
    }

    function setTileSize(tile, size, shouldPersist) {
        if (!tile) return;
        const tileId = tile.dataset.tileId;
        const nextSize = normalizeTileSize(tileId, size);
        tile.dataset.tileSize = nextSize;
        tile.querySelectorAll(".dashboard-resize-step").forEach((button) => {
            button.classList.toggle("is-active", button.dataset.size === nextSize);
        });
        if (shouldPersist) void persistLayout();
    }

    function setupSortable() {
        if (!els.tiles || typeof Sortable === "undefined") return;
        if (state.sortable) state.sortable.destroy();
        state.sortable = Sortable.create(els.tiles, {
            animation: 150,
            draggable: ".dashboard-tile",
            filter: "a,button,input,select,textarea,.dashboard-tile-title-row,.dashboard-day,.dashboard-list-item,.dashboard-course,.dashboard-resize-grip,.dashboard-layout-controls,.dashboard-popover",
            ghostClass: "dashboard-tile-ghost",
            dragClass: "is-dragging",
            preventOnFilter: false,
            onEnd: () => void persistLayout(),
        });
    }

    async function persistLayout() {
        const tile_layout = tileLayoutFromDom();
        try {
            await fetchJson("/api/dashboard/layout", {
                method: "PATCH",
                body: JSON.stringify({ tile_layout: { version: 2, tiles: tile_layout } }),
            });
        } catch (error) {
            showToast(error.message || "Unable to save dashboard layout.");
        }
    }

    function startResize(event) {
        const tile = event.currentTarget?.closest(".dashboard-tile");
        if (!tile || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
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
        tile.dataset.previewSize = targetSize;
        setTileSize(tile, targetSize, false);
    }

    function finishResize(event) {
        if (!state.resize || event.pointerId !== state.resize.pointerId) return;
        const { tile, targetSize } = state.resize;
        tile.classList.remove("is-resizing");
        delete tile.dataset.previewSize;
        state.resize = null;
        document.removeEventListener("pointermove", updateResize);
        document.removeEventListener("pointerup", finishResize);
        setTileSize(tile, targetSize, true);
    }

    function cancelResize() {
        if (!state.resize) return false;
        const { tile, startSize } = state.resize;
        tile.classList.remove("is-resizing");
        delete tile.dataset.previewSize;
        state.resize = null;
        document.removeEventListener("pointermove", updateResize);
        document.removeEventListener("pointerup", finishResize);
        setTileSize(tile, startSize, false);
        return true;
    }

    function bindCalendarPopovers() {
        const root = document.querySelector(".dashboard-calendar");
        if (!root) return;
        let events = [];
        try {
            events = JSON.parse(root.dataset.calendarEvents || "[]");
        } catch {
            events = [];
        }
        const eventsByDate = groupEventsByDate(events);
        root.querySelectorAll(".dashboard-day").forEach((dayButton) => {
            const date = dayButton.dataset.date;
            const dayEvents = eventsByDate.get(date) || [];
            if (!dayEvents.length) return;
            dayButton.addEventListener("mouseenter", () => {
                if (!state.activePopoverLocked) showPopover(dayButton, date, dayEvents);
            });
            dayButton.addEventListener("mouseleave", () => {
                if (!state.activePopoverLocked) hidePopover();
            });
            dayButton.addEventListener("focus", () => {
                if (!state.activePopoverLocked) showPopover(dayButton, date, dayEvents);
            });
            dayButton.addEventListener("blur", () => {
                if (!state.activePopoverLocked) hidePopover();
            });
            dayButton.addEventListener("click", (event) => {
                event.stopPropagation();
                state.activePopoverLocked = true;
                showPopover(dayButton, date, dayEvents);
            });
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
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (cancelResize()) {
            event.preventDefault();
            return;
        }
        state.activePopoverLocked = false;
        hidePopover();
    });
    document.addEventListener("DOMContentLoaded", loadDashboard);

    window.APStudyDashboardUtils = {
        groupEventsByDate,
        formatBytes,
        formatRelative,
        normalizeTileOrder,
        normalizeTileLayout,
        normalizeTileSize,
        nearestTileSize,
        tileOrderFromDom,
        tileLayoutFromDom,
    };
})();
