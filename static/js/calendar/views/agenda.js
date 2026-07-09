(function () {
    function createCalendarAgenda({
        state,
        callbacks,
        formatters,
    }) {
        const {
            getCalendarEventColor,
            getCalendarEventLabel,
            getCalendarEventRef,
            getEventElementAttributes,
            getEventsForDay,
            getVisibleEvents,
        } = callbacks;
        const {
            escapeHtml,
            formatAllDayRange,
            formatMultilineText,
            formatTimedEventRange,
            getAccent,
            getStartOfWeek,
            getUrgencyLabel,
            getUrgencyLabelAllDay,
            isTaskEvent,
            isToday,
        } = formatters;

        function buildMobileCalendarAgendaHtml() {
            const allDays = getMobileAgendaDays();
            const days = state.view === "month"
                ? allDays.filter((day) => getEventsForDay(day).length > 0 || isToday(day))
                : allDays;
            const visibleDays = days.length ? days : allDays.slice(0, 1);
            return `
                <div class="calendar-mobile-agenda" data-calendar-mobile-view="${escapeHtml(state.view)}">
                    ${visibleDays.map((day) => renderMobileAgendaDay(day)).join("")}
                </div>
            `;
        }

        function getMobileAgendaDays() {
            if (state.view === "month") {
                const year = state.anchorDate.getFullYear();
                const month = state.anchorDate.getMonth();
                const monthEnd = new Date(year, month + 1, 0);
                return Array.from({ length: monthEnd.getDate() }, (_, index) => new Date(year, month, index + 1));
            }
            const weekStart = getStartOfWeek(state.anchorDate);
            return Array.from({ length: 7 }, (_, index) => {
                const day = new Date(weekStart);
                day.setDate(weekStart.getDate() + index);
                return day;
            });
        }

        function renderMobileAgendaDay(day) {
            const dayEvents = getEventsForDay(day)
                .slice()
                .sort((a, b) => {
                    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
                    return a.startDate - b.startDate || (a.title || "").localeCompare(b.title || "");
                });
            const dateLabel = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
            const todayClass = isToday(day) ? " is-today" : "";
            return `
                <section class="calendar-mobile-day${todayClass}">
                    <header class="calendar-mobile-day-header">
                        <span>${escapeHtml(dateLabel)}</span>
                        <strong>${dayEvents.length}</strong>
                    </header>
                    <div class="calendar-mobile-event-list">
                        ${dayEvents.length ? dayEvents.map(renderMobileAgendaEvent).join("") : '<p class="calendar-mobile-empty">No events</p>'}
                    </div>
                </section>
            `;
        }

        function renderMobileAgendaEvent(event) {
            const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
            const calendarLabel = getCalendarEventLabel(event);
            const calendarColor = getCalendarEventColor(event);
            const completedClass = isTaskEvent(event) && event.completed ? " is-completed" : "";
            return `
                <article ${getEventElementAttributes(event)} class="calendar-mobile-event calendar-event-shell${completedClass}">
                    <span class="calendar-mobile-event-bar" style="background-color:${escapeHtml(calendarColor)}"></span>
                    <div class="calendar-mobile-event-copy">
                        <h3>${isTaskEvent(event) && event.completed ? "✓ " : ""}${escapeHtml(event.title || "Untitled")}</h3>
                        <p>${escapeHtml(timeDisplay)}</p>
                        <small>${escapeHtml(calendarLabel)}</small>
                    </div>
                </article>
            `;
        }

        function renderAssignments() {
            const root = document.getElementById("assignments-root");
            if (!root) return;
            if (state.loadingDashboard) {
                const skeletonHtml = window.APStudySkeleton?.cards
                    ? window.APStudySkeleton.cards({
                        label: "Loading upcoming events...",
                        count: 3,
                        className: "md:col-span-2 lg:col-span-3",
                    })
                    : window.APStudyLoader.html("Loading upcoming events...", { sizePx: 46, textToneClass: "text-on-surface" });
                root.innerHTML = `
                    <div class="md:col-span-2 lg:col-span-3 rounded-xl border border-outline-variant/20 bg-surface-container p-10 text-center">
                        ${skeletonHtml}
                    </div>
                `;
                return;
            }
            const now = new Date();
            const upcoming = getVisibleEvents()
                .filter((e) => e.source !== "simulated")
                .filter((e) => e.endDate >= now || e.startDate >= now)
                .slice(0, 12);
            if (!upcoming.length) {
                root.innerHTML = `
                    <div class="md:col-span-2 lg:col-span-3 rounded-xl border border-outline-variant/20 bg-surface-container p-6 text-sm text-on-surface-variant">
                        No upcoming events found yet. Your calendar is still available above.
                    </div>
                `;
                return;
            }
            root.innerHTML = upcoming.map((event, index) => {
                const eventRef = getUpcomingEventRef(event);
                const urgency = event.isAllDay ? getUrgencyLabelAllDay(event) : getUrgencyLabel(event.startDate);
                const accent = getAccent(event.type, event.startDate);
                const calendarColor = getCalendarEventColor(event);
                const timeDisplay = event.isAllDay ? formatAllDayRange(event) : formatTimedEventRange(event);
                const calendarLabel = getCalendarEventLabel(event);
                const description = String(event.description || "").trim();
                const isExpanded = state.ui.expandedUpcomingRefs.has(eventRef);
                const descriptionId = `upcoming-event-description-${index}`;
                const canExpand = description.length > 140 || description.split(/\r\n|\r|\n/).length > 2;
                const descriptionClampClass = canExpand && !isExpanded ? "line-clamp-3" : "";
                const descriptionHtml = description
                    ? `
                        <div id="${descriptionId}" class="text-sm text-on-surface-variant leading-relaxed break-words ${descriptionClampClass}">
                            ${formatMultilineText(description)}
                        </div>
                        ${canExpand ? `
                            <button type="button" class="js-upcoming-toggle calendar-upcoming-toggle" data-event-ref="${escapeHtml(eventRef)}" aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="${descriptionId}">
                                ${isExpanded ? "Show less" : "Show more"}
                            </button>
                        ` : ""}
                    `
                    : "";
                return `
                    <article class="bg-surface-container hover:bg-surface-container-high transition-all duration-300 rounded-xl p-5 sm:p-6 relative overflow-hidden flex flex-col gap-4">
                        <div class="absolute left-0 top-0 bottom-0 w-1 ${accent.bar}"></div>
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <span class="text-xs uppercase tracking-[0.05em] font-bold px-2.5 py-1 rounded-md ${accent.tag}">${escapeHtml(urgency)}</span>
                            <span class="text-sm text-on-surface-variant text-right">${escapeHtml(timeDisplay)}</span>
                        </div>
                        <div class="space-y-2">
                            <h3 class="text-lg font-headline font-semibold text-on-surface leading-snug">${escapeHtml(event.title || "Untitled")}</h3>
                            <div class="flex items-center gap-2 text-sm text-on-surface-variant">
                                <span class="h-2.5 w-2.5 rounded-full shrink-0" style="background-color:${calendarColor};"></span>
                                <span class="truncate">${escapeHtml(calendarLabel)}</span>
                            </div>
                        </div>
                        ${descriptionHtml}
                    </article>
                `;
            }).join("");
        }

        function getUpcomingEventRef(event) {
            return getCalendarEventRef(event) || event.id || event.uid || `${event.title || "event"}|${event.startDate?.getTime?.() || ""}`;
        }

        return {
            buildMobileCalendarAgendaHtml,
            renderAssignments,
        };
    }

    window.APStudyCalendarAgenda = { createCalendarAgenda };
})();
