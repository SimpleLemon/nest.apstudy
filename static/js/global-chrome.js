/*
 * Compatibility shim for templates that still include global-chrome.js before
 * global.js. The shared chrome, loader, confirmation, date, and auth helpers
 * live in global.js to avoid maintaining duplicated browser bootstrap code.
 */
