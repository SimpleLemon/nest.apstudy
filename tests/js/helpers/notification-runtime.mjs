import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const httpSource = await readFile(new URL('../../../static/js/core/http.js', import.meta.url), 'utf8');
const notificationSource = await readFile(new URL('../../../static/js/core/notifications.js', import.meta.url), 'utf8');
export const flushNotifications = () => new Promise(resolve => setImmediate(resolve));

function eventSurface() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) {
            const registered = listeners.get(type) || [];
            registered.push(listener);
            listeners.set(type, registered);
        },
        dispatch(type, detail = {}) {
            for (const listener of listeners.get(type) || []) listener({ type, ...detail });
        },
    };
}

function storage(values = new Map()) {
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    };
}

export function notificationWorld({ useLocks = true } = {}) {
    let now = Date.parse('2026-10-06T12:00:00Z');
    let timerId = 0;
    let lockOwner = null;
    const timers = new Map();
    const channels = new Map();
    const localStorage = storage();
    const requests = [];

    const schedule = (tab, callback, delay, repeat) => {
        const id = ++timerId;
        const interval = Math.max(1, Number(delay) || 1);
        timers.set(id, { tab, callback, due: now + interval, interval, repeat });
        return id;
    };

    async function advance(milliseconds) {
        const until = now + milliseconds;
        for (;;) {
            const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
            if (!next || next[1].due > until) break;
            const [id, timer] = next;
            now = timer.due;
            if (timer.repeat) timer.due += timer.interval;
            else timers.delete(id);
            timer.callback();
            await flushNotifications();
        }
        now = until;
        await flushNotifications();
    }

    function tab(id, { respond, pushManager, mobile = false } = {}) {
        let focused = true;
        const toasts = [];
        const focusModes = [];
        const subscriptions = [];
        const badge = { textContent: '', hidden: true };
        const host = { querySelector: () => badge };
        const tray = {
            unread: 0, opened: false, refreshes: 0, refreshFailure: null,
            setUnreadCount(value) { this.unread = value; },
            isOpen() { return this.opened; },
            open() { this.opened = true; },
            async refresh() { this.refreshes += 1; if (this.refreshFailure) throw this.refreshFailure; },
        };
        const document = {
            ...eventSurface(), readyState: 'loading', cookie: 'csrf_token=test-token',
            hidden: false, visibilityState: 'visible', hasFocus: () => focused,
            getElementById: name => name === 'navbar-notifications-host' ? host : null,
            querySelector: () => null,
        };
        const sessionStorage = storage(new Map([['apstudy-notification-tab-id', id]]));
        const window = {
            ...eventSurface(), document, localStorage, sessionStorage,
            Notification: { permission: 'granted' }, isSecureContext: true, PushManager: class {},
            matchMedia: () => ({ matches: true }),
            location: { origin: 'https://nest.example', assign() {} },
            APStudyToast: { show: toast => toasts.push(toast) },
            APStudyProfileStatus: { setFocusMode: value => focusModes.push(value) },
            APStudyNotificationTray: { mount: () => tray },
            setInterval: (callback, delay) => schedule(id, callback, delay, true),
            clearInterval: timer => timers.delete(timer),
            setTimeout: (callback, delay) => schedule(id, callback, delay, false),
            clearTimeout: timer => timers.delete(timer),
        };
        window.BroadcastChannel = class {
            constructor(name) {
                Object.assign(this, eventSurface(), { name, closed: false });
                if (!channels.has(name)) channels.set(name, new Set());
                channels.get(name).add(this);
            }
            postMessage(message) {
                for (const peer of channels.get(this.name)) {
                    if (peer !== this && !peer.closed) queueMicrotask(() => peer.dispatch('message', { data: structuredClone(message) }));
                }
            }
            close() { this.closed = true; channels.get(this.name).delete(this); }
        };
        const navigator = { userAgent: 'Desktop test browser', userAgentData: { mobile } };
        if (useLocks) navigator.locks = {
            async request(_name, _options, callback) {
                if (lockOwner) return callback(null);
                lockOwner = id;
                try { return await callback({ name: 'notification leader' }); }
                finally { if (lockOwner === id) lockOwner = null; }
            },
        };
        if (pushManager) {
            const registration = { update: async () => {}, pushManager };
            navigator.serviceWorker = {
                register: async (url, options) => { subscriptions.push({ url, options }); return registration; },
                ready: Promise.resolve(registration), getRegistration: async () => registration,
            };
        }
        window.fetch = async (url, options = {}) => {
            const request = { tab: id, url, options, body: options.body ? JSON.parse(options.body) : null };
            requests.push(request);
            const supplied = await respond?.(request);
            if (supplied instanceof Response) return supplied;
            const payload = supplied ?? (url.endsWith('/sync')
                ? { active: request.body.active, notifications: [], pending_foreground_ids: [], unread_count: 0 }
                : { unread_count: 0 });
            return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
        };
        class ClockDate extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        }
        const context = vm.createContext({ window, document, navigator, sessionStorage,
            Notification: window.Notification, Date: ClockDate, URL, FormData, Uint8Array, DOMException: globalThis.DOMException,
            console, atob: globalThis.atob, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
        vm.runInContext(httpSource, context);
        window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
        vm.runInContext(notificationSource, context);
        const dispatch = async (type, detail = {}) => { window.dispatch(type, detail); await flushNotifications(); };
        return {
            api: window.APStudyNotifications, window, document, badge, tray, toasts, focusModes, subscriptions,
            start: async () => { document.readyState = 'complete'; document.dispatch('DOMContentLoaded'); await flushNotifications(); },
            blur: async () => { focused = false; await dispatch('blur'); },
            focus: async () => { focused = true; await dispatch('focus'); },
            visibility: async hidden => {
                document.hidden = hidden; document.visibilityState = hidden ? 'hidden' : 'visible';
                document.dispatch('visibilitychange'); await flushNotifications();
            },
            dispatch,
            requests: () => requests.filter(request => request.tab === id),
            activeTimers: () => [...timers.values()].filter(timer => timer.tab === id).length,
        };
    }
    return { tab, advance, requests, leader: () => lockOwner, channelCount: () => [...channels.values()].reduce((count, group) => count + group.size, 0) };
}
