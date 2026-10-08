import { createCalendarStorage } from "./storage.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarDataAdapter } from "./adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
export function createCalendarPreferences({
    lifecycle = null,
    dataAdapter = null,
    runtimeWindow = null,
    state,
    authenticatedReadOnly = false,
    strictLoad = false,
    constants,
    getSavedCalendarInfo,
    renderCalendarMenu,
}) {
    runtimeWindow ||= globalThis.window || globalThis;
    const storage = createCalendarStorage(runtimeWindow);
    const adapter = createCalendarDataAdapter(dataAdapter || {}, { window: runtimeWindow });
    let locallyPersisted = true;
    const submittedPreferenceNames = new Set();
    const schedule = lifecycle?.setTimeout || runtimeWindow.setTimeout?.bind(runtimeWindow) || globalThis.setTimeout;
    const cancelTimeout = lifecycle?.clearTimeout || runtimeWindow.clearTimeout?.bind(runtimeWindow) || globalThis.clearTimeout;

    const {
        batchLimit,
        loadRetryCooldownMs,
        preferenceSaveDelayMs,
        preferenceSaveRetryDelaysMs,
        preferenceSaveTimeoutMs,
        preferenceSaveWarningCooldownMs,
    } = constants;

    function createRequestController() {
        return lifecycle?.trackAbortController?.() || new (runtimeWindow.AbortController || globalThis.AbortController)();
    }

    function writeCalendarStateToStorage() {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        locallyPersisted = storage.setItem("calendarState", JSON.stringify(Object.fromEntries(
            Object.entries(state.calendars).map(([cal, data]) => [cal, { visible: data.visible, color: data.color }])
        )));
    }

    function trackCalendarMutation(request, label = "calendar-save") {
        return runtimeWindow.APStudyPendingMutations?.track(request, label) || request;
    }

    function buildCalendarPreferencePayload(calendarName) {
        const pref = state.calendars[calendarName];
        if (!pref) return null;
        return {
            calendar_name: calendarName,
            color_hex: pref.color,
            visible: pref.visible,
        };
    }

    function markCalendarPreferenceDirty(calendarName) {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        if (!state.calendars[calendarName]) return;
        state.ui.preferenceDirty.add(calendarName);
    }

    function clearPreferenceNotice() {
        if (!state.ui.preferenceNotice) return;
        state.ui.preferenceNotice = "";
        state.ui.preferenceNoticeAt = 0;
        renderCalendarMenu();
    }

    function showPreferenceNotice() {
        const now = Date.now();
        if (state.ui.preferenceNotice && now - state.ui.preferenceNoticeAt < preferenceSaveWarningCooldownMs) {
            return;
        }
        const retention = locallyPersisted ? "Your changes are kept on this device." : "Keep this calendar open to retain your changes.";
        state.ui.preferenceNotice = `Calendar changes are taking longer to save. ${retention} Edit a calendar or reconnect to try saving again.`;
        state.ui.preferenceNoticeAt = now;
        renderCalendarMenu();
    }

    function scheduleCalendarPreferenceFlush(delayMs = preferenceSaveDelayMs) {
        if (state.public.readOnly || state.ui.preferenceRetryPaused || lifecycle?.isDisposed?.()) return;
        if (state.ui.preferenceFlushTimer) {
            cancelTimeout(state.ui.preferenceFlushTimer);
        }
        if (state.ui.preferenceRetryTimer) {
            cancelTimeout(state.ui.preferenceRetryTimer);
            state.ui.preferenceRetryTimer = null;
        }
        state.ui.preferenceFlushTimer = schedule(() => {
            state.ui.preferenceFlushTimer = null;
            void flushCalendarPreferenceQueue();
        }, delayMs);
    }

    function scheduleCalendarPreferenceRetry() {
        const attempt = state.ui.preferenceRetryCount || 0;
        if (attempt < preferenceSaveRetryDelaysMs.length) {
            const delay = preferenceSaveRetryDelaysMs[attempt];
            state.ui.preferenceRetryCount = attempt + 1;
            if (state.ui.preferenceRetryTimer) {
                cancelTimeout(state.ui.preferenceRetryTimer);
            }
            state.ui.preferenceRetryTimer = schedule(() => {
                state.ui.preferenceRetryTimer = null;
                void flushCalendarPreferenceQueue();
            }, delay);
            return;
        }
        state.ui.preferenceRetryPaused = true;
        showPreferenceNotice();
    }

    async function flushCalendarPreferenceQueue() {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        if (state.ui.preferenceInFlight) return;
        if (!state.ui.preferenceDirty.size) return;

        const pending = Array.from(state.ui.preferenceDirty).slice(0, batchLimit);
        pending.forEach((calendarName) => state.ui.preferenceDirty.delete(calendarName));
        const preferences = pending.map(buildCalendarPreferencePayload).filter(Boolean);
        if (!preferences.length) return;

        state.ui.preferenceInFlight = true;
        pending.forEach(name => submittedPreferenceNames.add(name));
        const controller = createRequestController();
        const timeoutId = schedule(() => controller.abort(), preferenceSaveTimeoutMs);
        const request = trackCalendarMutation(adapter.savePreferences({
            payload: { preferences },
            signal: controller.signal,
        }), "calendar-save");

        try {
            const { ok, payload } = await request;
            if (lifecycle?.isDisposed?.()) return;
            if (!ok) {
                throw new Error(payload.error || "Unable to save calendar preferences.");
            }


            const errors = Array.isArray(payload.errors) ? payload.errors : [];
            const failedNames = new Set(errors.map(error => error?.calendar_name).filter(Boolean));
            if (state.preferences.cache && typeof state.preferences.cache === "object") {
                for (const pref of preferences) {
                    if (!pref?.calendar_name || failedNames.has(pref.calendar_name)) continue;
                    state.preferences.cache[pref.calendar_name] = {
                        ...state.preferences.cache[pref.calendar_name],
                        calendar_name: pref.calendar_name,
                        color_hex: pref.color_hex,
                        visible: pref.visible,
                    };
                }
            }

            if (errors.length) {
                // Item validation failures require a changed preference rather than an automatic retry.
                for (const calendarName of pending) {
                    if (failedNames.has(calendarName)) state.ui.preferenceDirty.add(calendarName);
                }
                state.ui.preferenceRetryPaused = true;
                showPreferenceNotice();
            } else {
                state.ui.preferenceRetryCount = 0;
                clearPreferenceNotice();
            }
        } catch (err) {
            console.warn("Failed to save calendar preferences:", err);
            if (!lifecycle?.isDisposed?.()) {
                pending.forEach((calendarName) => state.ui.preferenceDirty.add(calendarName));
                scheduleCalendarPreferenceRetry();
            }
        } finally {
            cancelTimeout(timeoutId);
            lifecycle?.releaseAbortController?.(controller);
            state.ui.preferenceInFlight = false;
            pending.forEach(name => submittedPreferenceNames.delete(name));
            if (!lifecycle?.isDisposed?.() && !state.ui.preferenceRetryPaused && state.ui.preferenceDirty.size && !state.ui.preferenceFlushTimer && !state.ui.preferenceRetryTimer) {
                scheduleCalendarPreferenceFlush();
            }
        }
    }

    function queueCalendarPreferenceSave(calendarName, delayMs = preferenceSaveDelayMs) {
        resumePreferenceRetries();
        markCalendarPreferenceDirty(calendarName);
        scheduleCalendarPreferenceFlush(delayMs);
    }

    function saveCalendarState() {
        if (state.public.readOnly || lifecycle?.isDisposed?.()) return;
        resumePreferenceRetries();
        const toSave = {};
        for (const [cal, data] of Object.entries(state.calendars)) {
            toSave[cal] = { visible: data.visible, color: data.color };
            markCalendarPreferenceDirty(cal);
        }
        locallyPersisted = storage.setItem("calendarState", JSON.stringify(toSave));
        scheduleCalendarPreferenceFlush(0);
    }

    function resumePreferenceRetries() {
        state.ui.preferenceRetryPaused = false;
        state.ui.preferenceRetryCount = 0;
    }
    lifecycle?.addEventListener?.(runtimeWindow, "online", () => {
        resumePreferenceRetries();
        if (state.ui.preferenceDirty.size) scheduleCalendarPreferenceFlush(0);
    });

    function applyStoredCalendarState(saved) {
        if (!saved) return;
        try {
            const data = JSON.parse(saved);
            for (const cal of Object.keys(state.calendars)) {
                if (state.ui.preferenceDirty.has(cal) || submittedPreferenceNames.has(cal)) continue;
                const info = getSavedCalendarInfo(data, cal);
                if (!info) continue;
                if (typeof info.visible === "boolean") state.calendars[cal].visible = info.visible;
                if (typeof info.color === "string") state.calendars[cal].color = info.color;
            }
        } catch (err) {
            console.warn("Ignoring invalid saved calendar state:", err);
            storage.removeItem("calendarState");
        }
    }

    function applyCachedCalendarPreferences(prefsByName) {
        if (!prefsByName) return;
        for (const cal of Object.keys(state.calendars)) {
            if (state.ui.preferenceDirty.has(cal) || submittedPreferenceNames.has(cal)) continue;
            const pref = getSavedCalendarInfo(prefsByName, cal);
            if (!pref) continue;
            if (typeof pref.visible === "boolean") state.calendars[cal].visible = pref.visible;
            if (typeof pref.color_hex === "string" && /^#[0-9a-fA-F]{6}$/.test(pref.color_hex)) {
                state.calendars[cal].color = pref.color_hex;
            }
            if (typeof pref.display_name === "string" && pref.display_name.trim() && state.calendars[cal].editable) {
                state.calendars[cal].label = pref.display_name.trim();
            }
        }
    }

    function invalidateCalendarPreferencesCache() {
        state.preferences.loaded = false;
        state.preferences.loading = null;
        state.preferences.cache = {};
        state.preferences.lastLoadedAt = null;
        state.preferences.lastAttemptAt = null;
    }

    async function ensureCalendarPreferencesLoaded(force = false) {
        if ((state.public.readOnly && !authenticatedReadOnly) || lifecycle?.isDisposed?.()) return;
        if (state.preferences.loading) return state.preferences.loading;
        if (state.preferences.loaded && !force) return;

        const now = Date.now();
        if (!strictLoad && !force && state.preferences.lastAttemptAt && now - state.preferences.lastAttemptAt < loadRetryCooldownMs) {
            return;
        }
        state.preferences.lastAttemptAt = now;

        const controller = createRequestController();
        state.preferences.loading = (async () => {
            try {
                const { ok, payload } = await adapter.loadPreferences({ signal: controller.signal });
                if (!ok) throw new Error("Unable to load calendar preferences");
                if (strictLoad && !Array.isArray(payload.preferences)) throw new Error("Invalid calendar preferences response");
                if (lifecycle?.isDisposed?.() || controller.signal.aborted) throw new Error("Calendar preference load cancelled");
                const prefs = Array.isArray(payload.preferences) ? payload.preferences : [];
                state.preferences.cache = Object.fromEntries(
                    prefs.filter((pref) => pref.calendar_name).map((pref) => [pref.calendar_name, pref])
                );
                state.preferences.loaded = true;
                state.preferences.lastLoadedAt = Date.now();
            } catch (err) {
                if (strictLoad) throw err;
                console.warn("Failed to load calendar preferences:", err);
            } finally {
                lifecycle?.releaseAbortController?.(controller);
                state.preferences.loading = null;
            }
        })();

        return state.preferences.loading;
    }

    async function loadCalendarState(options = {}) {
        if ((state.public.readOnly && !authenticatedReadOnly) || lifecycle?.isDisposed?.()) return;
        const saved = authenticatedReadOnly || strictLoad ? null : storage.getItem("calendarState");
        if (saved) {
            applyStoredCalendarState(saved);
        }
        await ensureCalendarPreferencesLoaded(Boolean(options.force));
        if (!lifecycle?.isDisposed?.()) applyCachedCalendarPreferences(state.preferences.cache);
    }

    return {
        ensureCalendarPreferencesLoaded,
        invalidateCalendarPreferencesCache,
        loadCalendarState,
        queueCalendarPreferenceSave,
        saveCalendarState,
        scheduleCalendarPreferenceFlush,
        trackCalendarMutation,
        writeCalendarStateToStorage,
    };
}
