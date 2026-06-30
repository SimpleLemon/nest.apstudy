// Event create/edit modal and API integration.
(function () {
    let modal = null;
    let currentMode = "create";
    let currentEventId = null;
    let currentEventRef = null;
    let selectedCalendarId = null;
    let selectedColor = null;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function getCalendarOptions() {
        if (typeof window.getCalendarOptionsForEventForm === "function") {
            return window.getCalendarOptionsForEventForm();
        }
        return [{ id: "local:default", label: "Personal", color: "#0ea5e9", kind: "local" }];
    }

    function getDefaultCalendarId() {
        if (typeof window.getDefaultCalendarIdForEventForm === "function") {
            return window.getDefaultCalendarIdForEventForm();
        }
        return "local:default";
    }

    function getCalendarColor(calendarId) {
        if (typeof window.getCalendarColorForEventForm === "function") {
            return window.getCalendarColorForEventForm(calendarId);
        }
        return "#0ea5e9";
    }

    function getStandardColors() {
        if (typeof window.getStandardCalendarColors === "function") {
            return window.getStandardCalendarColors();
        }
        return ["#ef4444", "#f97316", "#eab308", "#84cc16", "#0ea5e9", "#d946ef", "#b08968"];
    }

    function ensureModal() {
        if (modal) return modal;
        modal = document.createElement("div");
        modal.className = "calendar-event-modal";
        modal.style.display = "none";
        document.body.appendChild(modal);
        modal.addEventListener("click", onModalClick);
        modal.addEventListener("change", onModalChange);
        modal.addEventListener("submit", onSubmit);
        return modal;
    }

    function closeEventFormModal() {
        const m = ensureModal();
        m.style.display = "none";
        currentMode = "create";
        currentEventId = null;
        currentEventRef = null;
        selectedCalendarId = null;
        selectedColor = null;
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
        const title = currentMode === "create" ? "New Event" : "Event";
        m.innerHTML = `
            <div class="calendar-event-backdrop" data-event-close tabindex="-1"></div>
            <div class="calendar-event-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <form id="apstudy-event-form" class="calendar-event-form">
                    <div class="calendar-event-header">
                        <h3 class="calendar-event-title">${escapeHtml(title)}</h3>
                        <button type="button" class="calendar-event-icon-button" data-event-close aria-label="Close event form">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <label class="calendar-event-field">
                        <span>Title</span>
                        <input name="title" required value="${escapeHtml(data.title || "")}" autocomplete="off">
                    </label>
                    <label class="calendar-event-field">
                        <span>Description</span>
                        <textarea name="description" rows="3">${escapeHtml(data.description || "")}</textarea>
                    </label>
                    <div class="calendar-event-grid">
                        <label class="calendar-event-field">
                            <span>Start</span>
                            <input name="start" type="datetime-local" value="${escapeHtml(isoLocalForInput(data.start || data.start_date || data.startDate))}">
                        </label>
                        <label class="calendar-event-field">
                            <span>End</span>
                            <input name="end" type="datetime-local" value="${escapeHtml(isoLocalForInput(data.end || data.end_date || data.endDate))}">
                        </label>
                    </div>
                    <div class="calendar-event-grid">
                        <label class="calendar-event-field">
                            <span>Calendar</span>
                            <select name="calendar_id">
                                ${options.map((option) => `
                                    <option value="${escapeHtml(option.id)}" ${option.id === calendarId ? "selected" : ""}>
                                        ${escapeHtml(option.label)}
                                    </option>
                                `).join("")}
                            </select>
                        </label>
                        <label class="calendar-event-check">
                            <input name="all_day" type="checkbox" ${data.is_all_day || data.all_day ? "checked" : ""}>
                            <span>All day</span>
                        </label>
                    </div>
                    <div class="calendar-event-color-section">
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
                    </div>
                    <p id="apstudy-event-error" class="calendar-event-error hidden"></p>
                    <div class="calendar-event-footer">
                        <button type="button" class="calendar-event-button calendar-event-button-secondary" data-event-close>Cancel</button>
                        <button type="submit" class="calendar-event-button calendar-event-button-primary">Save</button>
                    </div>
                </form>
            </div>
        `;
        m.style.display = "flex";
        m.querySelector("input[name='title']")?.focus();
    }

    function openForm({ mode = "create", data = {} } = {}) {
        currentMode = mode;
        currentEventId = mode === "edit" ? data.id || null : null;
        currentEventRef = data.event_ref || null;
        selectedCalendarId = data.calendar_id || getDefaultCalendarId();
        selectedColor = data.color || null;
        renderModal(data);
    }

    function onModalClick(event) {
        if (event.target.closest("[data-event-close]")) {
            closeEventFormModal();
            return;
        }
        const colorButton = event.target.closest("[data-event-color]");
        if (colorButton) {
            selectedColor = colorButton.getAttribute("data-event-color") || null;
            const form = ensureModal().querySelector("form");
            renderModal(readFormData(form));
        }
    }

    function onModalChange(event) {
        if (event.target?.name !== "calendar_id") return;
        selectedCalendarId = event.target.value || getDefaultCalendarId();
        const form = ensureModal().querySelector("form");
        renderModal(readFormData(form));
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
            calendar_id: form.calendar_id?.value || selectedCalendarId || getDefaultCalendarId(),
            color: selectedColor,
        };
    }

    async function onSubmit(event) {
        if (event.target?.id !== "apstudy-event-form") return;
        event.preventDefault();
        const form = event.target;
        const payload = {
            title: form.title.value.trim(),
            description: form.description.value.trim(),
            start_date: inputValueToIso(form.start.value),
            end_date: inputValueToIso(form.end.value),
            all_day: form.all_day.checked,
            calendar_id: form.calendar_id.value || getDefaultCalendarId(),
            color: selectedColor,
        };
        if (currentMode === "override") {
            payload.event_ref = currentEventRef;
        }

        if (!payload.title) {
            showError("Title is required.");
            return;
        }
        if (!payload.start_date || !payload.end_date) {
            showError("Start and end are required.");
            return;
        }

        const submit = form.querySelector("[type='submit']");
        const previousLabel = submit?.textContent || "Save";
        if (submit) {
            submit.disabled = true;
            submit.textContent = "Saving...";
        }

        try {
            let res;
            if (currentMode === "override") {
                res = await fetch("/api/calendar/event-overrides", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } else if (currentMode === "edit" && currentEventId) {
                res = await fetch(`/api/calendar/events/${encodeURIComponent(currentEventId)}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } else {
                res = await fetch("/api/calendar/events", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            }
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                showError(json.error || "Save failed.");
                return;
            }
            localStorage.removeItem("calendarEventsCache");
            closeEventFormModal();
            window.loadCalendarData && window.loadCalendarData();
        } catch (_) {
            showError("Save failed.");
        } finally {
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

    window.openCalendarEventForm = function (opts) {
        openForm(opts);
    };

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal?.style.display !== "none") {
            closeEventFormModal();
        }
    });
})();
