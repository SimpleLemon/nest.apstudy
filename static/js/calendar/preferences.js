(function () {
    function createCalendarPreferences({
        state,
        constants,
        getSavedCalendarInfo,
        renderCalendarMenu,
    }) {
        const {
            batchEndpoint,
            batchLimit,
            loadRetryCooldownMs,
            preferenceSaveDelayMs,
            preferenceSaveRetryDelaysMs,
            preferenceSaveTimeoutMs,
            preferenceSaveWarningCooldownMs,
        } = constants;

        function writeCalendarStateToStorage() {
            if (state.public.readOnly) return;
            localStorage.setItem("calendarState", JSON.stringify(Object.fromEntries(
                Object.entries(state.calendars).map(([cal, data]) => [cal, { visible: data.visible, color: data.color }])
            )));
        }

        function trackCalendarMutation(request, label = "calendar-save") {
            return window.APStudyPendingMutations?.track(request, label) || request;
        }

        function fetchWithTimeout(url, options = {}, timeoutMs = preferenceSaveTimeoutMs) {
            const controller = new AbortController();
            const { signal, ...rest } = options || {};
            if (signal) {
                signal.addEventListener("abort", () => controller.abort(), { once: true });
            }
            const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
            return fetch(url, { ...rest, signal: controller.signal }).finally(() => {
                window.clearTimeout(timeoutId);
            });
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
            if (state.public.readOnly) return;
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
            state.ui.preferenceNotice = "Calendar changes are taking longer to save. We will keep trying in the background.";
            state.ui.preferenceNoticeAt = now;
            renderCalendarMenu();
        }

        function scheduleCalendarPreferenceFlush(delayMs = preferenceSaveDelayMs) {
            if (state.public.readOnly) return;
            if (state.ui.preferenceFlushTimer) {
                clearTimeout(state.ui.preferenceFlushTimer);
            }
            if (state.ui.preferenceRetryTimer) {
                clearTimeout(state.ui.preferenceRetryTimer);
                state.ui.preferenceRetryTimer = null;
            }
            state.ui.preferenceFlushTimer = setTimeout(() => {
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
                    clearTimeout(state.ui.preferenceRetryTimer);
                }
                state.ui.preferenceRetryTimer = setTimeout(() => {
                    state.ui.preferenceRetryTimer = null;
                    void flushCalendarPreferenceQueue();
                }, delay);
                return;
            }
            state.ui.preferenceRetryCount = attempt + 1;
            showPreferenceNotice();
        }

        async function flushCalendarPreferenceQueue() {
            if (state.public.readOnly) return;
            if (state.ui.preferenceInFlight) return;
            if (!state.ui.preferenceDirty.size) return;

            const pending = Array.from(state.ui.preferenceDirty).slice(0, batchLimit);
            pending.forEach((calendarName) => state.ui.preferenceDirty.delete(calendarName));
            const preferences = pending.map(buildCalendarPreferencePayload).filter(Boolean);
            if (!preferences.length) return;

            state.ui.preferenceInFlight = true;
            const request = trackCalendarMutation(fetchWithTimeout(batchEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preferences }),
            }), "calendar-save");

            try {
                const res = await request;
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw new Error(payload.error || "Unable to save calendar preferences.");
                }

                state.ui.preferenceRetryCount = 0;
                clearPreferenceNotice();

                if (state.preferences.cache && typeof state.preferences.cache === "object") {
                    for (const pref of preferences) {
                        if (!pref?.calendar_name) continue;
                        state.preferences.cache[pref.calendar_name] = {
                            ...state.preferences.cache[pref.calendar_name],
                            calendar_name: pref.calendar_name,
                            color_hex: pref.color_hex,
                            visible: pref.visible,
                        };
                    }
                }

                const errors = Array.isArray(payload.errors) ? payload.errors : [];
                if (errors.length) {
                    for (const err of errors) {
                        if (err?.calendar_name) {
                            state.ui.preferenceDirty.add(err.calendar_name);
                        }
                    }
                    scheduleCalendarPreferenceFlush();
                }
            } catch (err) {
                console.warn("Failed to save calendar preferences:", err);
                pending.forEach((calendarName) => state.ui.preferenceDirty.add(calendarName));
                scheduleCalendarPreferenceRetry();
            } finally {
                state.ui.preferenceInFlight = false;
                if (state.ui.preferenceDirty.size && !state.ui.preferenceFlushTimer && !state.ui.preferenceRetryTimer) {
                    scheduleCalendarPreferenceFlush();
                }
            }
        }

        function queueCalendarPreferenceSave(calendarName, delayMs = preferenceSaveDelayMs) {
            markCalendarPreferenceDirty(calendarName);
            scheduleCalendarPreferenceFlush(delayMs);
        }

        function saveCalendarState() {
            if (state.public.readOnly) return;
            const toSave = {};
            for (const [cal, data] of Object.entries(state.calendars)) {
                toSave[cal] = { visible: data.visible, color: data.color };
                markCalendarPreferenceDirty(cal);
            }
            localStorage.setItem("calendarState", JSON.stringify(toSave));
            scheduleCalendarPreferenceFlush(0);
        }

        function applyStoredCalendarState(saved) {
            if (!saved) return;
            try {
                const data = JSON.parse(saved);
                for (const cal of Object.keys(state.calendars)) {
                    const info = getSavedCalendarInfo(data, cal);
                    if (!info) continue;
                    if (typeof info.visible === "boolean") state.calendars[cal].visible = info.visible;
                    if (typeof info.color === "string") state.calendars[cal].color = info.color;
                }
            } catch (err) {
                console.warn("Ignoring invalid saved calendar state:", err);
                localStorage.removeItem("calendarState");
            }
        }

        function applyCachedCalendarPreferences(prefsByName) {
            if (!prefsByName) return;
            for (const cal of Object.keys(state.calendars)) {
                if (state.ui.preferenceDirty.has(cal)) continue;
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
            if (state.public.readOnly) return;
            if (state.preferences.loading) return state.preferences.loading;
            if (state.preferences.loaded && !force) return;

            const now = Date.now();
            if (!force && state.preferences.lastAttemptAt && now - state.preferences.lastAttemptAt < loadRetryCooldownMs) {
                return;
            }
            state.preferences.lastAttemptAt = now;

            state.preferences.loading = (async () => {
                try {
                    const res = await fetch("/api/calendar/preferences");
                    if (!res.ok) return;
                    const payload = await res.json().catch(() => ({}));
                    const prefs = Array.isArray(payload.preferences) ? payload.preferences : [];
                    state.preferences.cache = Object.fromEntries(
                        prefs.filter((pref) => pref.calendar_name).map((pref) => [pref.calendar_name, pref])
                    );
                    state.preferences.loaded = true;
                    state.preferences.lastLoadedAt = Date.now();
                } catch (err) {
                    console.warn("Failed to load calendar preferences:", err);
                } finally {
                    state.preferences.loading = null;
                }
            })();

            return state.preferences.loading;
        }

        async function loadCalendarState(options = {}) {
            if (state.public.readOnly) return;
            const saved = localStorage.getItem("calendarState");
            if (saved) {
                applyStoredCalendarState(saved);
            }
            await ensureCalendarPreferencesLoaded(Boolean(options.force));
            applyCachedCalendarPreferences(state.preferences.cache);
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

    window.APStudyCalendarPreferences = { createCalendarPreferences };
})();
