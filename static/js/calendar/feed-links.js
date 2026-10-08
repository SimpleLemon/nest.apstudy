/** Comparison policy for optional calendar feeds and the separate Canvas feed. */
export function calendarFeedComparisonKey(value, { allowMissingScheme = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
    try {
        const parsed = new URL(!hasScheme && allowMissingScheme ? `https://${raw}` : raw);
        const protocol = parsed.protocol === 'webcal:' ? 'https:' : parsed.protocol;
        if (protocol !== 'http:' && protocol !== 'https:') return '';
        return `${protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch {
        return '';
    }
}

/** Preserve input indexes (including blank rows) so pages can mark one field. */
export function validateCalendarFeedLinks(canvasUrl, otherUrls, {
    maxOtherCalendars = 10,
    canvasAllowMissingScheme = false,
} = {}) {
    const canvas = String(canvasUrl || '').trim();
    const canvasKey = calendarFeedComparisonKey(canvas, { allowMissingScheme: canvasAllowMissingScheme });
    const seen = new Set();
    const cleaned = [];
    function invalid(code, inputIndex, message) {
        const error = new Error(message);
        error.code = code;
        error.inputIndex = inputIndex;
        throw error;
    }
    otherUrls.forEach((value, inputIndex) => {
        const url = String(value || '').trim();
        if (!url) return;
        if (cleaned.length >= maxOtherCalendars) {
            invalid('too_many', inputIndex, `You can add up to ${maxOtherCalendars} calendar links.`);
        }
        const key = calendarFeedComparisonKey(url);
        if (!key) invalid('invalid_url', inputIndex, 'Each optional calendar link must be a valid http(s) or webcal URL.');
        if (canvasKey && key === canvasKey) invalid('canvas_duplicate', inputIndex, 'Optional calendar links cannot duplicate the Canvas calendar.');
        if (seen.has(key)) invalid('duplicate', inputIndex, 'Duplicate optional calendar links are not allowed.');
        seen.add(key);
        cleaned.push(url);
    });
    return { canvas_ical_url: canvas, other_ical_urls: cleaned };
}
