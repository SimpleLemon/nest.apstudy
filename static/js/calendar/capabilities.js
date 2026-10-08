/**
 * @typedef {Object} CalendarActions
 * @property {boolean} routeDisplayOverride
 * @property {boolean} retryWriteback
 * @property {boolean} openSourceUrl
 */
/**
 * @typedef {Object} CalendarCanvasData
 * @property {{label?: string, accountLabel?: string, account_label?: string, sourceId?: string, source_id?: string, url?: string}} [source]
 * @property {{state?: string, sourceId?: string, source_id?: string, destinationCalendarId?: string, destination_calendar_id?: string, destination?: string, fallbackCalendarId?: string, fallback_calendar_id?: string, degraded?: boolean, displayOverride?: boolean}} [routing]
 * @property {{status?: string, source?: string}} [completion]
 * @property {Array<{state: string, error_message?: string, errorMessage?: string}>} [writebacks]
 */
/**
 * @typedef {Object} CalendarCapabilities
 * @property {1|null} contractVersion Unsupported versions disable actions.
 * @property {boolean} supported
 * @property {boolean} readOnly
 * @property {boolean} readOnlyValid Whether an explicit boolean was supplied.
 * @property {boolean} shareMode
 * @property {boolean} shareModeValid
 * @property {boolean} canMutateNative Whether the contract permits native mutations; mounts additionally require nativeEditable.
 * @property {Readonly<CalendarActions>} actions
 * @property {CalendarCanvasData} data Canonical fields; legacy Canvas aliases are accepted at normalization.
 */

export const CALENDAR_EXTENSION_CONTRACT_VERSION = 1;

export const CALENDAR_WRITEBACK_STATES = Object.freeze([
    "waiting_for_canvas_session",
    "queued",
    "applied",
    "unsupported",
    "forbidden",
    "conflict",
    "retryable_failed",
    "cancelled",
]);

const ACTION_NAMES = [
    "routeDisplayOverride",
    "retryWriteback",
    "openSourceUrl",
];

const WRITEBACK_LABELS = {
    waiting_for_canvas_session: "Waiting for Canvas session",
    queued: "Queued",
    applied: "Applied",
    unsupported: "Unsupported",
    forbidden: "Forbidden",
    conflict: "Conflict",
    retryable_failed: "Retryable failure",
    cancelled: "Cancelled",
};

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictBoolean(value) {
    return value === true;
}

function normalizeWritebacks(value) {
    return (Array.isArray(value) ? value : value == null ? [] : [value])
        .map((entry) => isRecord(entry)
            ? { ...entry, state: normalizeWritebackState(entry.state || entry.status || entry.mirror_state) }
            : { state: normalizeWritebackState(entry) });
}

export function normalizeWritebackState(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return CALENDAR_WRITEBACK_STATES.includes(normalized) ? normalized : "unsupported";
}

export function writebackStateLabel(value) {
    const state = normalizeWritebackState(value);
    return WRITEBACK_LABELS[state];
}

/** @param {Object} [input] @returns {Readonly<CalendarCapabilities>} */
export function normalizeCalendarCapabilities(input = {}) {
    const raw = isRecord(input) ? input : {};
    const requestedVersion = raw.contractVersion ?? raw.contract_version ?? CALENDAR_EXTENSION_CONTRACT_VERSION;
    const contractVersion = requestedVersion === CALENDAR_EXTENSION_CONTRACT_VERSION
        ? CALENDAR_EXTENSION_CONTRACT_VERSION
        : null;
    const rawActions = isRecord(raw.actions) ? raw.actions : {};
    const hasReadOnly = Object.prototype.hasOwnProperty.call(raw, "readOnly");
    const rawReadOnly = hasReadOnly ? raw.readOnly : raw.read_only;
    const readOnlyValid = typeof rawReadOnly === "boolean" && raw.readOnlyValid !== false;
    const readOnly = strictBoolean(rawReadOnly)
        || strictBoolean(raw.shareMode)
        || raw.mode === "share"
        || raw.mode === "read_only";
    const shareModeValid = (raw.shareMode === undefined || typeof raw.shareMode === "boolean")
        && raw.shareModeValid !== false;
    const shareMode = strictBoolean(raw.shareMode) || raw.mode === "share";
    const mutationActionsAllowed = Boolean(
        contractVersion
        && readOnlyValid
        && !readOnly
        && shareModeValid
        && !shareMode,
    );
    const actions = Object.fromEntries(ACTION_NAMES.map((name) => [
        name,
        Boolean(
            contractVersion
            && strictBoolean(rawActions[name])
            && (name === "openSourceUrl" || mutationActionsAllowed),
        ),
    ]));

    const suppliedData = isRecord(raw.data)
        ? raw.data
        : isRecord(raw.canvasState)
            ? raw.canvasState
            : isRecord(raw.canvas)
                ? raw.canvas
                : {};
    const suppliedWritebacks = suppliedData.writebacks ?? suppliedData.writebackStates ?? suppliedData.writeback_state;
    const hasWritebacks = ["writebacks", "writebackStates", "writeback_state"]
        .some((key) => Object.prototype.hasOwnProperty.call(suppliedData, key));
    const data = hasWritebacks
        ? { ...suppliedData, writebacks: normalizeWritebacks(suppliedWritebacks) }
        : { ...suppliedData };

    return Object.freeze({
        contractVersion,
        supported: contractVersion !== null,
        readOnly,
        readOnlyValid,
        shareMode,
        shareModeValid,
        canMutateNative: mutationActionsAllowed,
        actions: Object.freeze(actions),
        data,
    });
}

/** @param {unknown} value @returns {string|null} Credential-free HTTPS origin only. */
export function getSafeCanvasSourceUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        return null;
    }
    if (
        parsed.protocol !== "https:"
        || !parsed.hostname
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
        || !["", "/"].includes(parsed.pathname)
    ) return null;
    return parsed.origin;
}

/**
 * @param {CalendarCapabilities|Object} capabilities
 * @param {Array<Record<string, *>>} [events]
 * @returns {CalendarCapabilities & CalendarCanvasData & {firstEvent: Record<string, *>}}
 */
export function getCalendarCapabilityData(capabilities, events = []) {
    const normalized = normalizeCalendarCapabilities(capabilities);
    const data = normalized.data;
    const canvasEvents = Array.isArray(events)
        ? events.filter((event) => event?.source_type === "canvas" || event?.provider === "canvas")
        : [];
    const firstEvent = canvasEvents[0] || {};
    const source = isRecord(data.source)
        ? data.source
        : {
            label: firstEvent.source_label || firstEvent.account_label || "",
            accountLabel: firstEvent.account_label || firstEvent.source_label || "",
            sourceId: firstEvent.source_id || "",
            url: firstEvent.source_url || "",
        };
    const routing = isRecord(data.routing)
        ? data.routing
        : {
            degraded: firstEvent.routing_degraded === true,
            destination: firstEvent.calendar_id || "",
            displayOverride: firstEvent.has_override === true,
        };
    const completion = isRecord(data.completion)
        ? data.completion
        : {
            status: firstEvent.completion_status || "",
            source: firstEvent.completion_source || "",
        };
    const writebacks = data.writebacks || [];
    const eventWritebacks = canvasEvents
        .map((event) => event.writeback_state || event.writebackState || event.mirror_state || event.mirrorState)
        .filter(Boolean)
        .map((state) => ({ state: normalizeWritebackState(state) }));

    return {
        ...normalized,
        data,
        source,
        routing,
        completion,
        writebacks: writebacks.concat(eventWritebacks),
        firstEvent,
    };
}
