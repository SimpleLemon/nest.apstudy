// Local persistence is optional: browser privacy and quota limits must not block
// server requests, rendering, or cleanup after a successful mutation.
export function createCalendarStorage(view, kind = "localStorage") {
    function operate(method, args, fallback = null) {
        try {
            const storage = view?.[kind] || globalThis[kind];
            if (!storage || typeof storage[method] !== "function") return fallback;
            const result = storage[method](...args);
            return method === "getItem" ? result ?? fallback : true;
        } catch (error) {
            console.warn(`Calendar ${kind} ${method} unavailable:`, error);
            return fallback;
        }
    }
    return {
        getItem: (key) => operate("getItem", [key]),
        setItem: (key, value) => operate("setItem", [key, value], false),
        removeItem: (key) => operate("removeItem", [key], false),
    };
}
