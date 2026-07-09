(function () {
    function createCalendarRenderShell({
        state,
        constants,
        callbacks,
    }) {
        const {
            compactCalendarQuery,
            hourHeightPx,
        } = constants;
        const {
            buildMobileCalendarAgendaHtml,
            buildMonthViewHtml,
            buildWeekViewHtml,
            getStartOfWeek,
            hideCalendarHoverCard,
            renderAssignments,
            renderCalendarMenu,
            renderCoursesModal,
        } = callbacks;

        function render() {
            updateHeader();
            updateViewToggleButtons();
            renderCalendarMenu();
            renderCalendarView();
            renderAssignments();
            if (!state.public.readOnly) {
                renderCoursesModal();
            }
        }

        function updateHeader() {
            const title = document.getElementById("calendar-title");
            const subtitle = document.getElementById("calendar-subtitle");
            if (!title || !subtitle) return;
            const monthLabel = state.anchorDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
            if (state.public.readOnly) {
                const periodLabel = state.view === "month"
                    ? monthLabel
                    : (() => {
                        const start = getStartOfWeek(state.anchorDate);
                        const end = new Date(start);
                        end.setDate(end.getDate() + 6);
                        return `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
                    })();
                title.textContent = state.public.title || "Shared Calendar";
                subtitle.textContent = `${periodLabel} · ${state.public.rangeLabel || "Shared dates"}`;
                return;
            }
            if (state.view === "month") {
                title.textContent = monthLabel;
                subtitle.textContent = state.feedConfigured
                    ? "Monthly view from your saved iCal feed"
                    : "Monthly view (no .ics feed connected yet)";
                return;
            }
            const start = getStartOfWeek(state.anchorDate);
            const end = new Date(start);
            end.setDate(end.getDate() + 6);
            title.textContent = `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
            subtitle.textContent = state.feedConfigured
                ? `Weekly view (${monthLabel}) from your saved iCal feed`
                : `Weekly view (${monthLabel}) with no .ics feed connected`;
        }

        function updateViewToggleButtons() {
            const weekBtn = document.getElementById("calendar-view-week");
            const monthBtn = document.getElementById("calendar-view-month");
            if (!weekBtn || !monthBtn) return;
            const active = "inline-flex h-8 min-w-[84px] items-center justify-center rounded-md px-3 text-sm font-medium text-on-primary shadow-sm transition-colors";
            const inactive = "inline-flex h-8 min-w-[84px] items-center justify-center rounded-md bg-transparent px-3 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface";
            weekBtn.className = state.view === "week" ? active : inactive;
            monthBtn.className = state.view === "month" ? active : inactive;
            weekBtn.setAttribute("aria-pressed", String(state.view === "week"));
            monthBtn.setAttribute("aria-pressed", String(state.view === "month"));
            if (state.view === "week") {
                weekBtn.style.background = "var(--color-primary)";
                monthBtn.style.background = "";
            } else {
                monthBtn.style.background = "var(--color-primary)";
                weekBtn.style.background = "";
            }
            if (state.view !== "week") {
                state.ui.weeklyAutoScrollKey = null;
            }
        }

        function renderCalendarView() {
            const root = document.getElementById("calendar-view-root");
            if (!root) return;
            hideCalendarHoverCard();
            if (state.loadingDashboard) {
                const skeletonHtml = window.APStudySkeleton?.table
                    ? window.APStudySkeleton.table({
                        label: "Loading calendar...",
                        rows: 6,
                        columns: 4,
                        className: "apstudy-skeleton-fill calendar-loading-skeleton",
                    })
                    : window.APStudyLoader.html("Loading calendar...", { sizePx: 54, textToneClass: "text-on-surface" });
                root.innerHTML = `
                    <div class="rounded-2xl border border-calendar-rule bg-surface-container shadow-2xl shadow-black/10 p-10 min-h-[420px] flex items-center justify-center">
                        ${skeletonHtml}
                    </div>
                `;
                return;
            }
            const compactCalendar = isCompactCalendarViewport();
            root.innerHTML = compactCalendar ? buildMobileCalendarAgendaHtml() : (state.view === "month" ? buildMonthViewHtml() : buildWeekViewHtml());
            if (state.view === "week" && !compactCalendar) {
                applyWeekAutoScroll();
            }
        }

        function isCompactCalendarViewport() {
            return compactCalendarQuery.matches;
        }

        function getWeekKeyFromAnchor(anchorDate) {
            const weekStart = getStartOfWeek(anchorDate);
            return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}`;
        }

        function applyWeekAutoScroll() {
            const scroller = document.getElementById("calendar-week-time-scroller");
            if (!scroller) return;
            const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
            const calendarContainer = scroller.closest(".rounded-2xl");
            if (calendarContainer) {
                calendarContainer.style.setProperty("--scrollbar-offset", `${scrollbarWidth}px`);
            }
            const weekKey = getWeekKeyFromAnchor(state.anchorDate);
            if (state.ui.weeklyAutoScrollKey === weekKey) return;
            const targetMinutes = (7 * 60) + 30;
            const targetScrollTop = Math.round((targetMinutes / 60) * hourHeightPx);
            scroller.scrollTop = targetScrollTop;
            state.ui.weeklyAutoScrollKey = weekKey;
        }

        return {
            isCompactCalendarViewport,
            render,
            renderCalendarView,
        };
    }

    window.APStudyCalendarRenderShell = { createCalendarRenderShell };
})();
