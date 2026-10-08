import { createCalendarShareRowRenderer } from "./share-row.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
export function createCalendarShareRenderer({
    state, view, simulatedCalendarName, escapeHtml, getCalendarLabel,
    getCalendarLabelFromData, getIcsSelectionEligibility, getIcsState,
    canonicalIcsCalendarId, selectedCalendarIdsFromForm, rememberFocusedControl, restoreFocus,
}) {
    const { buildCalendarShareRowHtml } = createCalendarShareRowRenderer({
        escapeHtml, getIcsSelectionEligibility, getIcsState, canonicalIcsCalendarId,
    });
    function renderSubscriptionCreation(seed, icsEligibility) {
        return `
                            <section class="calendar-share-ics-create" aria-labelledby="calendar-share-ics-create-title">
                                <div class="calendar-share-ics-create-heading">
                                    <h4 id="calendar-share-ics-create-title">Calendar subscription</h4>
                                    <p>Optional: subscribe to this one Nest calendar from Apple Calendar, Google Calendar, or Outlook.</p>
                                </div>
                                <label class="calendar-share-ics-optin" data-ics-create-option ${icsEligibility.eligible ? "" : "hidden"}>
                                    <input type="checkbox" name="ics_enabled" value="1" ${seed.icsEnabled ? "checked" : ""}>
                                    <span>
                                        <strong>Enable an ICS subscription</strong>
                                        <small>Exports the previous 30 days through the next 366 days, using UTC dates.</small>
                                    </span>
                                </label>
                                <p class="calendar-share-ics-selection-note" data-ics-selection-note ${icsEligibility.eligible ? "hidden" : ""}>Choose exactly one Nest calendar—Canvas, Tasks, or Simulated Courses—to enable an ICS subscription. Multi-calendar and all-calendar shares stay browser-only.</p>
                                <p class="calendar-share-ics-selection-note" data-ics-simulated-note ${icsEligibility.calendarId === "simulated_courses" ? "" : "hidden"}>Simulated Courses exports only your saved server selections.</p>
                            </section>
                        `;
    }

    function renderShareForm({ editingShare, seed, formValidationError, editingBanner, includeAll, selectionLocked, calendarChoices, icsEligibility, sharesList }) {
        return `
                <form id="calendar-share-form" ${formValidationError ? 'aria-describedby="calendar-share-form-error"' : ""}>
                    <div class="calendar-info-body">
                        ${editingBanner}
                        <div class="calendar-share-options">
                            <label class="calendar-share-radio">
                                <input type="radio" name="include_scope" value="all" ${includeAll ? "checked" : ""} ${formValidationError ? 'aria-describedby="calendar-share-form-error" aria-invalid="true"' : ""}>
                                <span>All calendars</span>
                            </label>
                            <label class="calendar-share-radio">
                                <input type="radio" name="include_scope" value="selected" ${includeAll ? "" : "checked"} ${formValidationError ? 'aria-describedby="calendar-share-form-error" aria-invalid="true"' : ""}>
                                <span>Selected calendars</span>
                            </label>
                        </div>
                        <div class="calendar-share-calendar-grid ${includeAll ? "is-disabled" : ""} ${selectionLocked ? "is-locked" : ""}" aria-disabled="${includeAll || selectionLocked ? "true" : "false"}">
                            ${calendarChoices}
                        </div>
                        ${selectionLocked ? '<p class="calendar-share-lock-note" role="status">Calendar selection is locked while this ICS subscription exists. Remove the subscription below to unlock it. The browser share remains separate.</p>' : ""}
                        ${editingShare ? "" : renderSubscriptionCreation(seed, icsEligibility)}
                        ${editingShare?.icsConfigured ? '<p class="calendar-share-ics-edit-note">Manage this share’s ICS subscription in its row below. It does not change the browser share.</p>' : ""}
                        <label class="calendar-info-field">
                            <span class="calendar-info-label">Date range</span>
                            <select name="date_scope" class="calendar-info-input">
                                <option value="all" ${seed.dateScope === "all" ? "selected" : ""}>All shared dates</option>
                                <option value="fixed" ${seed.dateScope === "fixed" ? "selected" : ""}>Fixed date range</option>
                                <option value="rolling" ${seed.dateScope === "rolling" ? "selected" : ""}>Rolling window</option>
                            </select>
                        </label>
                        <div class="calendar-share-fixed-fields">
                            <label class="calendar-info-field">
                                <span class="calendar-info-label">Start</span>
                                <input name="fixed_start" type="date" class="calendar-info-input" value="${escapeHtml(seed.fixedStart || "")}">
                            </label>
                            <label class="calendar-info-field">
                                <span class="calendar-info-label">End</span>
                                <input name="fixed_end" type="date" class="calendar-info-input" value="${escapeHtml(seed.fixedEnd || "")}">
                            </label>
                        </div>
                        <label class="calendar-info-field calendar-share-rolling-field">
                            <span class="calendar-info-label">Rolling days</span>
                            <input name="rolling_days" type="number" min="1" max="366" step="1" class="calendar-info-input" value="${escapeHtml(seed.rollingDays || 30)}">
                        </label>
                        ${state.shares.error ? `<p id="${formValidationError ? "calendar-share-form-error" : "calendar-share-error"}" class="calendar-info-error" role="alert" aria-live="assertive" aria-atomic="true">${escapeHtml(state.shares.error)}</p>` : ""}
                        ${state.shares.notice ? `<p class="calendar-share-notice" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(state.shares.notice)}</p>` : ""}
                        <section class="calendar-share-list" aria-label="Calendar share links">
                            <div class="calendar-share-list-head">
                                <span>Links</span>
                                ${editingShare ? '<button type="button" class="js-share-new calendar-info-button calendar-info-button-secondary">New Link</button>' : ""}
                            </div>
                            ${sharesList}
                        </section>
                    </div>
                    <div class="calendar-info-footer">
                        <button type="submit" class="calendar-info-button calendar-info-button-primary" ${state.shares.saving ? "disabled" : ""}>
                            ${state.shares.saving ? "Saving..." : editingShare ? "Save Link" : "Create Link"}
                        </button>
                    </div>
                </form>
        `;
    }

    function renderCalendarShareModal() {
        const modal = state.ui.shareModalEl;
        if (!modal) return;
        rememberFocusedControl();
        const editingShare = state.shares.items.find((share) => share.id === state.shares.editingId) || null;
        const seed = editingShare || state.shares.draft || {
            includeAllCalendars: true,
            calendarIds: [],
            dateScope: "all",
            fixedStart: "",
            fixedEnd: "",
            rollingDays: 30,
        };
        const calendarEntries = Object.entries(state.calendars);
        if (!calendarEntries.some(([name]) => canonicalIcsCalendarId(name) === "simulated_courses")) {
            calendarEntries.push([simulatedCalendarName, {
                color: "#b08968",
                label: simulatedCalendarName,
                defaultName: simulatedCalendarName,
            }]);
        }
        const shareableCalendars = calendarEntries
            .sort(([, a], [, b]) => getCalendarLabelFromData(a).localeCompare(getCalendarLabelFromData(b)));
        const selectedIds = new Set(seed.calendarIds || []);
        const includeAll = seed.includeAllCalendars !== false;
        const selectedCanonicalIds = [...selectedIds];
        const icsEligibility = getIcsSelectionEligibility({ includeAll, calendarIds: selectedCanonicalIds });
        const selectionLocked = Boolean(editingShare?.icsConfigured);
        const editingCode = editingShare?.shareCode || "";
        const formValidationError = Boolean(state.shares.formValidationError);
        const modalTitle = editingShare ? "Edit Shared Link" : "Share Calendar";
        const modalSubtitle = editingShare
            ? `Updating settings for share link ${editingCode || "selected link"}.`
            : "Create reusable read-only links for selected calendars and dates.";
        const editingBanner = editingShare ? `
            <div class="calendar-share-editing-banner" role="status">
                <span class="material-symbols-outlined calendar-share-editing-icon" aria-hidden="true">edit</span>
                <span>
                    <strong>Editing shared link</strong>
                    <span>${escapeHtml(editingCode || "Selected link")} · ${escapeHtml(editingShare.scopeLabel || "All shared dates")}</span>
                </span>
            </div>
        ` : "";
        const calendarChoices = shareableCalendars.length
            ? shareableCalendars.map(([calendarName, data]) => `
                <label class="calendar-share-calendar-choice">
                    <input type="checkbox" name="calendar_ids" value="${escapeHtml(calendarName)}" ${includeAll || selectedIds.has(calendarName) || selectedIds.has(canonicalIcsCalendarId(calendarName)) ? "checked" : ""} ${includeAll || selectionLocked ? "disabled" : ""} ${formValidationError ? 'aria-describedby="calendar-share-form-error" aria-invalid="true"' : ""}>
                    <span class="calendar-share-calendar-dot" style="background:${data.color};"></span>
                    <span>${escapeHtml(getCalendarLabel(calendarName))}</span>
                </label>
            `).join("")
            : '<p class="calendar-info-note">Load or add a calendar before limiting by calendar.</p>';
        const sharesList = state.shares.loading
            ? `<div class="calendar-share-empty" role="status" aria-live="polite" aria-atomic="true">${view.APStudyLoader.html("Loading share links...", { sizePx: 30, textToneClass: "text-on-surface" })}</div>`
            : state.shares.items.length
                ? state.shares.items.map((share) => buildCalendarShareRowHtml(share, editingShare?.id)).join("")
                : '<div class="calendar-share-empty">No share links yet.</div>';
        modal.innerHTML = `
            <div class="calendar-info-dialog calendar-share-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-share-title" tabindex="-1">
                <div class="calendar-info-header">
                    <div class="calendar-info-heading">
                        <h3 id="calendar-share-title" class="calendar-info-title">${escapeHtml(modalTitle)}</h3>
                        <p class="calendar-info-subtitle">${escapeHtml(modalSubtitle)}</p>
                    </div>
                    <button type="button" class="js-share-close calendar-info-close" aria-label="Close calendar sharing">
                        <span class="material-symbols-outlined calendar-info-close-icon" aria-hidden="true">close</span>
                    </button>
                </div>
                ${renderShareForm({ editingShare, seed, formValidationError, editingBanner, includeAll, selectionLocked, calendarChoices, icsEligibility, sharesList })}
            </div>
        `;
        syncCalendarShareModalFields();
        restoreFocus();
    }

    function syncCalendarShareModalFields() {
        const modal = state.ui.shareModalEl;
        if (!modal) return;
        const form = modal.querySelector("#calendar-share-form");
        if (!form) return;
        const includeAll = form.include_scope?.value !== "selected";
        form.querySelectorAll("input[name='calendar_ids']").forEach((input) => {
            const editingShare = state.shares.items.find((share) => share.id === state.shares.editingId);
            input.disabled = includeAll || Boolean(editingShare?.icsConfigured);
            if (includeAll) input.checked = true;
        });
        const editingShare = state.shares.items.find((share) => share.id === state.shares.editingId);
        if (form.include_scope) form.include_scope.disabled = Boolean(editingShare?.icsConfigured);
        const calendarGrid = modal.querySelector(".calendar-share-calendar-grid");
        if (calendarGrid) {
            calendarGrid.classList.toggle("is-disabled", includeAll);
            calendarGrid.setAttribute("aria-disabled", includeAll || Boolean(editingShare?.icsConfigured) ? "true" : "false");
        }
        const scope = form.date_scope?.value || "all";
        const fixedFields = modal.querySelector(".calendar-share-fixed-fields");
        const rollingField = modal.querySelector(".calendar-share-rolling-field");
        if (fixedFields) fixedFields.hidden = scope !== "fixed";
        if (rollingField) rollingField.hidden = scope !== "rolling";
        const icsOption = modal.querySelector("[data-ics-create-option]");
        const icsNote = modal.querySelector("[data-ics-selection-note]");
        const simulatedNote = modal.querySelector("[data-ics-simulated-note]");
        if (icsOption || icsNote) {
            const eligibility = getIcsSelectionEligibility({
                includeAll,
                calendarIds: selectedCalendarIdsFromForm(form),
            });
            if (icsOption) icsOption.hidden = !eligibility.eligible;
            if (icsNote) icsNote.hidden = eligibility.eligible;
            if (simulatedNote) simulatedNote.hidden = eligibility.calendarId !== "simulated_courses";
        }
    }

    return { renderCalendarShareModal, syncCalendarShareModalFields };
}
