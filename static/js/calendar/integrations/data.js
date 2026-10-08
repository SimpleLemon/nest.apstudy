import { createCalendarStorage } from "../storage.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarDataAdapter } from "../adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
export function createCalendarData({
    lifecycle = null,
    dataAdapter = null,
    runtimeWindow = null,
    state,
    strictLoad = false,
    authenticatedReadOnly = false,
    constants,
    buildSimulatedMeetingEvents,
    ensureSimulatedCalendarPreference,
    getEventCalendarKey,
    getStartOfWeek,
    hydrateSelectedSimulatedSections,
    initCalendarState,
    loadCalendarState,
    queueCalendarPreferenceSave,
    render,
    writeCalendarStateToStorage,
}) {
    runtimeWindow ||= globalThis.window || globalThis;
    const storage = createCalendarStorage(runtimeWindow);
    const adapter = createCalendarDataAdapter(dataAdapter || {}, { window: runtimeWindow });

    const {
        calendarBufferDays,
        eventsCacheKey,
        simulatedCalendarName,
        taskCalendarId,
        taskCalendarName,
        toggleRefreshDelayMs,
    } = constants;

    let loadGeneration = 0;

    function requestSignal() {
        return lifecycle?.trackAbortController?.() || new (runtimeWindow.AbortController || globalThis.AbortController)();
    }

    function localDateInput(date) {
        const pad = (v) => String(v).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function parseEventDate(dateStr, isAllDay) {
        if (!dateStr) return new Date();
        if (isAllDay && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            const parts = dateStr.split("-");
            return new Date(
                parseInt(parts[0], 10),
                parseInt(parts[1], 10) - 1,
                parseInt(parts[2], 10),
                0, 0, 0, 0
            );
        }
        return new Date(dateStr);
    }

    function readEventsCache() {
        const raw = storage.getItem(eventsCacheKey);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (err) {
            console.warn("Ignoring invalid cached calendar events:", err);
            storage.removeItem(eventsCacheKey);
            return null;
        }
    }

    function parseCachedRange(range) {
        if (!range?.start || !range?.end) return null;
        const start = new Date(range.start);
        const end = new Date(range.end);
        if (Number.isNaN(start?.getTime()) || Number.isNaN(end?.getTime())) return null;
        return { start, end };
    }

    function writeEventsCache(payload, range) {
        try {
            storage.setItem(eventsCacheKey, JSON.stringify({
                cached_at: Date.now(),
                range: range ? { start: range.start.toISOString(), end: range.end.toISOString() } : null,
                payload: { ...payload, events: (payload.events || []).filter(event => event.source_type !== "external"), sources: (payload.sources || []).filter(source => !String(source.id).startsWith("external:")), calendar_sources: (payload.calendar_sources || payload.sources || []).filter(source => !String(source.id).startsWith("external:")) },
            }));
        } catch (err) {
            console.warn("Failed to cache calendar events:", err);
        }
    }

    function normalizeEventsList(events) {
        return Array.isArray(events)
            ? events
                    .filter((e) => e.start)
                    .map((e) => {
                        const isAllDay = Boolean(e.is_all_day ?? e.all_day);
                        return {
                            ...e,
                            startDate: parseEventDate(e.start, isAllDay),
                            endDate: e.end ? parseEventDate(e.end, isAllDay) : parseEventDate(e.start, isAllDay),
                            isAllDay,
                            isMultiDay: Boolean(e.is_multi_day ?? e.multi_day),
                            spanDays: e.span_days || 1,
                        };
                    })
                    .sort((a, b) => a.startDate - b.startDate)
            : [];
    }

    function eventOverlapsRange(event, rangeStart, rangeEnd) {
        const start = event.startDate;
        const end = event.endDate || event.startDate;
        if (!start || !end) return false;
        if (end <= start) return start >= rangeStart && start < rangeEnd;
        return start < rangeEnd && end > rangeStart;
    }

    function replaceEventsInRange(existingEvents, newEvents, range) {
        if (!range) return newEvents;
        const filtered = existingEvents.filter((event) => !eventOverlapsRange(event, range.start, range.end));
        return filtered.concat(newEvents).sort((a, b) => a.startDate - b.startDate);
    }

    function addLoadedRange(range, replace = false) {
        const ranges = (replace ? [] : state.loadedRanges).concat(range).sort((a, b) => a.start - b.start);
        state.loadedRanges = [];
        for (const next of ranges) {
            const previous = state.loadedRanges.at(-1);
            if (previous && previous.end >= next.start) {
                previous.end = new Date(Math.max(previous.end.getTime(), next.end.getTime()));
            } else {
                state.loadedRanges.push({ start: new Date(next.start), end: new Date(next.end) });
            }
        }
    }

    function rangeCovers(a, b) {
        if (!a || !b) return false;
        return a.start <= b.start && a.end >= b.end;
    }

    function getBufferedRange(baseRange) {
        const start = new Date(baseRange.start);
        const end = new Date(baseRange.end);
        start.setDate(start.getDate() - calendarBufferDays);
        end.setDate(end.getDate() + calendarBufferDays);
        return { start, end };
    }

    function getRangeKey(range) {
        return `${range.start.toISOString()}|${range.end.toISOString()}`;
    }

    async function fetchEventsForRange(range) {
        if (lifecycle?.isDisposed?.()) return { events: [] };
        const controller = requestSignal();
        try {
            const { ok, response, payload } = await adapter.loadRange({
                range: runtimeWindow.APStudyDate?.localInputToIso ? {
                    start: new Date(runtimeWindow.APStudyDate.localInputToIso(localDateInput(range.start))),
                    end: new Date(runtimeWindow.APStudyDate.localInputToIso(localDateInput(range.end))),
                } : range,
                readOnly: state.public.readOnly,
                shareCode: state.public.shareCode,
                signal: controller.signal,
            });
            if (controller.signal.aborted || lifecycle?.isDisposed?.()) {
                throw new globalThis.DOMException("Calendar load cancelled", "AbortError");
            }
            if (!ok) {
                const detail = payload.error || payload.message || payload.code;
                const error = new Error(`Unable to fetch calendar events (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
                error.status = response.status;
                error.url = response.url;
                error.response = response;
                error.payload = payload;
                throw error;
            }
            return payload;
        } catch (error) {
            if (error.name === "AbortError" || error.response) throw error;
            throw new Error(`Unable to fetch calendar events: ${error.message || "Unable to reach the calendar server."}`, { cause: error });
        } finally {
            lifecycle?.releaseAbortController?.(controller);
        }
    }

    async function applyEventsPayload(payload, options = {}) {
        if (lifecycle?.isDisposed?.() || options.isCurrent?.() === false) return;
        const range = options.range || null;
        state.calendarSources = Array.isArray(payload?.calendar_sources) ? payload.calendar_sources : (payload?.sources || []);
        const newEvents = normalizeEventsList(payload?.events);
        const mergeRange = Boolean(options.mergeRange);
        state.events = mergeRange
            ? replaceEventsInRange(state.events, newEvents, range)
            : newEvents;

        if (payload) {
            if (typeof payload.feed_configured === "boolean") {
                state.feedConfigured = payload.feed_configured;
            }
            state.eventsMeta = {
                lastFetched: payload.last_fetched || null,
                refreshIntervalMinutes: payload.refresh_interval_minutes || null,
            };
        }

        if (range) {
            addLoadedRange(range, !mergeRange);
        }

        initCalendarState();
        if (!state.public.readOnly || authenticatedReadOnly) {
            await loadCalendarState();
            if (!state.public.readOnly) ensureSimulatedCalendarPreference();
        }
        if (lifecycle?.isDisposed?.() || options.isCurrent?.() === false) return;
        if (!options.fromCache) state.loadError = null;
        render();
        if (!state.public.readOnly && options.shouldHydrate) {
            await hydrateSelectedSimulatedSections();
        }
        if (!lifecycle?.isDisposed?.() && options.isCurrent?.() !== false && !state.public.readOnly && !options.fromCache) {
            writeEventsCache(payload, range);
        }
    }

    function shouldRefreshInBackground(payload) {
        if (!payload?.feed_configured) return false;
        const interval = Number(payload.refresh_interval_minutes || 0);
        if (!interval) return false;
        if (!payload.last_fetched) return true;
        const lastFetched = new Date(payload.last_fetched);
        if (Number.isNaN(lastFetched.getTime())) return false;
        return Date.now() - lastFetched.getTime() > interval * 60 * 1000;
    }

    async function maybeRefreshIfStale(payload, range, isCurrent) {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        if (!shouldRefreshInBackground(payload) || state.refreshInFlight) return;
        state.refreshInFlight = true;
        try {
            await refreshCalendarFeed();
            if (isCurrent?.() === false) return;
            const refreshed = await fetchEventsForRange(range);
            await applyEventsPayload(refreshed, { range, mergeRange: true, isCurrent });
        } catch (err) {
            console.error("Background refresh failed:", err);
        } finally {
            state.refreshInFlight = false;
        }
    }

    async function ensureEventsForRange(range) {
        if (lifecycle?.isDisposed?.()) return;
        if (state.loadedRanges.some(loaded => rangeCovers(loaded, range))) return;
        const key = getRangeKey(range);
        if (state.pendingRanges.has(key)) return;
        const generation = ++loadGeneration;
        const isCurrent = () => generation === loadGeneration && !lifecycle?.isDisposed?.();
        state.loadingDashboard = false;
        state.pendingRanges.add(key);
        try {
            const payload = await fetchEventsForRange(range);
            await applyEventsPayload(payload, { range, mergeRange: true, isCurrent });
        } catch (err) {
            if (!isCurrent() || err.name === "AbortError") return;
            console.error("Failed to load additional calendar range:", err);
            reportCalendarLoadFailure(range);
        } finally {
            state.pendingRanges.delete(key);
        }
    }

    function reportCalendarLoadFailure(range, initial = false) {
        const retained = state.events.length ? " Previously loaded events are still shown." : "";
        const message = `Calendar ${initial ? "data" : "dates"} could not load.${retained} Try again to load these dates.`;
        state.loadError = { message, range, initial };
        render();
        if (runtimeWindow.APStudyToast?.show) {
            runtimeWindow.APStudyToast.show({ title: "Calendar could not load", message, type: "error" });
        } else {
            runtimeWindow.alert?.(message);
        }
    }

    async function retryCalendarLoad() {
        if (lifecycle?.isDisposed?.() || !state.loadError) return;
        const failure = state.loadError;
        state.loadError = null;
        render();
        if (failure.initial) return loadCalendarData();
        return ensureEventsForRange(failure.range);
    }

    async function runManualRefresh(range) {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        if (state.refreshInFlight) return;
        const generation = ++loadGeneration;
        const isCurrent = () => generation === loadGeneration && !lifecycle?.isDisposed?.();
        state.refreshInFlight = true;
        try {
            await refreshCalendarFeed();
            if (!isCurrent()) return;
            const payload = await fetchEventsForRange(range);
            await applyEventsPayload(payload, { range, mergeRange: true, isCurrent });
        } catch (err) {
            if (!isCurrent() || err.name === "AbortError") return;
            console.error("Manual refresh failed:", err);
            const message = `${err.message || "Calendar refresh failed."} Your saved events are still shown. Try Refresh again.`;
            if (runtimeWindow.APStudyToast?.show) {
                runtimeWindow.APStudyToast.show({ title: "Calendar could not refresh", message, type: "error" });
            } else {
                runtimeWindow.alert?.(message);
            }
        } finally {
            state.refreshInFlight = false;
        }
    }

    async function loadCalendarData() {
        if (lifecycle?.isDisposed?.()) return;
        const generation = ++loadGeneration;
        const isCurrent = () => generation === loadGeneration && !lifecycle?.isDisposed?.();
        const hadEvents = state.events.length > 0;
        state.loadingDashboard = true;
        render();

        let cached = null;
        try {
            cached = state.public.readOnly || strictLoad ? null : readEventsCache();
            const cachedRange = state.public.readOnly ? null : parseCachedRange(cached?.range);
            if (!state.public.readOnly && cached?.payload) {
                state.loadingDashboard = false;
                await applyEventsPayload(cached.payload, {
                    range: cachedRange,
                    mergeRange: false,
                    fromCache: true,
                    isCurrent,
                    shouldHydrate: false,
                });
            }

            if (!isCurrent()) return;
            const desiredRange = getBufferedRange(getCurrentRenderRange());
            const payload = await fetchEventsForRange(desiredRange);
            if (!isCurrent()) return;
            state.loadingDashboard = false;
            await applyEventsPayload(payload, {
                range: desiredRange,
                mergeRange: true,
                shouldHydrate: true,
                isCurrent,
            });
            if (isCurrent()) void maybeRefreshIfStale(payload, desiredRange, isCurrent);
        } catch (err) {
            if (!isCurrent()) return;
            if (strictLoad) throw err;
            if (err.name === "AbortError") return;
            if (!cached?.payload && !hadEvents) {
                initCalendarState();
                if (!state.public.readOnly) {
                    await loadCalendarState();
                    if (!isCurrent()) return;
                    ensureSimulatedCalendarPreference();
                }
                render();
                if (!state.public.readOnly) {
                    hydrateSelectedSimulatedSections();
                }
            }
            console.error(err);
            if (isCurrent()) reportCalendarLoadFailure(getBufferedRange(getCurrentRenderRange()), true);
        } finally {
            if (isCurrent()) {
                state.loadingDashboard = false;
                render();
            }
        }
    }

    async function refreshCalendarFeed() {
        if (lifecycle?.isDisposed?.()) throw new globalThis.DOMException("Calendar refresh cancelled", "AbortError");
        const controller = requestSignal();
        try {
            const { ok, response, payload } = await adapter.refresh({ signal: controller.signal });
            if (controller.signal.aborted || lifecycle?.isDisposed?.()) {
                throw new globalThis.DOMException("Calendar refresh cancelled", "AbortError");
            }
            if (!ok) {
                const error = new Error(`Calendar feed refresh failed (HTTP ${response.status})${payload.error ? `: ${payload.error}` : "."}`);
                error.status = response.status;
                throw error;
            }
        } catch (err) {
            if (err.name === "AbortError" || err.status !== undefined) throw err;
            throw new Error(`Calendar feed refresh failed: ${err.message || "Unable to reach the calendar server."}`, { cause: err });
        } finally {
            lifecycle?.releaseAbortController?.(controller);
        }
    }

    function getVisibleEvents() {
        const baseEvents = state.events.filter((e) => {
            const cal = getEventCalendarKey(e);
            return state.calendars[cal]?.visible !== false;
        });
        if ((state.public.readOnly && !authenticatedReadOnly) || state.calendars[simulatedCalendarName]?.visible === false || state.courses.selectedSectionIds.size === 0) {
            return baseEvents;
        }
        const renderRange = getCurrentRenderRange();
        const simulatedEvents = buildSimulatedMeetingEvents(renderRange.start, renderRange.end);
        return baseEvents.concat(simulatedEvents);
    }

    function getCurrentRenderRange() {
        if (state.view === "upcoming") {
            const start = new Date();
            start.setHours(0, 0, 0, 0);
            const end = new Date(start);
            end.setDate(end.getDate() + 30);
            end.setHours(23, 59, 59, 999);
            return { start, end };
        }
        if (state.view === "month") {
            const year = state.anchorDate.getFullYear();
            const month = state.anchorDate.getMonth();
            const monthStart = new Date(year, month, 1);
            const gridStart = new Date(monthStart);
            gridStart.setDate(monthStart.getDate() - monthStart.getDay());
            const gridEnd = new Date(gridStart);
            gridEnd.setDate(gridStart.getDate() + 41);
            gridEnd.setHours(23, 59, 59, 999);
            return { start: gridStart, end: gridEnd };
        }
        const weekStart = getStartOfWeek(state.anchorDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        return { start: weekStart, end: weekEnd };
    }

    function getEventCalendarColor(event) {
        if (event?.color) return event.color;
        const cal = getEventCalendarKey(event);
        return state.calendars[cal]?.color || "#6366f1";
    }

    function isExternalFeedCalendar(calendarName, calendarData) {
        if (!calendarData) return false;
        if (calendarName === simulatedCalendarName) return false;
        if (calendarName === taskCalendarId || calendarName === taskCalendarName) return false;
        if (calendarData.kind === "canvas" || calendarData.kind === "external") return true;
        if (calendarName === "canvas" || String(calendarName).startsWith("feed:")) return true;
        return false;
    }

    function scheduleCalendarToggleRefresh(delayMs = toggleRefreshDelayMs) {
        if (state.ui.toggleRefreshTimer) {
            lifecycle?.clearTimeout?.(state.ui.toggleRefreshTimer);
        }
        const schedule = lifecycle?.setTimeout || runtimeWindow.setTimeout.bind(runtimeWindow);
        state.ui.toggleRefreshTimer = schedule(() => {
            state.ui.toggleRefreshTimer = null;
            void runCalendarToggleRefresh();
        }, delayMs);
    }

    function queueCalendarVisibilityRefresh(calendarName, visible) {
        if (state.public.readOnly) return;
        if (!visible) return;
        const calendar = state.calendars[calendarName];
        if (!calendar) return;
        if (isExternalFeedCalendar(calendarName, calendar)) {
            state.ui.toggleRefreshNeedsFeed = true;
            state.ui.toggleRefreshNeedsEvents = true;
        } else {
            state.ui.toggleRefreshNeedsEvents = true;
        }
        scheduleCalendarToggleRefresh();
    }

    async function runCalendarToggleRefresh() {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        const needsFeed = state.ui.toggleRefreshNeedsFeed;
        const needsEvents = state.ui.toggleRefreshNeedsEvents;
        state.ui.toggleRefreshNeedsFeed = false;
        state.ui.toggleRefreshNeedsEvents = false;

        if (!needsFeed && !needsEvents) return;
        if (state.refreshInFlight) {
            state.ui.toggleRefreshNeedsFeed = state.ui.toggleRefreshNeedsFeed || needsFeed;
            state.ui.toggleRefreshNeedsEvents = state.ui.toggleRefreshNeedsEvents || needsEvents;
            scheduleCalendarToggleRefresh();
            return;
        }

        const range = getBufferedRange(getCurrentRenderRange());
        if (!needsFeed && needsEvents && state.loadedRanges.some(loaded => rangeCovers(loaded, range))) {
            render();
            return;
        }

        try {
            if (needsFeed) {
                state.refreshInFlight = true;
                await refreshCalendarFeed();
            }
            if (needsEvents) {
                const payload = await fetchEventsForRange(range);
                await applyEventsPayload(payload, { range, mergeRange: true });
            }
        } catch (err) {
            if (lifecycle?.isDisposed?.() || err.name === "AbortError") return;
            // Keep the requested refresh pending for the next edit or reconnect.
            state.ui.toggleRefreshNeedsFeed ||= needsFeed;
            state.ui.toggleRefreshNeedsEvents ||= needsEvents;
            console.error("Calendar refresh after toggle failed:", err);
        } finally {
            if (needsFeed) {
                state.refreshInFlight = false;
            }
        }
    }

    lifecycle?.addEventListener?.(runtimeWindow, "online", () => {
        if (state.ui.toggleRefreshNeedsFeed || state.ui.toggleRefreshNeedsEvents) scheduleCalendarToggleRefresh(0);
    });

    function toggleCalendarVisibility(calendarName) {
        const calendar = state.calendars[calendarName];
        if (!calendar) return;
        calendar.visible = !calendar.visible;
        if (!state.public.readOnly) {
            writeCalendarStateToStorage();
            queueCalendarPreferenceSave(calendarName);
        }
        queueCalendarVisibilityRefresh(calendarName, calendar.visible);
        render();
    }

    function setCalendarColor(calendarName, color) {
        if (state.public.readOnly) return;
        if (state.calendars[calendarName]) {
            state.calendars[calendarName].color = color;
            writeCalendarStateToStorage();
            queueCalendarPreferenceSave(calendarName);
            render();
        }
    }

    return {
        applyEventsPayload,
        fetchEventsForRange,
        getBufferedRange,
        getCurrentRenderRange,
        getEventCalendarColor,
        getVisibleEvents,
        loadCalendarData,
        refreshCalendarFeed,
        runManualRefresh,
        retryCalendarLoad,
        setCalendarColor,
        toggleCalendarVisibility,
        ensureEventsForRange,
    };
}
