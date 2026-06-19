(function registerNotesListUtils(global) {
    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function formatCount(count, singular) {
        return `${count} ${singular}${count === 1 ? '' : 's'}`;
    }

    function formatDate(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) return 'Updated recently';
        return `Updated ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }

    function notePreview(note) {
        if (typeof note.content !== 'string' || !note.content.trim()) return 'Blank note';
        try {
            const blocks = JSON.parse(note.content);
            const text = (Array.isArray(blocks) ? blocks : [])
                .flatMap((block) => Array.isArray(block.content) ? block.content : [])
                .map((item) => item?.text || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            return text || 'Blank note';
        } catch {
            return 'Blank note';
        }
    }

    function buildLoadingIndicatorHtml(label = 'Loading notes...', options = {}) {
        return global.APStudyLoader.html(label, options);
    }

    async function apiJson(url, options = {}) {
        if (global.APStudyHttp?.fetchJson) {
            return global.APStudyHttp.fetchJson(url, {
                ...options,
                pendingLabel: options.pendingLabel || "notes-save",
            });
        }
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const method = String(options.method || 'GET').toUpperCase();
        const request = fetch(url, { ...options, headers });
        const response = await (method === 'GET'
            ? request
            : global.APStudyPendingMutations?.track(request, 'notes-save') || request);
        const contentType = response.headers.get('Content-Type') || '';
        const payload = contentType.includes('application/json') ? await response.json() : null;
        if (!response.ok) {
            throw new Error(payload?.error || payload?.message || response.statusText || 'Request failed.');
        }
        return payload || {};
    }

    global.APStudyNotesListUtils = {
        apiJson,
        buildLoadingIndicatorHtml,
        escapeHtml,
        formatCount,
        formatDate,
        notePreview,
    };
})(window);
