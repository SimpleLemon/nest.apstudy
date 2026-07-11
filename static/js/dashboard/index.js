(function () {
    const {
        TILE_META,
        TILE_SIZE_LABELS,
        escapeHtml,
        escapeAttr,
        fetchJson,
        normalizeTileLayout,
        normalizeTileSize,
        normalizeCalendarView,
        normalizeTaskListIds,
        parseTaskListIds,
        tilePayload,
        eventDateKey,
        groupEventsByDate,
        nearestTileSize,
        summaryLayoutSource,
    } = window.APStudyDashboardUtils;
    const { checklistHtml, renderTile } = window.APStudyDashboardRenderers;
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
    function tileOrderFromDom() {
        return Array.from(els.tiles?.querySelectorAll(".dashboard-tile[data-tile-id]") || [])
            .map((tile) => tile.dataset.tileId)
            .filter(Boolean);
    }
    function tileLayoutFromDom() {
        return Array.from(els.tiles?.querySelectorAll(".dashboard-tile[data-tile-id]") || [])
            .map((tile) => tilePayload(tile.dataset.tileId, tile.dataset.tileSize, tile.dataset.calendarView, parseTaskListIds(tile.dataset.taskListIds)))
            .filter((tile) => tile.id && TILE_META[tile.id]);
    }
    function renderChecklist(checklist) {
        if (!els.checklist || !checklist || checklist.hidden) {
            if (els.checklist) els.checklist.hidden = true;
            return;
        }
        els.checklist.hidden = false;
        els.checklist.innerHTML = checklistHtml(checklist);
        els.checklist.querySelector(".dashboard-checklist-hide")?.addEventListener("click", hideChecklist);
    }
    async function hideChecklist() {
        if (els.checklist) els.checklist.hidden = true;
        try {
            await fetchJson("/api/dashboard/checklist/hidden", {
                method: "POST",
                body: JSON.stringify({ hidden: true }),
            });
            showToast("Checklist hidden.", "info", {
                action: { label: "Undo", onClick: () => { void unhideChecklist(); } },
            });
        } catch (error) {
            showToast(error.message || "Unable to hide checklist.");
            if (els.checklist) els.checklist.hidden = false;
        }
    }
    async function unhideChecklist() {
        if (els.checklist) els.checklist.hidden = false;
        try {
            await fetchJson("/api/dashboard/checklist/hidden", {
                method: "POST",
                body: JSON.stringify({ hidden: false }),
            });
        } catch (error) {
            showToast(error.message || "Unable to restore checklist.");
            if (els.checklist) els.checklist.hidden = true;
        }
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
        els.tiles?.querySelectorAll(".dashboard-tile-move-up, .dashboard-tile-move-down").forEach((button) => {
            button.addEventListener("click", () => {
                const tile = button.closest(".dashboard-tile");
                moveTile(tile, button.classList.contains("dashboard-tile-move-up") ? -1 : 1);
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
            setAddMenuOpen(!isOpen, { focusFirst: !isOpen });
        });
        els.addMenu?.addEventListener("click", (event) => {
            const quoteButton = event.target.closest("[data-add-quote-tile]");
            if (quoteButton) {
                event.preventDefault();
                event.stopPropagation();
                window.APStudyDashboardDailyQuote?.show?.();
                setAddMenuOpen(false);
                updateAddTileMenu();
                return;
            }
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
            const actionLabel = state.editMode ? "Finish editing dashboard layout" : "Edit dashboard layout";
            els.editToggle.setAttribute("aria-label", actionLabel);
            els.editToggle.title = state.editMode ? "Done" : "Edit layout";
            const icon = els.editToggle.querySelector(".material-symbols-outlined");
            if (icon) icon.textContent = state.editMode ? "done" : "dashboard_customize";
            const label = els.editToggle.querySelector(".dashboard-action-label");
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
        syncTileMoveButtons();
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
    function setTaskListFilter(tile, value) {
        if (!tile || tile.dataset.tileId !== "tasks") return false;
        if (value === "__all") {
            delete tile.dataset.taskListIds;
            return true;
        }
        const availableIds = Array.from(tile.querySelectorAll('.dashboard-config-list-option[data-value]:not([data-value="__all"])'))
            .map((button) => button.dataset.value)
            .filter(Boolean);
        const current = normalizeTaskListIds(parseTaskListIds(tile.dataset.taskListIds), availableIds);
        const listId = String(value || "").trim();
        if (!listId || !availableIds.includes(listId)) return false;
        let next = current.length ? current.slice() : availableIds.slice();
        if (next.includes(listId)) {
            if (next.length <= 1) return false;
            next = next.filter((id) => id !== listId);
        } else {
            next.push(listId);
        }
        const normalized = normalizeTaskListIds(next, availableIds);
        if (!normalized.length || normalized.length === availableIds.length) {
            delete tile.dataset.taskListIds;
        } else {
            tile.dataset.taskListIds = JSON.stringify(normalized);
        }
        return true;
    }
    function applyTileOption(tile, kind, value) {
        if (!tile) return;
        let changed = true;
        if (kind === "size") {
            setTileSize(tile, value);
        } else if (kind === "view") {
            setCalendarView(tile, value);
        } else if (kind === "task-list") {
            changed = setTaskListFilter(tile, value);
        }
        if (!changed) return;
        syncSummaryLayoutFromDom();
        renderTiles(state.summary);
        void persistLayout().then(() => {
            if (kind === "task-list") return loadDashboard();
            return null;
        });
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
        if (shouldOpen) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
    }
    function closeTileConfigMenus({ restoreFocus = false } = {}) {
        const openMenu = els.tiles?.querySelector(".dashboard-config-menu:not([hidden])");
        const trigger = openMenu?.closest(".dashboard-tile")?.querySelector(".dashboard-tile-config-toggle");
        els.tiles?.querySelectorAll(".dashboard-config-menu").forEach((menu) => {
            menu.hidden = true;
        });
        els.tiles?.querySelectorAll(".dashboard-tile-config-toggle").forEach((button) => {
            button.setAttribute("aria-expanded", "false");
        });
        if (restoreFocus) trigger?.focus({ preventScroll: true });
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
    function moveTile(tile, direction) {
        if (!tile || !els.tiles || ![-1, 1].includes(direction)) return;
        const sibling = direction < 0 ? tile.previousElementSibling : tile.nextElementSibling;
        if (!sibling?.classList.contains("dashboard-tile")) return;
        if (direction < 0) els.tiles.insertBefore(tile, sibling);
        else els.tiles.insertBefore(sibling, tile);
        syncSummaryLayoutFromDom();
        syncTileMoveButtons();
        tile.querySelector(direction < 0 ? ".dashboard-tile-move-up" : ".dashboard-tile-move-down")?.focus({ preventScroll: true });
        void persistLayout();
    }
    function syncTileMoveButtons() {
        const tiles = Array.from(els.tiles?.querySelectorAll(".dashboard-tile") || []);
        tiles.forEach((tile, index) => {
            const up = tile.querySelector(".dashboard-tile-move-up");
            const down = tile.querySelector(".dashboard-tile-move-down");
            if (up) up.disabled = index === 0;
            if (down) down.disabled = index === tiles.length - 1;
        });
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
        const quoteHidden = Boolean(window.APStudyDashboardDailyQuote?.isHidden?.());
        const shouldShow = state.editMode && (hidden.length > 0 || quoteHidden);
        els.addTile.hidden = !shouldShow;
        els.addTile.disabled = !shouldShow;
        if (!shouldShow) {
            setAddMenuOpen(false);
            return;
        }
        const dashboardTileItems = hidden.map((tileId) => `
            <button class="dashboard-add-menu-item" type="button" role="menuitem" data-add-tile-id="${escapeHtml(tileId)}">
                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(TILE_META[tileId].icon)}</span>
                <span>${escapeHtml(TILE_META[tileId].title)}</span>
            </button>
        `).join("");
        const quoteItem = quoteHidden ? `
            <button class="dashboard-add-menu-item" type="button" role="menuitem" data-add-quote-tile="true">
                <span class="material-symbols-outlined" aria-hidden="true">format_quote</span>
                <span>Daily quote</span>
            </button>
        ` : "";
        els.addMenu.innerHTML = `${quoteItem}${dashboardTileItems}`;
    }
    function setAddMenuOpen(isOpen, { focusFirst = false, restoreFocus = false } = {}) {
        if (!els.addTile || !els.addMenu) return;
        els.addMenu.hidden = !isOpen;
        els.addTile.setAttribute("aria-expanded", isOpen ? "true" : "false");
        if (isOpen && focusFirst) requestAnimationFrame(() => els.addMenu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
        if (!isOpen && restoreFocus) els.addTile.focus({ preventScroll: true });
    }
    function setupSortable() {
        if (!els.tiles || typeof Sortable === "undefined") return;
        destroySortable();
        if (!state.editMode) return;
        state.sortable = Sortable.create(els.tiles, {
            animation: window.APStudyAccessibility?.prefersReducedMotion?.() ? 0 : 150,
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
    function destroySortable() {
        state.sortable?.destroy();
        state.sortable = null;
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
    function showToast(message, type = "error", options = {}) {
        if (window.APStudyToast) {
            window.APStudyToast.show({ message, type, action: options.action });
        }
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
        closeTileConfigMenus({ restoreFocus: true });
        setAddMenuOpen(false, { restoreFocus: els.addTile?.getAttribute("aria-expanded") === "true" });
    });
    window.addEventListener?.("apstudy:dashboard-quote-visibility", updateAddTileMenu);
    window.APStudyPageLifecycle?.register?.({
        pause: destroySortable,
        resume: setupSortable,
        dispose: destroySortable,
    });
    document.addEventListener("DOMContentLoaded", loadDashboard);
    Object.assign(window.APStudyDashboardUtils, {
        tileOrderFromDom,
        tileLayoutFromDom,
    });
})();
