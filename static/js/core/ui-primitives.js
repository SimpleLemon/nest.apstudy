/*
 * Shared UI primitive ownership:
 * - Form field invalid-state helpers
 * - Loading and skeleton markup
 * - Toast notifications
 * - Confirmation dialogs
 *
 * This file is intentionally classic/deferred so every feature can consume the
 * globals below before global.js or a feature entry point executes.
 */
(() => {
    if (window.APStudyUIPrimitives) return;

    const escapeHtml = (value) => {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    };

    const normalizeFields = (fields) => (Array.isArray(fields) ? fields : [fields]).filter(Boolean);
    const autoClearHandlers = new WeakMap();
    window.APStudyFormField = window.APStudyFormField || {
        markInvalid(fields, { focus = true } = {}) {
            const list = normalizeFields(fields);
            list.forEach((field) => field.setAttribute('aria-invalid', 'true'));
            if (focus) list[0]?.focus?.({ preventScroll: true });
            return list[0] || null;
        },
        clearInvalid(fields) {
            normalizeFields(fields).forEach((field) => field.removeAttribute('aria-invalid'));
        },
        clearAll(root = document) {
            root?.querySelectorAll?.('[aria-invalid="true"]').forEach((field) => field.removeAttribute('aria-invalid'));
        },
        bindAutoClear(fields) {
            normalizeFields(fields).forEach((field) => {
                if (autoClearHandlers.has(field)) return;
                const handler = () => field.removeAttribute('aria-invalid');
                field.addEventListener('input', handler);
                field.addEventListener('change', handler);
                autoClearHandlers.set(field, handler);
            });
        },
    };

    window.APStudyLoader = window.APStudyLoader || {
        html(label = 'Loading...', options = {}) {
            const size = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
            const tone = escapeHtml(options.textToneClass || 'text-on-surface-variant');
            return `<div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${tone}"><span class="loader" style="width:${size}px;height:${size}px" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div>`;
        },
    };

    const skeletonBlock = (className = '') => `<div data-slot="skeleton" class="bg-muted rounded-md animate-pulse ${escapeHtml(className)}"></div>`;
    const skeletonShell = (label, className, body) => `<div class="apstudy-skeleton ${escapeHtml(className)}" role="status" aria-live="polite" aria-busy="true"><span class="sr-only">${escapeHtml(label)}</span><div class="contents" aria-hidden="true">${body}</div></div>`;
    window.APStudySkeleton = window.APStudySkeleton || {
        block: skeletonBlock,
        cards(options = {}) {
            const count = Math.max(1, Number(options.count || 3));
            const cards = Array.from({ length: count }, () => `<div class="apstudy-skeleton-card rounded-md border p-4">${skeletonBlock('h-5 w-32')}${skeletonBlock('mt-3 h-3 w-full')}</div>`).join('');
            return skeletonShell(options.label || 'Loading cards...', `apstudy-skeleton-cards ${options.className || ''}`, cards);
        },
        table(options = {}) {
            const rows = Math.max(1, Number(options.rows || 4));
            const body = Array.from({ length: rows }, () => `<div class="grid gap-4">${skeletonBlock('h-4 w-full')}</div>`).join('');
            return skeletonShell(options.label || 'Loading table...', `apstudy-skeleton-table ${options.className || ''}`, body);
        },
        fieldSet(options = {}) {
            const fields = Math.max(1, Number(options.fields || 4));
            const body = Array.from({ length: fields }, () => `<div class="grid gap-2">${skeletonBlock('h-3 w-20')}${skeletonBlock('h-10 w-full')}</div>`).join('');
            return skeletonShell(options.label || 'Loading form...', `apstudy-skeleton-fieldset ${options.className || ''}`, body);
        },
    };

    function ensureToastHost() {
        let host = document.getElementById('apstudy-toast-host');
        if (host) return host;
        host = document.createElement('div');
        host.id = 'apstudy-toast-host';
        host.className = 'apstudy-toast-host';
        host.setAttribute('role', 'region');
        host.setAttribute('aria-label', 'Notifications');
        host.setAttribute('aria-live', 'polite');
        (document.body || document.documentElement).appendChild(host);
        return host;
    }

    function showToast(options = {}) {
        if (typeof options === 'string') options = { message: options };
        const type = ['info', 'success', 'warning', 'error'].includes(options.type) ? options.type : 'info';
        const toast = document.createElement('div');
        toast.className = `apstudy-toast is-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const copy = document.createElement('div');
        copy.className = 'apstudy-toast__copy';
        if (options.title) {
            const title = document.createElement('p');
            title.className = 'apstudy-toast__title';
            title.textContent = String(options.title);
            copy.appendChild(title);
        }
        const message = document.createElement('p');
        message.className = 'apstudy-toast__message';
        message.textContent = String(options.message || '');
        copy.appendChild(message);
        if (options.action && (options.action.label || options.action.text)) {
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'apstudy-toast__action';
            action.textContent = String(options.action.label || options.action.text);
            action.addEventListener('click', () => {
                const keepOpen = typeof options.action.onClick === 'function'
                    ? options.action.onClick() === true
                    : false;
                if (options.action.href) window.location.assign(options.action.href);
                if (!keepOpen && !options.action.href) dismiss();
            });
            copy.appendChild(action);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'apstudy-toast__close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        toast.append(copy, close);
        let dismissed = false;
        let timer = null;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            if (timer) window.clearTimeout(timer);
            toast.classList.add('is-leaving');
            window.setTimeout(() => toast.remove(), 400);
        };
        close.addEventListener('click', dismiss);
        const pause = () => {
            if (timer) window.clearTimeout(timer);
            timer = null;
        };
        const resume = () => {
            if (!dismissed && duration > 0 && !timer) timer = window.setTimeout(dismiss, duration);
        };
        toast.addEventListener('mouseenter', pause);
        toast.addEventListener('mouseleave', resume);
        toast.addEventListener('focusin', pause);
        toast.addEventListener('focusout', resume);
        ensureToastHost().prepend(toast);
        requestAnimationFrame(() => toast.classList.add('is-visible'));
        const duration = Number.isFinite(Number(options.duration)) ? Number(options.duration) : 3000;
        if (duration > 0) timer = window.setTimeout(dismiss, duration);
        return { dismiss };
    }
    window.APStudyToast = window.APStudyToast || {
        show: showToast,
        info: (message, options = {}) => showToast({ ...options, message, type: 'info' }),
        success: (message, options = {}) => showToast({ ...options, message, type: 'success' }),
        warning: (message, options = {}) => showToast({ ...options, message, type: 'warning' }),
        error: (message, options = {}) => showToast({ ...options, message, type: 'error' }),
    };

    let activeConfirm = null;
    function ensureConfirm() {
        let root = document.getElementById('apstudy-confirm-root');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'apstudy-confirm-root';
        root.className = 'apstudy-confirm';
        root.hidden = true;
        root.innerHTML = `<div class="apstudy-confirm__panel" role="dialog" aria-modal="true" aria-labelledby="apstudy-confirm-title" aria-describedby="apstudy-confirm-message"><div class="apstudy-confirm__icon" aria-hidden="true"><span class="material-symbols-outlined" aria-hidden="true">warning</span></div><div class="apstudy-confirm__copy"><h2 id="apstudy-confirm-title"></h2><p id="apstudy-confirm-message"></p></div><div class="apstudy-confirm__actions"><button type="button" class="apstudy-confirm__cancel" data-confirm-cancel>Cancel</button><button type="button" class="apstudy-confirm__accept" data-confirm-accept>Confirm</button></div></div>`;
        document.body.appendChild(root);
        root.querySelector('[data-confirm-cancel]').addEventListener('click', () => closeConfirm(false));
        root.querySelector('[data-confirm-accept]').addEventListener('click', () => closeConfirm(true));
        root.addEventListener('pointerdown', (event) => event.target === root && closeConfirm(false));
        return root;
    }
    function closeConfirm(value) {
        if (!activeConfirm) return;
        const record = activeConfirm;
        activeConfirm = null;
        record.root.hidden = true;
        document.body.classList.remove('apstudy-confirm-open');
        record.resolve(Boolean(value));
        record.previousFocus?.focus?.({ preventScroll: true });
    }
    window.APStudyConfirm = window.APStudyConfirm || {
        request(options = {}) {
            if (activeConfirm) closeConfirm(false);
            const root = ensureConfirm();
            root.querySelector('#apstudy-confirm-title').textContent = String(options.title || 'Are you sure?');
            root.querySelector('#apstudy-confirm-message').textContent = String(options.message || 'This action cannot be undone.');
            root.querySelector('[data-confirm-accept]').textContent = String(options.acceptLabel || options.confirmLabel || 'Confirm');
            root.querySelector('[data-confirm-cancel]').textContent = String(options.cancelLabel || 'Cancel');
            root.classList.toggle('is-danger', options.danger !== false);
            root.hidden = false;
            document.body.classList.add('apstudy-confirm-open');
            return new Promise((resolve) => {
                activeConfirm = { root, resolve, previousFocus: document.activeElement };
                requestAnimationFrame(() => root.querySelector('[data-confirm-cancel]')?.focus({ preventScroll: true }));
            });
        },
    };
    document.addEventListener('keydown', (event) => {
        if (activeConfirm && event.key === 'Escape') {
            event.preventDefault();
            closeConfirm(false);
        }
    });

    window.APStudyUIPrimitives = Object.freeze({
        form: window.APStudyFormField,
        loader: window.APStudyLoader,
        skeleton: window.APStudySkeleton,
        toast: window.APStudyToast,
        confirm: window.APStudyConfirm,
    });
})();
