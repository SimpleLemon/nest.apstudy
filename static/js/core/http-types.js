/**
 * Shared fetch options for browser features and the HTTP service. Headers use
 * a plain record because the service copies them before passing them to fetch.
 * jsonMode defaults to content-type; required always decodes ordinary responses,
 * while optional tolerates decoding failures. pendingLabel tracks mutation methods.
 * Synchronous validators throw Error: validateResponse runs before decoding;
 * validatePayload runs after decoding, including failed/optional JSON bodies.
 * Their errors receive the same response context as HTTP failures.
 * @typedef {Omit<RequestInit, 'headers'> & {headers?: Object<string, string>, jsonMode?: 'content-type'|'required'|'optional', pendingLabel?: string|null, errorFactory?: ((payload: unknown, response: Response) => Error)|null, validateResponse?: ((response: Response) => void)|null, validatePayload?: ((payload: unknown, response: Response) => void)|null}} FetchJsonOptions
 */
/**
 * Context attached to HTTP failures and successful responses with invalid JSON.
 * Server metadata is copied without validation and can therefore have any shape.
 * Network failures and cancellation errors propagate without this enrichment.
 * @typedef {Error & {status: number, url: string, response: Response, cause?: unknown, code?: unknown, resource?: unknown, limit?: unknown, current?: unknown, requested?: unknown}} HttpResponseError
 */
export {};
