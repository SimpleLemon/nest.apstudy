import { getSafeCanvasSourceUrl } from "./capabilities.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

/**
 * @typedef {Object} CalendarResponseStatus
 * @property {boolean} ok
 * @property {number} status HTTP status; synthesized as 200/500 for payload-only range providers.
 */
/**
 * @template {Record<string, *>} [T=Record<string, *>]
 * @typedef {Object} CalendarHttpResult
 * @property {CalendarResponseStatus} response Common status metadata. Native Responses retain their additional fields; legacy range metadata has no headers or body methods.
 * @property {T} payload Decoded JSON; empty only for bodyless operations or invalid error bodies.
 * @property {boolean} ok Whether every HTTP request in this operation succeeded.
 * @property {CalendarResponseStatus} [termsResponse] Course term request status.
 * @property {CalendarResponseStatus} [sectionsResponse] Course section request status.
 */
/**
 * @typedef {Object} CalendarActionResult
 * @property {boolean} ok Whether the action was accepted (not confirmation of a new tab).
 * @property {string} state Requested, unsupported, or a provider writeback state.
 * @property {string} [reason]
 * @property {string} [url]
 */
/**
 * @typedef {Object} CalendarRequest
 * @property {AbortSignal} [signal]
 * @property {{start: Date, end: Date}} [range]
 * @property {boolean} [readOnly]
 * @property {string} [shareCode]
 * @property {string} [eventId]
 * @property {string} [eventRef]
 * @property {string} [revision] Selected external event's optimistic concurrency token.
 * @property {boolean} [keepalive]
 * @property {Record<string, *>} [payload]
 * @property {Record<string, *>} [body]
 * @property {string} [endpoint]
 * @property {string[]} [sectionIds]
 */
/**
 * @typedef {Object} CalendarDataAdapter
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadRange
 * @property {function(CalendarRequest & {eventRef: string}): Promise<CalendarHttpResult>} loadMirrors
 * @property {function(CalendarRequest & {payload: Record<string, *>}): Promise<CalendarHttpResult>} changeMirror
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadPreferences
 * @property {function(CalendarRequest & {payload: Record<string, *>}): Promise<CalendarHttpResult>} savePreferences
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} refresh
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadShares
 * @property {function(CalendarRequest & {shareId?: string, action: 'save'|'regenerate'|'revoke'|'ics-detail'|'ics-enable'|'ics-disable'|'ics-rotate'|'ics-remove', payload?: Record<string, *>}): Promise<CalendarHttpResult>} saveShare
 * @property {function(CalendarRequest & {payload: Record<string, *>}): Promise<CalendarHttpResult>} createEvent
 * @property {function(CalendarRequest & {eventId: string, payload: Record<string, *>}): Promise<CalendarHttpResult>} updateEvent
 * @property {function(CalendarRequest & {payload: Record<string, *>}): Promise<CalendarHttpResult>} overrideEvent
 * @property {function(CalendarRequest & {eventId: string}): Promise<CalendarHttpResult>} deleteEvent
 * @property {function(CalendarRequest & {eventRef: string}): Promise<CalendarHttpResult>} hideEvent
 * @property {function(CalendarRequest & {sourceId?: string, kind?: 'local'|'url', payload: Record<string, *>}): Promise<CalendarHttpResult>} saveSource
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadCourses Payload contains terms and sections; component responses preserve endpoint-specific errors.
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadCourseSectionsById
 * @property {function(CalendarRequest=): Promise<CalendarHttpResult>} loadSavedCourses
 * @property {function(CalendarRequest & {sourceId: string, state: string, destinationCalendarId?: string|null, fallbackCalendarId?: string|null}): Promise<CalendarHttpResult>} setCanvasRouting
 * @property {function(CalendarRequest & {eventRef: string, calendarId: string}): Promise<CalendarHttpResult>} setDisplayOverride
 * @property {function(Object=): Promise<CalendarActionResult>} retryWriteback
 * @property {function({url: string, signal?: AbortSignal}): Promise<CalendarActionResult>} openSafeSourceUrl
 * @property {{routeDisplayOverride: boolean, retryWriteback: boolean, openSourceUrl: boolean}} actionSupport
 */
/**
 * Supported injected providers may return synchronously or asynchronously.
 * Payload-only objects are accepted only for loadRange; response pairs only for loadCourses.
 * @typedef {Record<string, *> & {events: Array<Record<string, *>>, ok?: boolean}} CalendarLegacyRange
 * @typedef {{termsResponse: Response, sectionsResponse: Response, termsPayload?: Record<string, *>, sectionsPayload?: Record<string, *>, payload?: Record<string, *>, ok?: boolean}} CalendarLegacyCourses
 * @typedef {Response|CalendarHttpResult} CalendarHttpOverrideResult
 * @typedef {function(CalendarRequest=): (CalendarHttpOverrideResult|CalendarLegacyRange|Promise<CalendarHttpOverrideResult|CalendarLegacyRange>)} CalendarRangeOverride
 * @typedef {function(CalendarRequest=): (CalendarHttpOverrideResult|CalendarLegacyCourses|Promise<CalendarHttpOverrideResult|CalendarLegacyCourses>)} CalendarCoursesOverride
 * @typedef {function(Object=): (CalendarActionResult|Promise<CalendarActionResult>)} CalendarActionOverride
 * @typedef {function({url: string, signal?: AbortSignal}): (CalendarActionResult|Promise<CalendarActionResult>)} CalendarSourceUrlOverride
 * @typedef {Exclude<keyof CalendarDataAdapter, 'loadRange'|'loadCourses'|'retryWriteback'|'openSafeSourceUrl'|'actionSupport'>} CalendarHttpOverrideMethod
 * @typedef {{[K in CalendarHttpOverrideMethod]?: (...args: Parameters<CalendarDataAdapter[K]>) => (CalendarHttpOverrideResult|Promise<CalendarHttpOverrideResult>)} & {loadRange?: CalendarRangeOverride, loadCourses?: CalendarCoursesOverride, retryWriteback?: CalendarActionOverride, openSafeSourceUrl?: CalendarSourceUrlOverride, actionSupport?: Partial<import("./capabilities.js").CalendarActions>, window?: Window, fetch?: typeof fetch}} CalendarAdapterOverrides
 */

async function responseResult(response, optionalBody = false) {
    let payload;
    try {
        payload = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a JSON object");
    } catch (error) {
        if (response.ok && !optionalBody) throw new Error("Calendar response contained invalid JSON", { cause: error });
        payload = {};
    }
    return { response, payload, ok: response.ok };
}

const canonicalAdapters = new WeakSet();
const BODYLESS_METHODS = new Set(["refresh", "deleteEvent", "hideEvent"]);
const ACTION_METHODS = new Set(["retryWriteback", "openSafeSourceUrl"]);

async function normalizeAdapterResult(method, result) {
    // Older range providers returned their decoded object directly. This is the
    // only payload-only host result supported; consumers always receive an envelope.
    if (method === "loadRange" && result && typeof result === "object"
        && !result.response && typeof result.json !== "function" && Array.isArray(result.events)) {
        return { response: { ok: result.ok !== false, status: result.ok === false ? 500 : 200 }, payload: result, ok: result.ok !== false };
    }
    // Preserve the former two-request courses API at this boundary only.
    if (method === "loadCourses" && result?.termsResponse && result?.sectionsResponse) {
        const terms = result.termsPayload ?? result.payload
            ?? (await responseResult(result.termsResponse)).payload;
        const sections = result.sectionsPayload ?? result.payload
            ?? (await responseResult(result.sectionsResponse)).payload;
        if (!terms || typeof terms !== "object" || Array.isArray(terms)
            || !sections || typeof sections !== "object" || Array.isArray(sections)) {
            throw new TypeError("Calendar adapter loadCourses must return object payloads");
        }
        const ok = result.termsResponse.ok && result.sectionsResponse.ok;
        return {
            response: result.termsResponse.ok ? result.sectionsResponse : result.termsResponse,
            payload: { ...terms, ...sections },
            ok: Boolean(ok && result.ok !== false),
            termsResponse: result.termsResponse,
            sectionsResponse: result.sectionsResponse,
        };
    }
    const response = result?.response || result;
    if (!response || typeof response.ok !== "boolean") {
        throw new TypeError(`Calendar adapter ${method} must return a Response or HTTP result`);
    }
    const decoded = result?.payload === undefined
        ? await responseResult(response, BODYLESS_METHODS.has(method))
        : { response, payload: result.payload, ok: response.ok };
    if (!decoded.payload || typeof decoded.payload !== "object" || Array.isArray(decoded.payload)) {
        throw new TypeError(`Calendar adapter ${method} must return an object payload`);
    }
    return { ...decoded, ok: decoded.ok && result?.ok !== false };
}

/**
 * HTTP errors resolve an envelope so each consumer retains its existing user-facing error.
 * Network and malformed successful JSON reject; non-HTTP actions return CalendarActionResult.
 * Legacy injected Responses, course response pairs, and decoded loadRange objects
 * are normalized here once. Consumers use { response, payload, ok } exclusively.
 * @param {CalendarAdapterOverrides} [overrides]
 * @param {{window?: Window}} [host] Mounted runtime for default browser operations.
 * @returns {CalendarDataAdapter}
 */
export function createCalendarDataAdapter(overrides = {}, { window: hostWindow } = {}) {
        if (canonicalAdapters.has(overrides)) return overrides;
        const runtimeWindow = hostWindow || overrides.window || globalThis.window || globalThis;
        if (overrides.fetch !== undefined && typeof overrides.fetch !== "function") {
            throw new TypeError("Calendar adapter fetch override must be a function");
        }
        const fetchImplementation = overrides.fetch ?? runtimeWindow.fetch ?? globalThis.fetch;
        const request = (url, options) => fetchImplementation.call(runtimeWindow, url, options);
        const defaultAdapter = {
            async loadRange({ range, readOnly = false, shareCode = "", signal } = {}) {
                const baseUrl = readOnly && shareCode
                    ? `/api/calendar/share/${encodeURIComponent(shareCode)}/events`
                    : "/api/calendar/events";
                const params = range
                    ? `?${new URLSearchParams({
                        start: range.start.toISOString(),
                        end: range.end.toISOString(),
                    })}`
                    : "";
                const response = await request(`${baseUrl}${params}`, { signal });
                return responseResult(response);
            },
            async loadMirrors({ eventRef, signal } = {}) {
                const response = await request(`/api/extension/mirrors?event_ref=${encodeURIComponent(eventRef)}`, { signal });
                return responseResult(response);
            },
            async changeMirror({ payload: body, signal } = {}) {
                const response = await request("/api/extension/mirrors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
                return responseResult(response);
            },
            async loadPreferences({ signal } = {}) {
                const response = await request("/api/calendar/preferences", { signal });
                return responseResult(response);
            },
            async savePreferences({ payload, signal } = {}) {
                const response = await request("/api/calendar/preferences/batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal,
                });
                return responseResult(response);
            },
            async refresh({ signal } = {}) {
                return responseResult(await request("/api/calendar/refresh", { method: "POST", signal }), true);
            },
            async loadShares({ signal } = {}) {
                const response = await request("/api/calendar/shares", { signal });
                return responseResult(response);
            },
            async saveShare({ shareId, action = "save", payload, signal } = {}) {
                const base = "/api/calendar/shares";
                const item = shareId ? `${base}/${encodeURIComponent(shareId)}` : base;
                let path = item, method = shareId ? "PATCH" : "POST", body = payload;
                if (action !== "save" && !shareId) throw new TypeError("A share id is required for this action");
                switch (action) {
                    case "save": break;
                    case "regenerate": path = `${item}/regenerate`; method = "POST"; body = undefined; break;
                    case "revoke": method = "DELETE"; body = undefined; break;
                    case "ics-detail": path = `${item}/ics`; method = "GET"; body = undefined; break;
                    case "ics-remove": path = `${item}/ics`; method = "DELETE"; body = undefined; break;
                    case "ics-enable": case "ics-disable": case "ics-rotate":
                        path = `${item}/ics`; method = "POST"; body = { action: action.slice(4) }; break;
                    default: throw new TypeError(`Unknown calendar share action: ${action}`);
                }
                const response = await request(path, {
                    method,
                    headers: { "Content-Type": "application/json" },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal,
                });
                return responseResult(response);
            },
            async createEvent({ payload, signal } = {}) {
                const response = await request(String(payload?.calendar_id || "").startsWith("external:") ? "/api/calendar/external-events" : "/api/calendar/events", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal,
                });
                return responseResult(response);
            },
            async updateEvent({ eventId, payload, signal } = {}) {
                const response = await request(String(eventId).startsWith("external:") ? `/api/calendar/external-events/${encodeURIComponent(eventId.slice(9))}` : `/api/calendar/events/${encodeURIComponent(eventId)}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal,
                });
                return responseResult(response);
            },
            async overrideEvent({ payload, signal } = {}) {
                const response = await request("/api/calendar/event-overrides", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal,
                });
                return responseResult(response);
            },
            async deleteEvent({ eventId, revision, signal, keepalive = false } = {}) {
                if (String(eventId).startsWith("external:")) {
                    if (!revision) throw new Error("Refresh this event before deleting it.");
                    return responseResult(await request(`/api/calendar/external-events/${encodeURIComponent(eventId.slice(9))}`, { method: "DELETE", signal, keepalive,
                        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, idempotency_key: (runtimeWindow.crypto || globalThis.crypto).randomUUID() }) }), true);
                }
                return responseResult(await request(`/api/calendar/events/${encodeURIComponent(eventId)}`, {
                    method: "DELETE",
                    signal, keepalive,
                }), true);
            },
            async hideEvent({ eventRef, signal, keepalive = false } = {}) {
                return responseResult(await request("/api/calendar/event-overrides/hide", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ event_ref: eventRef }),
                    signal, keepalive,
                }), true);
            },
            async saveSource({ sourceId, kind, payload, signal } = {}) {
                if (!sourceId && kind !== "local" && kind !== "url") throw new TypeError("A source id or local/url source kind is required");
                const path = sourceId ? "/api/calendar/sources" : `/api/calendar/sources/${kind}`;
                const body = sourceId ? { ...payload, source_id: sourceId } : payload;
                const response = await request(path, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal,
                });
                return responseResult(response);
            },
            async loadCourses({ signal } = {}) {
                const [termsResponse, sectionsResponse] = await Promise.all([
                    request("/api/atlas/terms", { signal }),
                    request("/api/atlas/sections?include_cancelled=1", { signal }),
                ]);
                const [terms, sections] = await Promise.all([
                    responseResult(termsResponse), responseResult(sectionsResponse),
                ]);
                return {
                    response: terms.ok ? sections.response : terms.response,
                    ok: terms.ok && sections.ok,
                    payload: { terms: terms.payload.terms, ...sections.payload },
                    termsResponse, sectionsResponse,
                };
            },
            async loadCourseSectionsById({ sectionIds = [], signal } = {}) {
                const response = await request("/api/atlas/sections/by-id", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ section_ids: sectionIds, include_cancelled: true }),
                    signal,
                });
                return responseResult(response);
            },
            async loadSavedCourses({ signal } = {}) {
                const response = await request("/api/courses/saved", { signal });
                return responseResult(response);
            },
            async setCanvasRouting({ sourceId, state, destinationCalendarId, fallbackCalendarId, signal } = {}) {
                const response = await request(
                    `/api/extension/calendar/sources/${encodeURIComponent(sourceId || "")}/routing`,
                    {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            state,
                            destination_calendar_id: destinationCalendarId || null,
                            fallback_calendar_id: fallbackCalendarId || null,
                        }),
                        signal,
                    },
                );
                return responseResult(response);
            },
            async setDisplayOverride({ eventRef, calendarId, signal } = {}) {
                const response = await request("/api/calendar/event-overrides", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ event_ref: eventRef, calendar_id: calendarId }),
                    signal,
                });
                return responseResult(response);
            },
            async retryWriteback() {
                return {
                    ok: false,
                    state: "unsupported",
                    reason: "The active Canvas adapter does not expose a retry operation.",
                };
            },
            async openSafeSourceUrl({ url } = {}) {
                const safeUrl = getSafeCanvasSourceUrl(url);
                if (!safeUrl || typeof runtimeWindow.open !== "function") {
                    return {
                        ok: false,
                        state: "unsupported",
                        reason: "Only a credential-free HTTPS Canvas origin may be opened.",
                    };
                }
                runtimeWindow.open(safeUrl, "_blank", "noopener,noreferrer");
                return { ok: true, state: "requested", url: safeUrl };
            },
        };

        const adapter = { ...overrides };
        for (const [name, fallback] of Object.entries(defaultAdapter)) {
            const override = overrides[name];
            if (override !== undefined && typeof override !== "function") {
                throw new TypeError(`Calendar adapter ${name} override must be a function`);
            }
            const implementation = override || fallback;
            adapter[name] = ACTION_METHODS.has(name)
                ? async (...args) => implementation.apply(adapter, args)
                : async (...args) => normalizeAdapterResult(name, await implementation.apply(adapter, args));
        }
        adapter.actionSupport = {
            routeDisplayOverride: true,
            retryWriteback: false,
            openSourceUrl: true,
            ...(overrides.actionSupport || {}),
        };
        canonicalAdapters.add(adapter);
        return adapter;
}
