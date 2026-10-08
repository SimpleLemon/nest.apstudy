/* global window */

// Definitions only: global.js installs the shared shell compatibility APIs.
(() => {
    const pad2 = (value) => String(value).padStart(2, "0");

    function toLocalInputValue(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function isoToLocalInput(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : toLocalInputValue(date);
    }

    function localInputToIso(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    window.APStudyCoreServices = window.APStudyCoreServices || {};
    window.APStudyCoreServices.dateTime = Object.freeze({ toLocalInputValue, isoToLocalInput, localInputToIso });
})();
