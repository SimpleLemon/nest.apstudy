import {
    TILE_META,
    escapeHtml,
    fetchJson,
    normalizeTileLayout,
    eventDateKey,
    groupEventsByDate,
    summaryLayoutSource,
} from './utils.js';
import { checklistHtml, renderTile } from './renderers.js';
import { createLayoutEditor } from './layout-editor.js';
import { dashboardDailyQuote } from './daily-quote.js';
const state = {
    summary: null,
    editor: null,
    activePopoverLocked: false,
    activePopoverTrigger: null,
    editMode: false,
    controlsBound: false,
};
const els = {
    tiles: document.getElementById("dashboard-tiles"),
    checklist: document.getElementById("dashboard-checklist"),
    editToggle: document.getElementById("dashboard-edit-layout"),
    addTile: document.getElementById("dashboard-add-tile"),
    cancel: document.getElementById("dashboard-cancel-layout"),
    quoteSlot: document.getElementById("dashboard-daily-quote"),
    toolbar: document.getElementById("dashboard-layout-toolbar"),
    toolbarLabel: document.getElementById("dashboard-layout-selection-label"),
    toolbarMoveEarlier: document.getElementById("dashboard-move-earlier"),
    toolbarMoveLater: document.getElementById("dashboard-move-later"),
    toolbarCustomize: document.getElementById("dashboard-customize-tile"),
    toolbarRemove: document.getElementById("dashboard-remove-tile"),
    drawer: document.getElementById("dashboard-tile-drawer"),
    drawerBody: document.getElementById("dashboard-tile-drawer-body"),
    discardDialog: document.getElementById("dashboard-discard-dialog"),
    discardKeep: document.getElementById("dashboard-keep-editing"),
    discardConfirm: document.getElementById("dashboard-confirm-discard"),
    announcer: document.getElementById("dashboard-layout-announcer"),
};
function isLayoutEditing() {
    return Boolean(state.editor?.isEditing?.());
}
function tileOrderFromDom() {
    return Array.from(els.tiles?.querySelectorAll(".dashboard-tile[data-tile-id]") || [])
        .map((tile) => tile.dataset.tileId)
        .filter(Boolean);
}
function tileLayoutFromDom() {
    const layout = state.editor?.currentLayout?.();
    if (!layout) return [];
    const byId = new Map(layout.tiles.map((tile) => [tile.instance_id, tile]));
    return tileOrderFromDom().map((instanceId) => byId.get(instanceId)).filter(Boolean);
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
        showToast(error.message || "Try again in a moment.", "error", { title: "Couldn’t hide checklist" });
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
        showToast(error.message || "Try again in a moment.", "error", { title: "Couldn’t restore checklist" });
        if (els.checklist) els.checklist.hidden = true;
    }
}
function renderTiles(summary, layoutOverride = null) {
    if (!els.tiles) return;
    hidePopover();
    const layout = layoutOverride?.tiles || normalizeTileLayout(summaryLayoutSource(summary), summary.available_tiles);
    summary.tile_layout_version = 4;
    summary.tile_layout = layout;
    els.tiles.innerHTML = layout.map((tile) => renderTile(tile.type || tile.id, tile.size, summary.tiles?.[tile.type || tile.id] || {}, tile)).join("");
    bindTileControls();
    bindCalendarPopovers();
}
function bindTileControls() {
    if (!state.controlsBound) {
        bindPageControls();
        state.controlsBound = true;
    }
    state.editor?.bindTiles?.();
}
function bindPageControls() {
    ensureEditor();
}
function ensureEditor() {
    if (state.editor) return state.editor;
    state.editor = createLayoutEditor({
        elements: els,
        getSummary: () => state.summary,
        render: (layout) => renderTiles(state.summary, layout),
        persist: async (layout) => {
            const response = await fetchJson("/api/dashboard/layout", {
                method: "PATCH",
                body: JSON.stringify({ dashboard_layout: layout }),
            });
            return response.dashboard_layout;
        },
        showToast,
    });
    return state.editor;
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
    const quoteHidden = Boolean(dashboardDailyQuote?.isHidden?.());
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
function bindCalendarPopoverTrigger(trigger, date, events) {
    if (!trigger) return;
    clearPopoverTrigger(trigger);
    if (!date || !events.length || trigger.disabled) return;
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("pointerenter", () => {
        if (!isLayoutEditing() && !state.activePopoverLocked) showPopover(trigger, date, events);
    });
    trigger.addEventListener("pointerleave", () => {
        if (!isLayoutEditing() && !state.activePopoverLocked && state.activePopoverTrigger === trigger) hidePopover();
    });
    trigger.addEventListener("focus", () => {
        if (!isLayoutEditing() && !state.activePopoverLocked) showPopover(trigger, date, events);
    });
    trigger.addEventListener("blur", () => {
        if (!isLayoutEditing() && !state.activePopoverLocked && state.activePopoverTrigger === trigger) hidePopover();
    });
    trigger.addEventListener("click", (event) => {
        if (isLayoutEditing()) return;
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
    if (popover) {
        popover.setAttribute("role", "tooltip");
        return popover;
    }
    popover = document.createElement("div");
    popover.id = "dashboard-popover";
    popover.className = "dashboard-popover";
    popover.setAttribute("role", "tooltip");
    popover.hidden = true;
    document.body.appendChild(popover);
    return popover;
}
function resetPopoverTrigger(trigger) {
    if (!trigger) return;
    clearPopoverTrigger(trigger);
    trigger.setAttribute("aria-expanded", "false");
}
function clearPopoverTrigger(trigger) {
    if (!trigger) return;
    trigger.removeAttribute("aria-describedby");
    trigger.removeAttribute("aria-controls");
    trigger.removeAttribute("aria-expanded");
}
function showPopover(anchor, date, events) {
    if (!anchor?.isConnected) return;
    if (state.activePopoverTrigger && state.activePopoverTrigger !== anchor) hidePopover({ unlock: false });
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
    resetPopoverTrigger(anchor);
    anchor.setAttribute("aria-describedby", "dashboard-popover");
    anchor.setAttribute("aria-controls", "dashboard-popover");
    anchor.setAttribute("aria-expanded", "true");
    state.activePopoverTrigger = anchor;
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
function hidePopover({ unlock = true } = {}) {
    resetPopoverTrigger(state.activePopoverTrigger);
    state.activePopoverTrigger = null;
    const popover = document.getElementById("dashboard-popover");
    if (popover) popover.hidden = true;
    if (unlock) state.activePopoverLocked = false;
}
function showToast(message, type = "error", options = {}) {
    if (window.APStudyToast) {
        window.APStudyToast.show({
            message,
            title: options.title,
            type,
            action: options.action,
            duration: options.duration,
        });
    }
}
async function loadDashboard() {
    try {
        const summary = await fetchJson("/api/dashboard/summary");
        state.summary = summary;
        renderChecklist(summary.checklist);
        const editor = ensureEditor();
        const quoteFallback = !dashboardDailyQuote?.isHidden?.();
        editor?.load(summary.dashboard_layout || summaryLayoutSource(summary), quoteFallback);
        renderTiles(summary, editor?.currentLayout?.());
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
    hidePopover();
    closeTileConfigMenus();
    setAddMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    hidePopover();
    closeTileConfigMenus({ restoreFocus: true });
    setAddMenuOpen(false, { restoreFocus: els.addTile?.getAttribute("aria-expanded") === "true" });
});
window.addEventListener?.("apstudy:dashboard-quote-visibility", updateAddTileMenu);
window.APStudyPageLifecycle?.register?.({
    pause: () => state.editor?.pause?.(),
    resume: () => state.editor?.resume?.(),
    dispose: () => state.editor?.pause?.(),
});
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadDashboard, { once: true });
} else {
    void loadDashboard();
}
