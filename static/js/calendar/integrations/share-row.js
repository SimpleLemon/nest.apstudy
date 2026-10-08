export function createCalendarShareRowRenderer({ escapeHtml, getIcsSelectionEligibility, getIcsState, canonicalIcsCalendarId }) {
    function renderSubscriptionUrls(share, detail, icsActionBusy) {
        if (!detail?.configured) return "";
        return `
            <div class="calendar-share-ics-urls" aria-label="ICS subscription URLs">
                <div class="calendar-share-ics-url-row">
                    <div class="calendar-share-ics-url-copy">
                        <span class="calendar-share-ics-url-label">HTTPS URL</span>
                        <code class="calendar-share-ics-url-value" title="${escapeHtml(detail.httpsUrl || "")}">${escapeHtml(detail.httpsUrl || "")}</code>
                    </div>
                    <button type="button" class="js-share-ics-copy calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" data-ics-url="https" ${icsActionBusy ? "disabled" : ""}>Copy HTTPS URL</button>
                </div>
                <div class="calendar-share-ics-url-row">
                    <div class="calendar-share-ics-url-copy">
                        <span class="calendar-share-ics-url-label">webcal URL</span>
                        <code class="calendar-share-ics-url-value" title="${escapeHtml(detail.webcalUrl || "")}">${escapeHtml(detail.webcalUrl || "")}</code>
                    </div>
                    <button type="button" class="js-share-ics-copy calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" data-ics-url="webcal" ${icsActionBusy ? "disabled" : ""}>Copy webcal URL</button>
                </div>
            </div>
        `;
    }

    function renderSubscriptionDetail(share, ics, detail, icsActionBusy) {
        if (!ics.expanded) return "";
        return `<div class="calendar-share-ics-detail" ${detail?.configured ? "" : "hidden"}>
                    <p class="calendar-share-ics-window">Exports the previous <strong>30 days</strong> through the next <strong>366 days</strong>, with UTC date boundaries. Changes may take time to appear because Apple, Google, and Outlook control refresh timing.</p>
                    ${share.icsConfigured && !share.icsEnabled ? '<p class="calendar-share-ics-warning" role="note">This subscription is suspended. The retained URL will not work until you re-enable the subscription.</p>' : ""}
                    ${renderSubscriptionUrls(share, detail, icsActionBusy)}
                    ${share.calendarIds?.some((id) => canonicalIcsCalendarId(id) === "simulated_courses") ? '<p class="calendar-share-ics-window">Simulated Courses exports only your saved server selections.</p>' : ""}
                    <div class="calendar-share-ics-actions">
                        <button type="button" class="js-share-ics-action calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" data-ics-action="${share.icsEnabled ? "disable" : "enable"}" ${icsActionBusy ? "disabled" : ""}>${ics.saving ? "Working…" : share.icsEnabled ? "Disable subscription" : "Re-enable subscription"}</button>
                        <button type="button" class="js-share-ics-action calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" data-ics-action="rotate" ${icsActionBusy ? "disabled" : ""}>Rotate URL</button>
                        <button type="button" class="js-share-ics-action calendar-info-button calendar-info-button-danger" data-share-id="${escapeHtml(share.id)}" data-ics-action="remove" ${icsActionBusy ? "disabled" : ""}>Remove subscription</button>
                    </div>
                    <p class="calendar-share-ics-warning">Rotate invalidates the old URL. Remove permanently clears the credential and unlocks calendar selection. Neither changes this browser share.</p>
                </div>`;
    }

    function buildCalendarShareRowHtml(share, editingId = null) {
        const inactive = !share.isActive;
        const isEditing = share.id === editingId;
        const statusLabel = isEditing ? "Editing now" : inactive ? "Revoked link" : "Active link";
        const selectionIds = share.calendarIds || [];
        const icsEligibility = getIcsSelectionEligibility({
            includeAll: share.includeAllCalendars !== false,
            calendarIds: selectionIds,
        });
        const ics = getIcsState(share.id);
        const icsStatus = !share.icsConfigured
            ? "Not configured"
            : share.icsEnabled ? "Enabled" : "Suspended";
        const icsActionBusy = ics.loading || ics.saving;
        const detail = ics.detail;
        const icsError = ics.error ? `<p class="calendar-share-ics-error" role="alert" aria-live="assertive" aria-atomic="true">${escapeHtml(ics.error)}</p>` : "";
        const icsNotice = ics.notice ? `<p class="calendar-share-ics-notice" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(ics.notice)}</p>` : "";
        if (inactive) {
            return `
                <article class="calendar-share-row is-inactive ${isEditing ? "is-editing" : ""}">
                    <div class="calendar-share-row-main">
                        <div class="calendar-share-row-title"><span>${statusLabel}</span><span class="calendar-share-code">${escapeHtml(share.shareCode || "")}</span></div>
                        <div class="calendar-share-row-meta">${escapeHtml(share.scopeLabel || "All shared dates")}</div>
                        <input class="calendar-info-input calendar-share-url" readonly aria-label="Share link" value="${escapeHtml(share.shareUrl || "")}" />
                    </div>
                    <div class="calendar-share-actions">
                        <button type="button" class="js-share-copy calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" disabled>Copy</button>
                        <button type="button" class="js-share-edit calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${isEditing ? "disabled" : ""}>${isEditing ? "Editing" : "Edit"}</button>
                        <button type="button" class="js-share-regenerate calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Regenerate</button>
                        <button type="button" class="js-share-activate calendar-info-button calendar-info-button-primary" data-share-id="${escapeHtml(share.id)}">Reactivate</button>
                    </div>
                    <section class="calendar-share-ics" aria-label="ICS subscription">
                        <p class="calendar-share-ics-selection-note" role="note">ICS controls are unavailable while this browser share is revoked. Reactivate the share before managing its subscription.</p>
                    </section>
                </article>`;
        }
        const icsManagement = !icsEligibility.eligible
            ? `<p class="calendar-share-ics-selection-note">An ICS subscription requires a new share containing exactly one Nest calendar: Canvas, Tasks, or Simulated Courses.</p><button type="button" class="js-share-new-single calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Create new single-calendar share</button>`
            : `
                <div class="calendar-share-ics-summary">
                    <div class="calendar-share-ics-summary-copy">
                        <strong>ICS subscription · ${icsStatus}</strong>
                        <span>Separate from this browser share. Providers decide when they refresh.</span>
                    </div>
                    ${share.icsConfigured
                        ? `<button type="button" class="js-share-ics-details calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${icsActionBusy ? "disabled" : ""}>${ics.loading ? "Loading…" : ics.expanded ? "Hide details" : "Show details"}</button>`
                        : `<button type="button" class="js-share-ics-action calendar-info-button calendar-info-button-primary" data-share-id="${escapeHtml(share.id)}" data-ics-action="enable" ${icsActionBusy ? "disabled" : ""}>${ics.saving ? "Enabling…" : "Enable ICS subscription"}</button>`}
                </div>
                ${renderSubscriptionDetail(share, ics, detail, icsActionBusy)}
                ${icsError}${icsNotice}
            `;
        return `
            <article class="calendar-share-row ${inactive ? "is-inactive" : ""} ${isEditing ? "is-editing" : ""}">
                <div class="calendar-share-row-main">
                    <div class="calendar-share-row-title">
                        <span>${statusLabel}</span>
                        <span class="calendar-share-code">${escapeHtml(share.shareCode || "")}</span>
                    </div>
                    <div class="calendar-share-row-meta">${escapeHtml(share.scopeLabel || "All shared dates")}</div>
                    <input class="calendar-info-input calendar-share-url" readonly aria-label="Share link" value="${escapeHtml(share.shareUrl || "")}">
                </div>
                <div class="calendar-share-actions">
                    <button type="button" class="js-share-copy calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${inactive ? "disabled" : ""}>Copy</button>
                    <button type="button" class="js-share-edit calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}" ${isEditing ? "disabled" : ""}>${isEditing ? "Editing" : "Edit"}</button>
                    <button type="button" class="js-share-regenerate calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Regenerate</button>
                    ${inactive
                        ? `<button type="button" class="js-share-activate calendar-info-button calendar-info-button-primary" data-share-id="${escapeHtml(share.id)}">Reactivate</button>`
                        : `<button type="button" class="js-share-revoke calendar-info-button calendar-info-button-secondary" data-share-id="${escapeHtml(share.id)}">Revoke</button>`}
                </div>
                <section class="calendar-share-ics" aria-label="ICS subscription">
                    ${icsManagement}
                </section>
            </article>
        `;
    }

    return { buildCalendarShareRowHtml };
}
