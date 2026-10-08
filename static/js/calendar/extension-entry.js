import "./extension.css";
import { CALENDAR_EXTENSION_CONTRACT_VERSION } from "./capabilities.js";
import { mountCalendar } from "./index.js";
import { createCalendarDataAdapter } from "./adapter.js";

export { CALENDAR_EXTENSION_CONTRACT_VERSION, createCalendarDataAdapter, mountCalendar };

const extensionApi = {
    contractVersion: CALENDAR_EXTENSION_CONTRACT_VERSION,
    mountCalendar,
    createCalendarDataAdapter,
};

if (typeof globalThis !== "undefined") {
    globalThis.APStudyCalendarExtension = extensionApi;
}
