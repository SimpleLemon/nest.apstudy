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
            getEventBadgeColors,
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
            const indicatorColor = getEventBadgeColors(event).indicator;
            const completedClass = isTaskEvent(event) && event.completed ? " is-completed" : "";
            return `
                <article ${getEventElementAttributes(event)} class="calendar-mobile-event calendar-event-shell${completedClass}">
                    <span class="calendar-mobile-event-bar" style="background-color:${escapeHtml(indicatorColor)}"></span>
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
                root.innerHTML = buildAssignmentsSkeletonHtml();
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
                const urgency = event.isAllDay
                    ? getUrgencyLabelAllDay(event)
                    : getUrgencyLabel(event.startDate, new Date(), event.endDate);
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

        function buildAssignmentsSkeletonHtml() {
            const block = (className) => window.APStudySkeleton?.block?.(className)
                || `<div data-slot="skeleton" class="bg-muted rounded-md animate-pulse ${className}"></div>`;
            return `
                <div class="calendar-assignments-skeleton apstudy-skeleton md:col-span-2 lg:col-span-3" role="status" aria-live="polite" aria-busy="true">
                    <span class="sr-only">Loading upcoming events...</span>
                    <div class="contents" aria-hidden="true">
                        ${Array.from({ length: 3 }, (_, index) => `
                            <article class="calendar-assignment-skeleton-card rounded-xl border border-outline-variant/20 bg-surface-container p-5 sm:p-6">
                                <div class="flex items-start justify-between gap-3">
                                    ${block("h-6 w-20")}
                                    ${block("h-4 w-24")}
                                </div>
                                <div class="mt-5 flex flex-col gap-3">
                                    ${block(index === 1 ? "h-5 w-3/4" : "h-5 w-full")}
                                    <div class="flex items-center gap-2">${block("size-3 rounded-full")} ${block("h-3 w-24")}</div>
                                </div>
                                <div class="mt-5 flex flex-col gap-2">${block("h-3 w-full")} ${block("h-3 w-4/5")}</div>
                            </article>
                        `).join("")}
                    </div>
                </div>
            `;
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
