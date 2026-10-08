export function createCalendarControls({
    root = document,
    runtimeWindow = null,
    lifecycle = null,
    state,
    callbacks,
    hoverCard,
    wireCourseControls,
}) {
    const {
        closeCalendarContextMenu,
        closeCalendarShareModal,
        closeCalendarSourceCreateModal,
        closeRgbModal,
        closeSourceInfoModal,
        ensureCalendarPreferencesLoaded,
        ensureEventsForRange,
        getBufferedRange,
        getCurrentRenderRange,
        isCompactCalendarViewport,
        openCalendarContextMenu,
        openCalendarShareModal,
        openCalendarSourceCreateModal,
        render,
        renderAssignments,
        renderCalendarMenu,
        renderCalendarView,
        runManualRefresh,
        scheduleCalendarPreferenceFlush,
        toggleCalendarVisibility,
    } = callbacks;
    const doc = root.ownerDocument || document;
    const view = runtimeWindow || doc.defaultView || globalThis.window || globalThis;
    const colorSchemeQuery = view.matchMedia?.("(prefers-color-scheme: dark)");
    const query = (selector) => root?.querySelector?.(selector);
    const listen = (target, type, handler, options) => lifecycle?.addEventListener
        ? lifecycle.addEventListener(target, type, handler, options)
        : (target?.addEventListener(type, handler, options), () => target?.removeEventListener(type, handler, options));

    function wireControls() {
        const refreshThemeDependentColors = () => {
            renderCalendarView();
            renderAssignments();
        };
        listen(doc, "apstudy-theme-change", refreshThemeDependentColors);
        listen(colorSchemeQuery, "change", () => {
            if (doc.documentElement.dataset.theme === "system-match") {
                refreshThemeDependentColors();
            }
        });
        let lastCompactCalendar = isCompactCalendarViewport();
        listen(view, "resize", () => {
            const nextCompactCalendar = isCompactCalendarViewport();
            if (nextCompactCalendar === lastCompactCalendar) return;
            lastCompactCalendar = nextCompactCalendar;
            renderCalendarView();
        });
        wireCourseControls();
        listen(query("#calendar-view-week"), "click", () => {
            state.view = "week";
            render();
            void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-view-month"), "click", () => {
            state.view = "month";
            render();
            void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-view-upcoming"), "click", () => {
            state.view = "upcoming";
            state.anchorDate = new Date();
            render();
            void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-prev"), "click", () => {
            state.anchorDate = shiftAnchorDate(-1);
            render();
            void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-next"), "click", () => {
            state.anchorDate = shiftAnchorDate(1);
            render();
            void ensureEventsForRange(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-refresh"), "click", () => {
            void runManualRefresh(getBufferedRange(getCurrentRenderRange()));
        });
        listen(query("#calendar-share"), "click", () => {
            openCalendarShareModal();
        });
        listen(query("#calendar-toggle-menu"), "click", (event) => {
            event.stopPropagation();
            const opening = !state.ui.calendarMenuOpen;
            state.ui.calendarMenuOpen = opening;
            if (!state.ui.calendarMenuOpen) {
                closeCalendarContextMenu();
                closeRgbModal();
            } else {
                void ensureCalendarPreferencesLoaded();
                if (state.ui.preferenceDirty.size) {
                    scheduleCalendarPreferenceFlush(0);
                }
            }
            renderCalendarMenu();
        });
        listen(query("#calendar-menu"), "change", (event) => {
            const checkbox = event.target.closest(".js-calendar-checkbox");
            if (!checkbox) return;
            event.stopPropagation();
            const calendarName = checkbox.getAttribute("data-calendar-name");
            if (!calendarName) return;
            toggleCalendarVisibility(calendarName);
            state.ui.calendarMenuOpen = true;
            renderCalendarMenu();
        });
        listen(query("#calendar-menu"), "click", (event) => {
            const addBtn = event.target.closest(".js-calendar-add-source");
            if (addBtn) {
                event.preventDefault();
                event.stopPropagation();
                if (state.public.readOnly) return;
                openCalendarSourceCreateModal();
                return;
            }
            const moreBtn = event.target.closest(".js-calendar-more");
            if (!moreBtn) return;
            event.stopPropagation();
            if (state.public.readOnly) return;
            const calendarName = moreBtn.getAttribute("data-calendar-name");
            if (!calendarName) return;
            if (state.ui.contextMenuEl && state.ui.contextCalendarName === calendarName && state.ui.contextAnchorEl === moreBtn) {
                closeCalendarContextMenu();
                return;
            }
            openCalendarContextMenu(calendarName, moreBtn);
        });
        listen(doc, "pointerdown", (event) => {
            const popoverRoot = query("#calendar-popover-root");
            const inRoot = popoverRoot ? popoverRoot.contains(event.target) : false;
            const inContext = state.ui.contextMenuEl ? state.ui.contextMenuEl.contains(event.target) : false;
            const inRgb = state.ui.rgbModalEl ? state.ui.rgbModalEl.contains(event.target) : false;
            const inSourceInfo = state.ui.sourceInfoModalEl ? state.ui.sourceInfoModalEl.contains(event.target) : false;
            const inSourceCreate = state.ui.sourceCreateModalEl ? state.ui.sourceCreateModalEl.contains(event.target) : false;
            const inShare = state.ui.shareModalEl ? state.ui.shareModalEl.contains(event.target) : false;
            if (!inRoot && !inContext && !inRgb && !inSourceInfo && !inSourceCreate && !inShare) {
                closeAllCalendarPopups();
            }
        }, true);
        listen(view, "resize", () => {
            callbacks.positionCalendarContextMenu();
        });
        listen(view, "scroll", () => {
            callbacks.positionCalendarContextMenu();
            hoverCard.position();
        }, true);
        listen(view, "resize", () => {
            hoverCard.position();
        });
        hoverCard.wire();
        listen(root, "click", (event) => {
            const upcomingToggle = event.target.closest(".js-upcoming-toggle");
            if (upcomingToggle) {
                event.preventDefault();
                const eventRef = upcomingToggle.getAttribute("data-event-ref");
                if (!eventRef) return;
                if (state.ui.expandedUpcomingRefs.has(eventRef)) {
                    state.ui.expandedUpcomingRefs.delete(eventRef);
                } else {
                    state.ui.expandedUpcomingRefs.add(eventRef);
                }
                renderAssignments();
                return;
            }
        });
        listen(view, "keydown", (event) => {
            if (event.key === "Escape") {
                closeAllCalendarPopups();
            }
        });

    }

    function closeCalendarDropdown() {
        state.ui.calendarMenuOpen = false;
        renderCalendarMenu();
    }

    function closeAllCalendarPopups() {
        closeCalendarContextMenu();
        closeRgbModal();
        closeSourceInfoModal();
        closeCalendarSourceCreateModal();
        closeCalendarShareModal();
        closeCalendarDropdown();
    }

    function shiftAnchorDate(delta) {
        const next = new Date(state.anchorDate);
        if (state.view === "month") {
            next.setMonth(next.getMonth() + delta);
        } else {
            next.setDate(next.getDate() + delta * 7);
        }
        return next;
    }

    return {
        closeAllCalendarPopups,
        closeCalendarDropdown,
        wireControls,
    };
}
