/** Own admission and durable retries until the collaboration server unloads. */
export function createCollaborationShutdown({ server, persistence, stopRetries, timeoutMs = 15000, retryMs = 50 }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Shutdown deadline must be positive.');
    let closing = false;
    let shutdownPromise;

    function requireAvailable() {
        if (closing) throw new Error('Collaboration server is shutting down.');
    }

    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        closing = true;
        let stopped = false;
        let deadline;
        let lastError;
        const drain = async () => {
            let destroyed = false;
            const destruction = server.destroy().then(() => { destroyed = true; });
            // Observe a destruction failure immediately, including while a PUT
            // is pending. The deadline also bounds a stalled destroy or PUT.
            const retry = async () => {
                do {
                    for (const document of [...server.documents.values()]) {
                        if (stopped) return;
                        if (document.isLoading) continue;
                        try { await persistence.flush(document); }
                        catch (error) { lastError = error; }
                    }
                    if (!destroyed && !stopped) await new Promise((resolve) => setTimeout(resolve, retryMs));
                } while (!destroyed && !stopped);
            };
            await Promise.all([destruction, retry()]);
        };
        const expires = new Promise((resolve, reject) => {
            deadline = setTimeout(() => {
                const retained = [...server.documents.keys()].join(', ') || 'server destruction';
                reject(new Error(`Collaboration shutdown exceeded ${timeoutMs}ms; uncompleted drain: ${retained}.`,
                    lastError ? { cause: lastError } : undefined));
            }, timeoutMs);
        });
        shutdownPromise = Promise.race([drain(), expires]).finally(() => {
            stopped = true;
            clearTimeout(deadline);
            stopRetries();
        });
        return shutdownPromise;
    }

    return { requireAvailable, shutdown };
}
