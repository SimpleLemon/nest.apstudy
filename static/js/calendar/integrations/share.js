import { createCalendarShareRenderer } from "./share-render.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
import { createCalendarDataAdapter } from "../adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";
export function createCalendarShare({
    root = document,
    lifecycle = null,
    dataAdapter = null,
    runtimeWindow = null,
    overlayRoot = null,
    state,
    constants,
    escapeHtml,
    getCalendarLabel,
    getCalendarLabelFromData,
    trackCalendarMutation,
}) {
    const { calendarShareCloseMs, simulatedCalendarName } = constants;
    const doc = root.ownerDocument || root;
    const view = runtimeWindow || doc.defaultView || globalThis.window || globalThis;
    const adapter = createCalendarDataAdapter(dataAdapter || {}, { window: view });
    const mountNode = overlayRoot || (root.nodeType === 9 ? (root.body || root.documentElement) : root);
    const icsState = new Map();
    const icsEligibleIds = new Set(["canvas", "tasks", "simulated_courses"]);
    let activeModalSession = null;
    let shareDataLoadPromise = null;

    function canonicalIcsCalendarId(value) {
        const candidate = String(value || "").trim();
        const aliases = {
            Canvas: "canvas",
            canvas: "canvas",
            Tasks: "tasks",
            tasks: "tasks",
            "local:tasks": "tasks",
            "Simulated Courses": "simulated_courses",
            "simulated courses": "simulated_courses",
            simulated_courses: "simulated_courses",
        };
        return aliases[candidate] || null;
    }

    function selectedCalendarIdsFromForm(form) {
        if (!form || form.include_scope?.value !== "selected") return [];
        return Array.from(form.querySelectorAll("input[name='calendar_ids']:checked"))
            .map((input) => input.value);
    }

    function getIcsSelectionEligibility({ includeAll = true, calendarIds = [] } = {}) {
        const canonicalIds = calendarIds.map(canonicalIcsCalendarId);
        const ids = [...new Set(canonicalIds.filter(Boolean))];
        const hasIneligibleCalendar = canonicalIds.some((id) => !id);
        return {
            eligible: !includeAll && !hasIneligibleCalendar && ids.length === 1 && icsEligibleIds.has(ids[0]),
            calendarId: !includeAll && ids.length === 1 ? ids[0] : null,
        };
    }

    function canCreateCalendarSubscription(calendarName) {
        return getIcsSelectionEligibility({
            includeAll: false,
            calendarIds: [calendarName],
        }).eligible;
    }

    function findActiveConfiguredIcsShare(calendarId) {
        return state.shares.items.find((share) => Boolean(
            share.isActive
            && share.icsConfigured
            && getIcsSelectionEligibility({
                includeAll: share.includeAllCalendars !== false,
                calendarIds: share.calendarIds || [],
            }).calendarId === calendarId,
        )) || null;
    }

    function applyCalendarSubscriptionIntent(calendarName, { matchExisting = true } = {}) {
        const eligibility = getIcsSelectionEligibility({ includeAll: false, calendarIds: [calendarName] });
        if (!eligibility.eligible) return null;
        const existing = matchExisting ? findActiveConfiguredIcsShare(eligibility.calendarId) : null;
        if (existing) {
            state.shares.editingId = existing.id;
            state.shares.draft = null;
            state.shares.notice = "This calendar already has an ICS subscription. Manage or re-enable it below.";
            return existing;
        }
        state.shares.editingId = null;
        state.shares.draft = {
            includeAllCalendars: false,
            calendarIds: [calendarName],
            dateScope: "all",
            fixedStart: "",
            fixedEnd: "",
            rollingDays: 30,
            icsEnabled: true,
        };
        state.shares.notice = "Review the single-calendar subscription, then create the link. Nothing has been changed yet.";
        return null;
    }

    function isCurrentModalSession(session) {
        return Boolean(
            session
            && activeModalSession === session
            && state.ui.shareModalEl === session.modal
            && !lifecycle?.isDisposed?.(),
        );
    }

    function getIcsState(shareId) {
        if (!icsState.has(shareId)) {
            icsState.set(shareId, { loading: false, saving: false, action: "", detail: null, expanded: false, error: "", notice: "" });
        }
        return icsState.get(shareId);
    }

    function setFocusTarget(selector) {
        state.shares.focusTarget = selector;
    }

    function focusSelectorFor(element) {
        if (!element || !element.matches?.("button, input, select, textarea, [tabindex]")) return "";
        const escape = view.CSS?.escape || ((value) => String(value).replace(/([\\"'()[\].:#,>+~*=])/g, "\\$1"));
        const shareId = element.getAttribute("data-share-id");
        if (shareId && element.hasAttribute("data-ics-action")) {
            return `.js-share-ics-action[data-share-id="${escape(shareId)}"][data-ics-action="${escape(element.getAttribute("data-ics-action"))}"]`;
        }
        if (shareId && element.hasAttribute("data-ics-url")) {
            return `.js-share-ics-copy[data-share-id="${escape(shareId)}"][data-ics-url="${escape(element.getAttribute("data-ics-url"))}"]`;
        }
        if (element.id) return `#${escape(element.id)}`;
        if (element.name) return `${element.tagName.toLowerCase()}[name="${escape(element.name)}"]${element.value ? `[value="${escape(element.value)}"]` : ""}`;
        if (element.classList?.contains("js-share-close")) return ".js-share-close";
        return ".calendar-share-dialog";
    }

    function rememberFocusedControl() {
        const modal = state.ui.shareModalEl;
        const active = doc.activeElement;
        if (modal && active && modal.contains?.(active)) {
            const selector = focusSelectorFor(active);
            if (selector) state.shares.focusTarget = selector;
        }
    }

    function restoreFocus() {
        const selector = state.shares.focusTarget;
        if (!selector) return;
        state.shares.focusTarget = "";
        const restore = () => modalFocus(selector);
        if (lifecycle?.requestAnimationFrame) lifecycle.requestAnimationFrame(restore);
        else if (view.requestAnimationFrame) view.requestAnimationFrame(restore);
        else restore();
    }

    function modalFocus(selector) {
        const modal = state.ui.shareModalEl;
        const target = modal?.querySelector(selector) || modal?.querySelector(".js-share-close") || modal?.querySelector(".calendar-share-dialog");
        target?.focus?.({ preventScroll: true });
    }

    function formatRequestError(res, payload, fallback) {
        const code = String(payload?.code || "");
        const status = Number(res?.status || 0);
        if (code === "calendar_ics_disabled" || status === 403) {
            return "ICS subscriptions are not enabled for this account yet. Ask an administrator to enable access, then try again.";
        }
        if (status === 404 || code === "calendar_ics_not_found") {
            return "This share is no longer available. Refresh the share list and try again.";
        }
        if (status === 409 || code === "calendar_ics_selection_locked" || code === "calendar_ics_parent_revoked") {
            return "This share changed or was revoked. Refresh the share list before trying again.";
        }
        if (status === 422) {
            return payload?.error || "This calendar selection cannot be used for an ICS subscription. Choose one Nest calendar.";
        }
        if (status === 429) {
            return "Too many subscription requests were made. Wait a moment, then try again.";
        }
        if (status >= 500) {
            return "Nest could not prepare this subscription right now. Try again later; your browser share was not changed.";
        }
        return payload?.error || fallback;
    }

    async function requestJson(operation, fallback = "Unable to update calendar sharing.") {
        try {
            const { response: res, payload, ok } = await requestShare(operation);
            if (!ok) throw new Error(formatRequestError(res, payload, fallback));
            return { res, payload };
        } catch (error) {
            if (error?.message && !/Failed to fetch|NetworkError|Load failed/i.test(error.message)) throw error;
            throw new Error("Could not reach Nest. Check your connection and try again; your share settings were kept.", { cause: error });
        }
    }

    function requestController() {
        return lifecycle?.trackAbortController?.() || new (view.AbortController || globalThis.AbortController)();
    }

    async function requestShare(operation) {
        const controller = requestController();
        try {
            return await adapter.saveShare({ ...operation, signal: controller.signal });
        } finally {
            lifecycle?.releaseAbortController?.(controller);
        }
    }

    function closeCalendarShareModal(immediate = false) {
        activeModalSession = null;
        if (state.ui.shareModalEl) {
            const modal = state.ui.shareModalEl;
            if (immediate) {
                modal.remove();
            } else {
                modal.classList.add("is-closing");
                const schedule = lifecycle?.setTimeout || view.setTimeout.bind(view);
                schedule(() => {
                    modal.remove();
                }, calendarShareCloseMs);
            }
            state.ui.shareModalEl = null;
        }
        state.shares.editingId = null;
        state.shares.error = "";
        state.shares.formValidationError = false;
        state.shares.loading = false;
        state.shares.notice = "";
        state.shares.focusTarget = "";
    }

    function ensureCalendarShareDataLoaded() {
        if (state.shares.loaded) return Promise.resolve(state.shares.items);
        if (shareDataLoadPromise) return shareDataLoadPromise;
        const controller = requestController();
        let request;
        request = (async () => {
            try {
                const { ok, payload } = await adapter.loadShares({ signal: controller.signal });
                if (lifecycle?.isDisposed?.()) return state.shares.items;
                if (!ok) throw new Error(payload.error || "Unable to load share links.");
                state.shares.items = Array.isArray(payload.shares) ? payload.shares : [];
                state.shares.loaded = true;
                return state.shares.items;
            } finally {
                lifecycle?.releaseAbortController?.(controller);
                if (shareDataLoadPromise === request) shareDataLoadPromise = null;
            }
        })();
        shareDataLoadPromise = request;
        return request;
    }

    async function hydrateCalendarShareModal(session) {
        try {
            await ensureCalendarShareDataLoaded();
        } catch (err) {
            if (!isCurrentModalSession(session)) return;
            state.shares.loading = false;
            state.shares.error = err.message || "Could not reach Nest. Check your connection and try again.";
            renderCalendarShareModal();
            return;
        }
        if (!isCurrentModalSession(session)) return;
        state.shares.loading = false;
        state.shares.error = "";
        if (session.subscriptionCalendar) {
            applyCalendarSubscriptionIntent(session.subscriptionCalendar);
        }
        renderCalendarShareModal();
    }

    function openCalendarShareModal({ subscriptionCalendar = "" } = {}) {
        if (state.public.readOnly) return;
        closeCalendarShareModal(true);
        const session = { modal: null, subscriptionCalendar };
        activeModalSession = session;
        state.shares.editingId = null;
        state.shares.draft = null;
        state.shares.error = "";
        state.shares.loading = !state.shares.loaded;
        state.shares.notice = "";
        if (subscriptionCalendar) {
            applyCalendarSubscriptionIntent(subscriptionCalendar, { matchExisting: state.shares.loaded });
        }
        const modal = doc.createElement("div");
        modal.className = "calendar-info-modal calendar-share-modal";
        const listen = lifecycle?.addEventListener
            ? lifecycle.addEventListener.bind(lifecycle)
            : (target, type, handler) => target.addEventListener(type, handler);
        listen(modal, "click", onCalendarShareModalClick);
        listen(modal, "change", onCalendarShareModalChange);
        listen(modal, "submit", onCalendarShareModalSubmit);
        mountNode.appendChild(modal);
        lifecycle?.trackNode?.(modal);
        state.ui.shareModalEl = modal;
        session.modal = modal;
        renderCalendarShareModal();
        modalFocus(".js-share-close");
        void hydrateCalendarShareModal(session);
    }

    function openCalendarSubscriptionModal(calendarName) {
        if (!canCreateCalendarSubscription(calendarName)) return;
        openCalendarShareModal({ subscriptionCalendar: calendarName });
    }

    const { renderCalendarShareModal, syncCalendarShareModalFields } = createCalendarShareRenderer({
        state, view, simulatedCalendarName, escapeHtml, getCalendarLabel,
        getCalendarLabelFromData, getIcsSelectionEligibility, getIcsState,
        canonicalIcsCalendarId, selectedCalendarIdsFromForm, rememberFocusedControl, restoreFocus,
    });

    function calendarShareFormPayload(form) {
        const includeAll = form.include_scope?.value !== "selected";
        return {
            includeAllCalendars: includeAll,
            calendarIds: includeAll
                ? []
                : Array.from(form.querySelectorAll("input[name='calendar_ids']:checked")).map((input) => input.value),
            dateScope: form.date_scope?.value || "all",
            fixedStart: form.fixed_start?.value || null,
            fixedEnd: form.fixed_end?.value || null,
            rollingDays: form.rolling_days?.value ? Number(form.rolling_days.value) : null,
            icsEnabled: Boolean(form.ics_enabled?.checked && getIcsSelectionEligibility({
                includeAll,
                calendarIds: selectedCalendarIdsFromForm(form),
            }).eligible),
        };
    }

    async function saveCalendarSharePayload(payload) {
        state.shares.saving = true;
        state.shares.error = "";
        state.shares.notice = "";
        state.shares.formValidationError = false;
        state.shares.draft = payload;
        const editingId = state.shares.editingId;
        renderCalendarShareModal();
        let validationError = false;
        try {
            const result = await trackCalendarMutation(requestShare({ shareId: editingId || undefined, action: "save", payload }));
            const { response: res, payload: response, ok } = result;
            if (!ok) {
                validationError = res.status === 400 || res.status === 422;
                throw new Error(formatRequestError(res, response, "Unable to save share link. Check the calendar selection and date range, then try again."));
            }
            const share = response.share;
            replaceShareItem(share);
            state.shares.editingId = null;
            state.shares.draft = null;
            state.shares.notice = editingId ? "Share link updated." : "Share link created.";
        } catch (err) {
            state.shares.error = err.message || "Unable to save share link.";
            state.shares.formValidationError = validationError;
        } finally {
            state.shares.saving = false;
            renderCalendarShareModal();
        }
    }

    async function updateCalendarShare(shareId, action, options = {}) {
        state.shares.error = "";
        state.shares.notice = "";
        state.shares.formValidationError = false;
        renderCalendarShareModal();
        try {
            const result = await trackCalendarMutation(requestShare({ shareId, action, payload: options.payload }));
            const { response: res, payload: response, ok } = result;
            if (!ok) throw new Error(formatRequestError(res, response, "Unable to update share link. Check the calendar selection and date range, then try again."));
            const share = response.share;
            replaceShareItem(share);
            state.shares.notice = options.notice || "Share link updated.";
            return share || true;
        } catch (err) {
            state.shares.error = err.message || "Unable to update share link.";
            return null;
        } finally {
            renderCalendarShareModal();
        }
    }

    function replaceShareItem(share) {
        if (!share?.id) return;
        const index = state.shares.items.findIndex((item) => item.id === share.id);
        if (index >= 0) state.shares.items.splice(index, 1, share);
        else state.shares.items.unshift(share);
    }

    async function toggleCalendarIcsDetail(shareId, forceOpen = false) {
        const share = state.shares.items.find((item) => item.id === shareId);
        if (!share || !share.icsConfigured) return false;
        const ics = getIcsState(shareId);
        if (ics.loading) return false;
        if (ics.expanded && !forceOpen) {
            ics.expanded = false;
            renderCalendarShareModal();
            return true;
        }
        ics.loading = true;
        ics.error = "";
        ics.notice = "";
        renderCalendarShareModal();
        try {
            const { payload } = await requestJson(
                { shareId, action: "ics-detail" },
                "Unable to load the ICS subscription details.",
            );
            ics.detail = payload.ics || null;
            ics.expanded = true;
            return true;
        } catch (error) {
            ics.error = error.message || "Unable to load the ICS subscription details.";
            ics.expanded = true;
            return false;
        } finally {
            ics.loading = false;
            renderCalendarShareModal();
        }
    }

    function confirmIcsAction(action) {
        if (action === "rotate") {
            return view.confirm
                ? view.confirm("Rotate this ICS URL? The old subscription URL will stop working and must be replaced in every calendar app. Your browser share will not change.")
                : true;
        }
        if (action === "remove") {
            return view.confirm
                ? view.confirm("Remove this ICS subscription? Its credential will be permanently cleared and calendar selection will unlock. Your browser share will not change.")
                : true;
        }
        return true;
    }

    async function runCalendarIcsAction(shareId, action) {
        const share = state.shares.items.find((item) => item.id === shareId);
        const ics = getIcsState(shareId);
        if (!share || ics.saving || ics.loading || !confirmIcsAction(action)) return;
        if (action === "enable" && !getIcsSelectionEligibility({
            includeAll: share.includeAllCalendars !== false,
            calendarIds: share.calendarIds || [],
        }).eligible) {
            ics.error = "An ICS subscription requires exactly one eligible Nest calendar. Create a new single-calendar share first.";
            ics.expanded = true;
            renderCalendarShareModal();
            return;
        }
        ics.saving = true;
        ics.action = action;
        ics.error = "";
        ics.notice = "";
        setFocusTarget(`.js-share-ics-action[data-share-id="${shareId}"][data-ics-action="${action}"]`);
        if (action === "rotate") ics.detail = null;
        renderCalendarShareModal();
        try {
            const { payload } = await requestJson({ shareId, action: `ics-${action}` }, "Unable to update the ICS subscription.");
            if (payload.share) replaceShareItem(payload.share);
            if (action === "rotate") {
                // Do not render or leave the old secret copyable while the new detail is fetched.
                ics.detail = null;
            }
            ics.notice = action === "enable"
                ? "ICS subscription enabled. Your browser share was not changed."
                : action === "disable"
                    ? "ICS subscription suspended. The URL is retained for re-enabling."
                    : action === "rotate"
                        ? "ICS URL rotated. The previous URL is no longer valid."
                        : "ICS subscription removed. Calendar selection is unlocked; your browser share was not changed.";
            if (action === "remove") {
                ics.detail = null;
                ics.expanded = false;
            } else {
                ics.expanded = true;
            }
        } catch (error) {
            ics.error = error.message || "Unable to update the ICS subscription.";
            ics.expanded = true;
        } finally {
            ics.saving = false;
            ics.action = "";
            renderCalendarShareModal();
        }
        if (action === "enable" || action === "rotate") {
            await toggleCalendarIcsDetail(shareId, true);
        }
    }

    async function copyTextToClipboard(value) {
        if (!value) return false;
        if (view.navigator?.clipboard?.writeText) {
            await view.navigator.clipboard.writeText(value);
            return true;
        }
        const textarea = doc.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        root.appendChild(textarea);
        textarea.select();
        const ok = doc.execCommand("copy");
        textarea.remove();
        return ok;
    }

    function onCalendarShareModalChange(event) {
        if (["include_scope", "date_scope", "calendar_ids", "ics_enabled"].includes(event.target?.name)) {
            syncCalendarShareModalFields();
        }
    }

    async function onCalendarShareModalSubmit(event) {
        if (event.target?.id !== "calendar-share-form") return;
        event.preventDefault();
        if (state.shares.saving) return;
        await saveCalendarSharePayload(calendarShareFormPayload(event.target));
    }

    async function copyCalendarIcsUrl(button) {
        const shareId = button.getAttribute("data-share-id");
        const ics = getIcsState(shareId);
        const url = ics.detail?.[button.getAttribute("data-ics-url") === "webcal" ? "webcalUrl" : "httpsUrl"];
        if (!url || ics.saving) return;
        try {
            if (!await copyTextToClipboard(url)) throw new Error("Clipboard unavailable");
            ics.notice = `${button.getAttribute("data-ics-url") === "webcal" ? "webcal" : "HTTPS"} URL copied.`;
            ics.error = "";
        } catch {
            state.shares.formValidationError = false;
            ics.error = "Could not copy the URL. Select it manually, then copy it from this owner-only view.";
        }
        setFocusTarget(`.js-share-ics-copy[data-share-id="${shareId}"][data-ics-url="${button.getAttribute("data-ics-url")}"]`);
        renderCalendarShareModal();
    }

    async function copyCalendarShareUrl(button) {
        const share = state.shares.items.find((item) => item.id === button.getAttribute("data-share-id"));
        if (!share?.shareUrl) return;
        state.shares.formValidationError = false;
        try {
            if (!await copyTextToClipboard(share.shareUrl)) throw new Error("Clipboard unavailable");
            state.shares.notice = "Share link copied.";
            state.shares.error = "";
        } catch {
            state.shares.error = "Could not copy the share link. Select the link field manually, then copy it.";
            state.shares.notice = "";
        }
        setFocusTarget(`.js-share-copy[data-share-id="${share.id}"]`);
        renderCalendarShareModal();
    }

    async function revokeCalendarShare(shareId) {
        const share = state.shares.items.find((item) => item.id === shareId);
        const revoked = await updateCalendarShare(shareId, "revoke", { notice: "Share link revoked." });
        if (revoked) {
            view.APStudyToast?.show?.({
                message: "Share link revoked.",
                type: "info",
                duration: 10_000,
                action: {
                    label: "Undo",
                    onClick: async () => {
                        const restored = await updateCalendarShare(shareId, "save", {
                            payload: { ...share, isActive: true },
                            notice: "Share link restored.",
                        });
                        if (restored) {
                            view.APStudyToast?.success?.("Share link restored.");
                            return false;
                        }
                        return true;
                    },
                },
            });
        }
    }

    async function onCalendarShareModalClick(event) {
        if (event.target === state.ui.shareModalEl || event.target.closest(".js-share-close")) {
            closeCalendarShareModal();
            return;
        }
        const newBtn = event.target.closest(".js-share-new");
        if (newBtn) {
            state.shares.editingId = null;
            state.shares.draft = null;
            state.shares.error = "";
            state.shares.notice = "";
            renderCalendarShareModal();
            return;
        }
        const newSingleBtn = event.target.closest(".js-share-new-single");
        if (newSingleBtn) {
            state.shares.editingId = null;
            state.shares.draft = {
                includeAllCalendars: false,
                calendarIds: [],
                dateScope: "all",
                fixedStart: "",
                fixedEnd: "",
                rollingDays: 30,
                icsEnabled: false,
            };
            state.shares.error = "";
            state.shares.notice = "Choose one Nest calendar below to create an ICS-ready share. Nothing was changed on the existing share.";
            setFocusTarget("input[name='include_scope'][value='selected']");
            renderCalendarShareModal();
            return;
        }
        const icsDetailsBtn = event.target.closest(".js-share-ics-details");
        if (icsDetailsBtn) {
            await toggleCalendarIcsDetail(icsDetailsBtn.getAttribute("data-share-id"));
            return;
        }
        const icsActionBtn = event.target.closest(".js-share-ics-action");
        if (icsActionBtn) {
            await runCalendarIcsAction(
                icsActionBtn.getAttribute("data-share-id"),
                icsActionBtn.getAttribute("data-ics-action"),
            );
            return;
        }
        const icsCopyBtn = event.target.closest(".js-share-ics-copy");
        if (icsCopyBtn) {
            await copyCalendarIcsUrl(icsCopyBtn);
            return;
        }
        const copyBtn = event.target.closest(".js-share-copy");
        if (copyBtn) {
            await copyCalendarShareUrl(copyBtn);
            return;
        }
        const editBtn = event.target.closest(".js-share-edit");
        if (editBtn) {
            state.shares.editingId = editBtn.getAttribute("data-share-id");
            state.shares.error = "";
            state.shares.notice = "";
            renderCalendarShareModal();
            return;
        }
        const regenerateBtn = event.target.closest(".js-share-regenerate");
        if (regenerateBtn) {
            const shareId = regenerateBtn.getAttribute("data-share-id");
            await updateCalendarShare(shareId, "regenerate", { notice: "Share link regenerated." });
            return;
        }
        const revokeBtn = event.target.closest(".js-share-revoke");
        if (revokeBtn) {
            await revokeCalendarShare(revokeBtn.getAttribute("data-share-id"));
            return;
        }
        const activateBtn = event.target.closest(".js-share-activate");
        if (activateBtn) {
            const shareId = activateBtn.getAttribute("data-share-id");
            const share = state.shares.items.find((item) => item.id === shareId);
            await updateCalendarShare(shareId, "save", {
                payload: { ...share, isActive: true },
                notice: "Share link reactivated.",
            });
        }
    }

    return {
        canCreateCalendarSubscription,
        closeCalendarShareModal,
        openCalendarShareModal,
        openCalendarSubscriptionModal,
        renderCalendarShareModal,
    };
}
