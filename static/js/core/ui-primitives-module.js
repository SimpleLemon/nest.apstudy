// Utility consumers do not install the shared UI runtime.
import './escaping.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079';

export const { escapeHtml } = globalThis.APStudyCoreServices.escaping;
