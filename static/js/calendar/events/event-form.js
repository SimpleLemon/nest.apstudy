import { createCalendarStorage } from "../storage.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { escapeHtml } from "../../core/ui-primitives-module.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarDataAdapter } from "../adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

// Event create/edit modal and API integration.
export function createCalendarEventForm({ document, view: window, lifecycle, adapter, calendars, reload, canCreate = () => false, canMutateEvent = () => false }) {
    adapter = createCalendarDataAdapter(adapter || {}, { window });
    const { getCalendarOptions, getDefaultCalendarId, getCalendarColor, getStandardColors } = calendars;
    let modal = null;
    let currentMode = "create";
    let currentEventId = null;
    let currentEventRef = null;
    let currentEventData = null;
    let providerRevision = null;
    let providerAttempt = null;
    let providerAttemptBody = null;
    let providerTimezone = null;
    let selectedCalendarId = null;
    let selectedColor = null;
    let openerEl = null;

    function defaultReminderMinutes(isAllDay) {
        return isAllDay ? -1 : 10;
    }

    function reminderOptions(isAllDay) {
        return isAllDay
            ? [
                [-1, "None (default)"],
                [-540, "On day of event (9 AM)"],
                [900, "1 day before (9 AM)"],
                [2340, "2 days before (9 AM)"],
                [9540, "1 week before (9 AM)"],
            ]
            : [
                [-1, "None"],
                [0, "At time of event"],
                [5, "5 minutes before"],
                [10, "10 minutes before (default)"],
                [15, "15 minutes before"],
                [30, "30 minutes before"],
                [60, "1 hour before"],
                [120, "2 hours before"],
                [1440, "1 day before"],
                [2880, "2 days before"],
            ];
    }

    function ensureModal() {
        if (modal) return modal;
        modal = document.createElement("div");
        modal.className = "calendar-event-modal";
        modal.style.display = "none";
        modal.hidden = true;
        modal.setAttribute("aria-hidden", "true");
        document.body.appendChild(modal);
        modal.addEventListener("click", onModalClick);
        modal.addEventListener("change", onModalChange);
        modal.addEventListener("submit", onSubmit);
        return modal;
    }

    function closeModal() {
        if (!modal) return;
        const m = modal;
        m.style.display = "none";
        m.hidden = true;
        m.setAttribute("aria-hidden", "true");
        m.remove();
        modal = null;
        const focusTarget = openerEl;
        currentMode = "create";
        currentEventId = null;
        currentEventRef = null;
        selectedCalendarId = null;
        selectedColor = null;
        openerEl = null;
        if (focusTarget?.isConnected) focusTarget.focus?.({ preventScroll: true });
    }

    function isoLocalForInput(value) {
        if (!value) return "";
        if (value instanceof Date) return dateToInputValue(value);
        const text = String(value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`;
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) return "";
        return dateToInputValue(date);
    }

    function dateToInputValue(date) {
        return window.APStudyDate?.toLocalInputValue ? window.APStudyDate.toLocalInputValue(date) : "";
    }

    function inputValueToIso(value) {
        return window.APStudyDate?.localInputToIso ? window.APStudyDate.localInputToIso(value) : null;
    }

    function renderModal(data = {}) {
        const m = ensureModal();
        const options = getCalendarOptions();
        const calendarId = selectedCalendarId || data.calendar_id || getDefaultCalendarId();
        const calendarColor = getCalendarColor(calendarId);
        const colors = getStandardColors();
        const isInherited = !selectedColor;
        const isAllDay = Boolean(data.is_all_day || data.all_day);
        const availableReminders = reminderOptions(isAllDay);
        const requestedReminder = Number(data.reminder_minutes ?? defaultReminderMinutes(isAllDay));
        const reminderMinutes = availableReminders.some(([value]) => value === requestedReminder)
            ? requestedReminder
            : defaultReminderMinutes(isAllDay);
        const isView = currentMode === "view";
        const readOnlyAttribute = isView ? " readonly" : "";
        const disabledAttribute = isView ? " disabled" : "";
        const title = currentMode === "create" ? "New Event" : isView ? "Event details" : "Event";
        m.innerHTML = `
            <div class="calendar-event-backdrop" data-event-close tabindex="-1"></div>
            <div class="calendar-event-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <form id="apstudy-event-form" class="calendar-event-form">
                    <div class="calendar-event-header">
                        <h3 class="calendar-event-title">${escapeHtml(title)}</h3>
                        <button type="button" class="calendar-event-icon-button" data-event-close aria-label="Close event form">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
                        </button>
                    </div>
                    <label class="calendar-event-field">
                        <span>Title</span>
                        <input name="title" required value="${escapeHtml(data.title || "")}" autocomplete="off"${readOnlyAttribute}>
                    </label>
                    <label class="calendar-event-field">
                        <span>Description</span>
                        <textarea name="description" rows="3"${readOnlyAttribute}>${escapeHtml(data.description || "")}</textarea>
                    </label>
                    <div class="calendar-event-grid">
                        <label class="calendar-event-field">
                            <span>Start</span>
                            <input name="start" type="datetime-local" value="${escapeHtml(isoLocalForInput(data.start || data.start_date || data.startDate))}"${readOnlyAttribute}>
                        </label>
                        <label class="calendar-event-field">
                            <span>End</span>
                            <input name="end" type="datetime-local" value="${escapeHtml(isoLocalForInput(data.end || data.end_date || data.endDate))}"${readOnlyAttribute}>
                        </label>
                    </div>
                    <div class="calendar-event-grid">
                        <label class="calendar-event-field">
                            <span>Calendar</span>
                            <select name="calendar_id"${disabledAttribute}>
                                ${options.map((option) => `
                                    <option value="${escapeHtml(option.id)}" ${option.id === calendarId ? "selected" : ""}>
                                        ${escapeHtml(option.label)}
                                    </option>
                                `).join("")}
                            </select>
                        </label>
                        <label class="calendar-event-check">
                            <input name="all_day" type="checkbox" ${isAllDay ? "checked" : ""}${disabledAttribute}>
                            <span>All day</span>
                        </label>
                    </div>
                    <label class="calendar-event-field">
                        <span>Alert</span>
                        <select name="reminder_minutes"${disabledAttribute}>
                            ${availableReminders.map(([value, label]) => `
                                <option value="${value}" ${value === reminderMinutes ? "selected" : ""}>${escapeHtml(label)}</option>
                            `).join("")}
                        </select>
                    </label>
                    ${isView ? "" : `<div class="calendar-event-color-section">
                        <div class="calendar-event-color-head">
                            <span>Calendar Color</span>
                        </div>
                        <div class="calendar-event-color-grid">
                            <button type="button"
                                class="calendar-event-color-choice calendar-event-color-inherit ${isInherited ? "is-selected" : ""}"
                                data-event-color=""
                                aria-label="Use calendar color"
                                style="--event-color:${calendarColor};">
                                <span></span>
                            </button>
                            ${colors.map((color) => `
                                <button type="button"
                                    class="calendar-event-color-choice ${selectedColor === color ? "is-selected" : ""}"
                                    data-event-color="${escapeHtml(color)}"
                                    aria-label="Use ${escapeHtml(color)}"
                                    style="--event-color:${escapeHtml(color)};">
                                    <span></span>
                                </button>
                            `).join("")}
                        </div>
                    </div>`}
                    <p id="apstudy-event-error" class="calendar-event-error hidden" role="alert"></p>
                    <div class="calendar-event-footer">
                        <button type="button" class="calendar-event-button ${isView ? "calendar-event-button-primary" : "calendar-event-button-secondary"}" data-event-close>${isView ? "Close" : "Cancel"}</button>
                        ${isView ? "" : `<button type="submit" class="calendar-event-button calendar-event-button-primary">Save</button>`}
                    </div>
                </form>
            </div>
        `;
        m.hidden = false;
        m.removeAttribute("aria-hidden");
        m.style.display = "flex";
        const form = m.querySelector("form");
        clearFormErrors(form);
        if (data.source_type === "external" || String(calendarId).startsWith("external:")) {
            const label = document.createElement("label"); label.textContent = "Location";
            const location = document.createElement("input"); location.name = "location"; location.value = data.location || ""; location.disabled = isView;
            label.append(location); form.querySelector(".calendar-event-footer")?.before(label);
            const select = form.querySelector('[name="calendar_id"]'); if (select && currentMode === "edit") select.disabled = true;
        }

        if (data.source_type === "external" && data.source_url) {
            const link = document.createElement("a"); link.textContent = data.provider === "google" ? "Open in Google Calendar" : "Open in Outlook";
            link.href = data.source_url; link.target = "_blank"; link.rel = "noopener noreferrer"; form.querySelector(".calendar-event-footer")?.prepend(link);
        }
        form?.querySelector("input[name='title']")?.focus();
    }

    function openForm({ mode = "create", data = {}, opener = null } = {}) {
        if (!["create", "edit", "override", "view"].includes(mode)) return;
        if (mode === "create" && !canCreate()) return;
        if ((mode === "edit" || mode === "override") && !canMutateEvent(data)) return;
        openerEl = opener || document.activeElement;
        currentMode = mode;
        currentEventData = data;
        currentEventId = mode === "edit" ? data.id || null : null;
        currentEventRef = data.event_ref || null;
        providerRevision = data.revision || null;
        providerTimezone = data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        providerAttempt = (window.crypto || globalThis.crypto).randomUUID();
        providerAttemptBody = null;
        selectedCalendarId = data.calendar_id || getDefaultCalendarId();
        selectedColor = data.color || null;
        renderModal(data);
    }

    function onModalClick(event) {
        if (event.target.closest("[data-event-close]")) {
            closeModal();
            return;
        }
        const colorButton = event.target.closest("[data-event-color]");
        if (colorButton && currentMode !== "view") {
            selectedColor = colorButton.getAttribute("data-event-color") || null;
            const form = ensureModal().querySelector("form");
            renderModal(readFormData(form));
        }
    }

    function onModalChange(event) {
        if (currentMode === "view") return;
        if (event.target?.name !== "calendar_id" && event.target?.name !== "all_day") return;
        const form = ensureModal().querySelector("form");
        const data = readFormData(form);
        if (event.target.name === "calendar_id") {
            selectedCalendarId = event.target.value || getDefaultCalendarId();
        } else {
            data.reminder_minutes = defaultReminderMinutes(Boolean(event.target.checked));
        }
        renderModal(data);
    }

    function readFormData(form) {
        if (!form) return {};
        return {
            id: currentEventId,
            event_ref: currentEventRef,
            title: form.title?.value || "",
            description: form.description?.value || "",
            start: form.start?.value || "",
            end: form.end?.value || "",
            is_all_day: Boolean(form.all_day?.checked),
            reminder_minutes: Number(form.reminder_minutes?.value ?? defaultReminderMinutes(Boolean(form.all_day?.checked))),
            calendar_id: form.calendar_id?.value || selectedCalendarId || getDefaultCalendarId(),
            color: selectedColor,
            timezone: providerTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
    }

    async function onSubmit(event) {
        if (event.target?.id !== "apstudy-event-form") return;
        event.preventDefault();
        if (currentMode === "view" || (currentMode === "create" && !canCreate())) return;
        if ((currentMode === "edit" || currentMode === "override") && !canMutateEvent(currentEventData)) return;
        if (currentMode === "edit" && !currentEventId) return;
        if (currentMode === "override" && !currentEventRef) return;
        const form = event.target;
        const payload = {
            title: form.title.value.trim(),
            description: form.description.value.trim(),
            start_date: inputValueToIso(form.start.value),
            end_date: inputValueToIso(form.end.value),
            all_day: form.all_day.checked,
            reminder_minutes: Number(form.reminder_minutes.value),
            calendar_id: form.calendar_id.value || getDefaultCalendarId(),
            color: selectedColor,
            timezone: providerTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        if (String(currentEventRef || payload.calendar_id).startsWith("external:")) {
            payload.revision = providerRevision;
            payload.idempotency_key = providerAttempt;
            payload.timezone = providerTimezone;
            if (form.location) payload.location = form.location.value;
            payload.start = payload.all_day ? form.start.value.slice(0, 10) : payload.start_date;
            payload.end = payload.all_day ? form.end.value.slice(0, 10) : payload.end_date;
        }
        if (payload.idempotency_key) {
            const signature = JSON.stringify({ ...payload, idempotency_key: undefined });
            if (providerAttemptBody && providerAttemptBody !== signature) providerAttempt = (window.crypto || globalThis.crypto).randomUUID();
            providerAttemptBody = signature; payload.idempotency_key = providerAttempt;
        }
        if (currentMode === "override") {
            payload.event_ref = currentEventRef;
        }

        if (!payload.title) {
            window.APStudyFormField?.markInvalid?.(form.title);
            showError("Title is required.");
            return;
        }
        if (!payload.start_date || !payload.end_date) {
            const fields = [];
            if (!payload.start_date) fields.push(form.start);
            if (!payload.end_date) fields.push(form.end);
            window.APStudyFormField?.markInvalid?.(fields);
            showError("Start and end are required.");
            return;
        }
        window.APStudyFormField?.clearAll?.(form);

        const submit = form.querySelector("[type='submit']");
        const previousLabel = submit?.textContent || "Save";
        if (submit) {
            submit.disabled = true;
            submit.textContent = "Saving...";
        }

        const controller = lifecycle.trackAbortController();
        try {
            if ((currentMode === "edit" || currentMode === "override") && !canMutateEvent(currentEventData)) return;
            let result;
            if (currentMode === "override") {
                result = await adapter.overrideEvent({ payload, signal: controller.signal });
            } else if (currentMode === "edit" && currentEventId) {
                result = await adapter.updateEvent({ eventId: currentEventId, payload, signal: controller.signal });
            } else {
                if (!canCreate()) return;
                result = await adapter.createEvent({ payload, signal: controller.signal });
            }
            if (lifecycle.isDisposed()) return;
            const json = result.payload;
            if (!result.ok) {
                showError(json.error || "Save failed.");
                return;
            }
            createCalendarStorage(window).removeItem("calendarEventsCache");
            closeModal();
            reload();
            if (currentMode !== "edit" && currentMode !== "override") window.dispatchEvent(new window.CustomEvent('apstudy:notification-intent', { detail: { source: 'calendar' } }));
        } catch {
            if (!lifecycle.isDisposed()) showError("Save failed.");
        } finally {
            lifecycle.releaseAbortController(controller);
            if (submit) {
                submit.disabled = false;
                submit.textContent = previousLabel;
            }
        }
    }

    function showError(message) {
        const el = ensureModal().querySelector("#apstudy-event-error");
        if (!el) return;
        el.textContent = message;
        el.classList.remove("hidden");
    }

    function clearFormErrors(form) {
        const errorEl = ensureModal().querySelector("#apstudy-event-error");
        if (errorEl) {
            errorEl.textContent = "";
            errorEl.classList.add("hidden");
        }
        window.APStudyFormField?.clearAll?.(form || ensureModal().querySelector("form"));
    }

    lifecycle.addCleanup(closeModal);
    lifecycle.addEventListener(document, "keydown", (event) => {
        if (event.key === "Escape" && modal?.style.display !== "none") closeModal();
    });
    return { open: openForm, close: closeModal };
}
