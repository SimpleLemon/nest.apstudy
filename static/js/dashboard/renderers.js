(function () {
    const {
        TILE_META,
        TILE_SIZE_RULES,
        TILE_SIZE_LABELS,
        CALENDAR_VIEW_RULES,
        CALENDAR_VIEW_LABELS,
        escapeHtml,
        escapeAttr,
        formatDateTime,
        formatRelative,
        formatBytes,
        normalizeTileSize,
        normalizeCalendarView,
        tileTitle,
        groupEventsByDate,
        localDateKey,
    } = window.APStudyDashboardUtils;

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

    function checklistHtml(checklist) {
        const percent = checklist.total ? Math.round((checklist.completed / checklist.total) * 100) : 0;
        return `
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

    window.APStudyDashboardRenderers = {
        checklistHtml,
        emptyState,
        renderTile,
    };
})();
