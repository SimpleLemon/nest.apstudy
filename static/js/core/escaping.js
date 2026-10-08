// Definitions only: safe for classic scripts and utility module imports.
(() => {
    const coreServices = globalThis.APStudyCoreServices ||= {};
    if (coreServices.escaping) return;

    const htmlEntities = Object.freeze({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '\u00a0': '&nbsp;',
    });

    function escapeHtml(value) {
        return (value == null ? '' : String(value)).replace(/[&<>"'\u00a0]/g, character => htmlEntities[character]);
    }

    coreServices.escaping = Object.freeze({ escapeHtml });
})();
