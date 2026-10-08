/* global window, URL, XMLHttpRequest */

/**
 * @typedef {import('./http-types.js').FetchJsonOptions} FetchJsonOptions
 * @typedef {object} UploadXhrOptions
 * @property {Document|XMLHttpRequestBodyInit|null} [body]
 * @property {Object<string, string|number|null|undefined>} [headers]
 * @property {string} [method]
 * @property {((event: ProgressEvent<XMLHttpRequestEventTarget>) => void)|null} [onProgress]
 * @property {string|null} [pendingLabel]
 * @property {XMLHttpRequestResponseType} [responseType]
 * @property {number} [timeout]
 * @property {AbortSignal|null} [signal]
 * @property {() => XMLHttpRequest} [xhrFactory]
 * @typedef {object} HttpCsrfService
 * @property {() => string} token
 * @property {() => Promise<void>} refresh
 * @property {(status: number, getHeader: (name: string) => string|null|undefined) => boolean} isFailure
 * @typedef {object} HttpPendingMutations
 * @property {<T>(request: Promise<T>, label: string) => Promise<T>} track
 * @typedef {object} HttpServiceOptions
 * @property {{fetch: typeof fetch, location: {href: string, origin: string}, FormData?: typeof FormData}} window
 * @property {HttpCsrfService|null} [csrf]
 * @property {HttpPendingMutations|null} [pendingMutations]
 * @typedef {object} HttpService
 * @property {(url: string|URL|Request, options?: FetchJsonOptions) => Promise<unknown>} fetchJson
 * @property {(url: string|URL, body?: unknown, csrfToken?: string) => Promise<unknown>} postJson
 * @property {(url: string|URL, options?: UploadXhrOptions) => Promise<XMLHttpRequest>} uploadXhr
 */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    function attachResponseContext(error, response, requestUrl, payload, parseError) {
        error.status = response.status;
        error.url = response.url || requestUrl;
        error.response = response;
        if (parseError) error.cause = parseError;
        if (payload && typeof payload === "object") {
            ["code", "resource", "limit", "current", "requested"].forEach((key) => {
                if (payload[key] != null) error[key] = payload[key];
            });
        }
        return error;
    }

    /**
     * Create a service without installing compatibility globals or wrapping fetch.
     * @param {HttpServiceOptions} dependencies
     * @returns {HttpService}
     */
    function createHttpService({ window, csrf, pendingMutations }) {
        const service = {
            /**
             * Resolve the decoded payload (or {} for HEAD, 204/205, or a
             * non-JSON body in content-type mode). Required mode decodes all
             * ordinary responses, including login/HTML responses.
             * HTTP failures reject with status, url and response, even if their
             * body is malformed; errorFactory(payload, response) can customize
             * that error. A decoding failure is retained as cause. Successful
             * malformed JSON rejects unless jsonMode is optional. Network and
             * cancellation failures from fetch propagate unchanged. Synchronous
             * validateResponse/validatePayload checks can reject feature-specific
             * responses before/after decoding with the same error context.
             * @param {string|URL|Request} url
             * @param {FetchJsonOptions} [options]
             * @returns {Promise<unknown>} Unvalidated decoded JSON.
             */
            async fetchJson(url, options = {}) {
                const {
                    errorFactory = null,
                    jsonMode = "content-type",
                    pendingLabel = null,
                    validateResponse = null,
                    validatePayload = null,
                    ...requestOptions
                } = options;
                const headers = requestOptions.headers == null && url?.headers?.entries
                    ? Object.fromEntries(url.headers.entries())
                    : { ...(requestOptions.headers || {}) };
                const formDataTypes = [window.FormData, globalThis.FormData].filter((type) => typeof type === "function");
                const isFormData = formDataTypes.some((type) => requestOptions.body instanceof type);
                if (requestOptions.body && !isFormData && !headers["Content-Type"]) {
                    headers["Content-Type"] = "application/json";
                }
                const inputMethod = typeof url === "object" && "method" in url ? url.method : "GET";
                const method = String(requestOptions.method || inputMethod).toUpperCase();
                const requestUrl = url?.url || String(url);
                const execute = async () => {
                    const response = await window.fetch(url, { ...requestOptions, headers });
                    try { validateResponse?.(response); }
                    catch (error) { throw attachResponseContext(error, response, requestUrl); }
                    const contentType = response.headers.get("Content-Type") || "";
                    let payload = {};
                    let parseError = null;
                    const bodyless = method === "HEAD" || response.status === 204 || response.status === 205;
                    if (!bodyless && (jsonMode === "required" || jsonMode === "optional" || contentType.includes("application/json"))) {
                        try { payload = await response.json(); }
                        catch (error) { parseError = error; payload = {}; }
                    }
                    try { validatePayload?.(payload, response); }
                    catch (error) { throw attachResponseContext(error, response, requestUrl, payload, parseError); }
                    if (!response.ok) {
                        const message = payload?.error || payload?.message || response.statusText || "Request failed.";
                        const error = typeof errorFactory === "function"
                            ? errorFactory(payload, response)
                            : new Error(message);
                        throw attachResponseContext(error, response, requestUrl, payload, parseError);
                    }
                    if (parseError && jsonMode !== "optional") {
                        const error = new Error("Invalid JSON response.", { cause: parseError });
                        throw attachResponseContext(error, response, requestUrl);
                    }
                    return payload;
                };
                const request = execute();
                return !["GET", "HEAD", "OPTIONS"].includes(method) && pendingLabel && pendingMutations?.track
                    ? pendingMutations.track(request, pendingLabel)
                    : request;
            },

            /**
             * Post a JSON command with the caller's CSRF token. Commands require
             * a decoded acknowledgment and prefer the server's message on failure.
             * @param {string|URL} url
             * @param {unknown} [body]
             * @param {string} [csrfToken]
             * @returns {Promise<unknown>}
             */
            async postJson(url, body, csrfToken = "") {
                return service.fetchJson(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRFToken": csrfToken,
                    },
                    body: JSON.stringify(body || {}),
                    credentials: "same-origin",
                    jsonMode: "required",
                    errorFactory: (payload) => new Error(payload?.message || payload?.error || "Request failed."),
                });
            },

            /**
             * Resolve the final raw XHR, including non-2xx HTTP responses and
             * status 0 for network errors/timeouts; callers inspect status and
             * decode the feature payload. Reject AbortError on cancellation,
             * or the setup/CSRF refresh error on failure. A recognized same-origin
             * CSRF failure retries once. signal cancels either attempt or refresh;
             * onProgress receives upload ProgressEvents from both attempts.
             * pendingLabel tracks the entire operation, including the retry.
             * @param {string|URL} url
             * @param {UploadXhrOptions} [options]
             * @returns {Promise<XMLHttpRequest>}
             */
            async uploadXhr(url, options = {}) {
                const {
                    body = null,
                    headers = {},
                    method = "POST",
                    onProgress = null,
                    pendingLabel = null,
                    responseType = "json",
                    timeout = 0,
                    signal = null,
                    xhrFactory = () => new XMLHttpRequest(),
                } = options;
                const requestUrl = new URL(String(url), window.location.href);
                const sameOrigin = requestUrl.origin === window.location.origin;
                let activeXhr = null;
                const abortError = () => {
                    const error = new Error("Upload cancelled.");
                    error.name = "AbortError";
                    if (activeXhr) error.xhr = activeXhr;
                    return error;
                };

                const sendAttempt = (retry = false) => new Promise((resolve, reject) => {
                    if (signal?.aborted) return reject(abortError());
                    const xhr = xhrFactory();
                    activeXhr = xhr;
                    xhr.open(String(method).toUpperCase(), requestUrl.href, true);
                    if (responseType) xhr.responseType = responseType;
                    if (Number(timeout) > 0) xhr.timeout = Number(timeout);
                    Object.entries(headers).forEach(([name, value]) => {
                        if (value != null) xhr.setRequestHeader(name,
                            sameOrigin && retry && name.toLowerCase() === "x-csrftoken"
                                ? csrf?.token?.() || String(value) : String(value));
                    });
                    if (sameOrigin && !Object.keys(headers).some((name) => name.toLowerCase() === "x-csrftoken")) {
                        const token = csrf?.token?.();
                        if (token) xhr.setRequestHeader("X-CSRFToken", token);
                    }
                    if (xhr.upload && typeof onProgress === "function") {
                        xhr.upload.onprogress = onProgress;
                    }
                    xhr.onload = () => resolve(xhr);
                    xhr.onerror = () => resolve(xhr);
                    xhr.ontimeout = () => resolve(xhr);
                    xhr.onabort = () => {
                        reject(abortError());
                    };
                    xhr.send(body);
                });

                const execute = async () => {
                    let xhr = await sendAttempt();
                    const isCsrfFailure = sameOrigin && csrf?.isFailure?.(
                        xhr.status,
                        (name) => xhr.getResponseHeader?.(name),
                    );
                    if (!isCsrfFailure) return xhr;
                    await csrf.refresh();
                    xhr = await sendAttempt(true);
                    return xhr;
                };

                let onAbort;
                const cancelled = signal && new Promise((_, reject) => {
                    onAbort = () => {
                        reject(abortError());
                        activeXhr?.abort();
                    };
                    signal.addEventListener("abort", onAbort, { once: true });
                });
                let request = signal?.aborted ? Promise.reject(abortError())
                    : cancelled ? Promise.race([execute(), cancelled]) : execute();
                request = request.finally(() => signal?.removeEventListener("abort", onAbort));
                if (pendingLabel && pendingMutations?.track) {
                    request = pendingMutations.track(request, pendingLabel);
                }
                return request;
            },
        };
        return service;
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.http = Object.freeze({ createHttpService });
})();
