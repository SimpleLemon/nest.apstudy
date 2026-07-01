const PRINT_MEDIA_TYPES = new Set(['bookmark', 'video', 'audio', 'file']);
const PRINT_IMAGE_TIMEOUT_MS = 2000;

export const PRINT_TEXT_COLORS = Object.freeze({
    gray: '#4b5563',
    brown: '#7c4a2d',
    red: '#b42318',
    orange: '#b54708',
    yellow: '#854d0e',
    green: '#166534',
    blue: '#1d4ed8',
    purple: '#6b21a8',
    pink: '#9d174d',
});

export const PRINT_HIGHLIGHT_COLORS = Object.freeze({
    gray: '#f3f4f6',
    brown: '#f5ebe3',
    red: '#fee2e2',
    orange: '#ffedd5',
    yellow: '#fef3c7',
    green: '#dcfce7',
    blue: '#dbeafe',
    purple: '#f3e8ff',
    pink: '#fce7f3',
});

const ACTIVE_PRINT_KEY = Symbol.for('apstudy.notes.active-print-promise');
const PRINT_CONTROLLER_KEY = Symbol.for('apstudy.notes.print-controller');

export function normalizePrintTitle(value) {
    return String(value || '').trim() || 'Untitled';
}

export function isNotePrintShortcut(event) {
    return Boolean(
        event
        && !event.defaultPrevented
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && String(event.key || '').toLowerCase() === 'p'
    );
}

export function bindNotePrintController({
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    isReady = () => false,
    requestPrint,
} = {}) {
    if (!documentRef || !windowRef || typeof requestPrint !== 'function') return null;
    if (windowRef[PRINT_CONTROLLER_KEY]) return windowRef[PRINT_CONTROLLER_KEY];

    const handleClick = (event) => {
        const button = event?.target?.closest?.('[data-note-print]');
        if (!button || !documentRef.contains?.(button)) return;
        event.preventDefault?.();
        requestPrint();
    };
    const handleKeydown = (event) => {
        if (!isNotePrintShortcut(event)) return;
        event.preventDefault?.();
        if (isReady()) requestPrint();
    };
    const controller = { handleClick, handleKeydown };
    windowRef[PRINT_CONTROLLER_KEY] = controller;
    documentRef.addEventListener?.('click', handleClick, true);
    documentRef.addEventListener?.('keydown', handleKeydown, true);
    return controller;
}

export function printColorFor(value, { highlight = false } = {}) {
    const palette = highlight ? PRINT_HIGHLIGHT_COLORS : PRINT_TEXT_COLORS;
    return palette[String(value || '').toLowerCase()] || '';
}

function safePrintUrl(value, { image = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (image && /^data:image\/(?:avif|gif|jpeg|png|webp);/i.test(raw)) return raw;
    try {
        const parsed = new URL(raw);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    } catch (error) {
        return '';
    }
}

function mediaLabel(block) {
    const props = block?.props || {};
    const type = block?.type || 'file';
    const typeLabel = type === 'bookmark'
        ? 'Bookmark'
        : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const candidate = props.title || props.name || props.caption || props.siteName || '';
    const label = String(candidate || '').trim();
    if (!label || label === props.url) return typeLabel;
    return type === 'bookmark' ? label : `${typeLabel}: ${label}`;
}

function mediaLinkBlock(block) {
    const url = safePrintUrl(block?.props?.url);
    if (!url) return null;
    return {
        type: 'paragraph',
        content: [{
            type: 'link',
            href: url,
            content: [{ type: 'text', text: mediaLabel(block), styles: {} }],
        }],
    };
}

function printableBlock(block, hiddenIds) {
    if (!block || hiddenIds.has(String(block.id || ''))) return null;
    if (PRINT_MEDIA_TYPES.has(block.type)) return mediaLinkBlock(block);
    if (block.type === 'image' && !safePrintUrl(block.props?.url, { image: true })) return null;

    const next = { ...block };
    if (Array.isArray(block.children)) {
        next.children = block.children
            .map((child) => printableBlock(child, hiddenIds))
            .filter(Boolean);
    }
    return next;
}

export function printableBlocksForCurrentView(blocks, hiddenBlockIds = []) {
    const hiddenIds = new Set(Array.from(hiddenBlockIds, (id) => String(id || '')));
    return (Array.isArray(blocks) ? blocks : [])
        .map((block) => printableBlock(block, hiddenIds))
        .filter(Boolean);
}

export function imageFallbackDetails(image) {
    const src = safePrintUrl(image?.currentSrc || image?.src || image?.getAttribute?.('src'), { image: true });
    const alt = String(image?.alt || image?.getAttribute?.('alt') || '').trim();
    return {
        href: src && !src.startsWith('data:') ? src : '',
        label: alt ? `Image: ${alt}` : 'Image unavailable',
    };
}

function replaceImageWithFallback(image) {
    const documentRef = image?.ownerDocument;
    if (!documentRef || typeof image.replaceWith !== 'function') return;
    const details = imageFallbackDetails(image);
    const replacement = documentRef.createElement(details.href ? 'a' : 'span');
    replacement.className = 'notes-print-media-fallback';
    replacement.textContent = details.label;
    if (details.href) {
        replacement.href = details.href;
        replacement.rel = 'noopener noreferrer';
    }
    image.replaceWith(replacement);
}

function replaceMediaElementWithLink(element, type) {
    const documentRef = element?.ownerDocument;
    if (!documentRef || typeof element.replaceWith !== 'function') return;
    const source = element.currentSrc
        || element.src
        || element.getAttribute?.('src')
        || element.querySelector?.('source[src]')?.getAttribute('src');
    const href = safePrintUrl(source);
    const label = `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const replacement = documentRef.createElement(href ? 'a' : 'span');
    replacement.className = 'notes-print-media-fallback';
    replacement.textContent = href ? label : `${label} unavailable`;
    if (href) {
        replacement.href = href;
        replacement.rel = 'noopener noreferrer';
    }
    element.replaceWith(replacement);
}

function applyPrintColors(root) {
    root.querySelectorAll?.('[data-text-color]').forEach((element) => {
        const color = printColorFor(element.getAttribute('data-text-color'));
        if (color) element.style.setProperty('color', color, 'important');
    });
    root.querySelectorAll?.('[data-background-color]').forEach((element) => {
        const color = printColorFor(element.getAttribute('data-background-color'), { highlight: true });
        if (color) element.style.setProperty('background-color', color, 'important');
    });
}

function sanitizePrintSurface(root) {
    root.querySelectorAll?.('script, style, iframe, object, embed, button, textarea, select').forEach((element) => element.remove());
    root.querySelectorAll?.('video, audio').forEach((element) => {
        replaceMediaElementWithLink(element, element.tagName.toLowerCase());
    });
    root.querySelectorAll?.('input').forEach((input) => {
        if (input.type === 'checkbox') {
            const marker = input.ownerDocument.createElement('span');
            marker.className = 'notes-print-checkbox';
            marker.textContent = input.checked ? '\u2611' : '\u2610';
            marker.setAttribute('aria-hidden', 'true');
            input.replaceWith(marker);
        } else {
            input.remove();
        }
    });
    root.querySelectorAll?.('a[href]').forEach((anchor) => {
        const href = safePrintUrl(anchor.getAttribute('href'));
        if (!href) {
            anchor.removeAttribute('href');
            return;
        }
        anchor.setAttribute('href', href);
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.removeAttribute('target');
    });
    root.querySelectorAll?.('*').forEach((element) => {
        Array.from(element.attributes || []).forEach((attribute) => {
            if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
        });
        element.removeAttribute?.('contenteditable');
        element.removeAttribute?.('draggable');
    });
    applyPrintColors(root);
}

function waitForImage(image, timeoutMs, timerHost) {
    if (image.complete) return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            timerHost.clearTimeout?.(timer);
            resolve();
        };
        timer = timerHost.setTimeout?.(finish, timeoutMs);
        image.addEventListener?.('load', finish, { once: true });
        image.addEventListener?.('error', finish, { once: true });
        if (!image.addEventListener) finish();
    });
}

export async function waitForPrintableImages(root, {
    timeoutMs = PRINT_IMAGE_TIMEOUT_MS,
    timerHost = globalThis,
} = {}) {
    const images = Array.from(root?.querySelectorAll?.('img') || []);
    await Promise.all(images.map((image) => waitForImage(image, timeoutMs, timerHost)));
    images.forEach((image) => {
        if (!image.complete || !image.naturalWidth) replaceImageWithFallback(image);
    });
}

function clampSideMargins(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(18, Math.max(2, numeric)) : 10;
}

function createPrintSurface({ documentRef, title, html, fontFamily, sideMargins }) {
    documentRef.querySelectorAll?.('.notes-print-surface').forEach((surface) => surface.remove());
    const surface = documentRef.createElement('article');
    surface.className = 'notes-print-surface';
    surface.setAttribute('aria-hidden', 'true');
    surface.style.setProperty('--notes-print-font-family', fontFamily || 'Arial, sans-serif');
    surface.style.setProperty('--notes-print-side-margin', `${clampSideMargins(sideMargins)}%`);

    const heading = documentRef.createElement('h1');
    heading.className = 'notes-print-title';
    heading.textContent = normalizePrintTitle(title);

    const content = documentRef.createElement('section');
    content.className = 'notes-print-content';
    content.innerHTML = html || '';
    sanitizePrintSurface(content);

    surface.append(heading, content);
    documentRef.body.append(surface);
    return surface;
}

function nextPaint(windowRef) {
    return new Promise((resolve) => {
        if (typeof windowRef.requestAnimationFrame === 'function') {
            windowRef.requestAnimationFrame(() => resolve());
        } else {
            windowRef.setTimeout(resolve, 0);
        }
    });
}

async function runPrintNote({
    editor,
    blocks,
    hiddenBlockIds = [],
    title,
    fontFamily,
    sideMargins,
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    imageTimeoutMs = PRINT_IMAGE_TIMEOUT_MS,
}) {
    if (!editor?.blocksToHTMLLossy || !documentRef?.body || typeof windowRef?.print !== 'function') {
        throw new Error('Note printing is unavailable.');
    }

    const printableBlocks = printableBlocksForCurrentView(blocks, hiddenBlockIds);
    const html = await editor.blocksToHTMLLossy(printableBlocks);
    const surface = createPrintSurface({ documentRef, title, html, fontFamily, sideMargins });
    const originalTitle = documentRef.title;
    let cleaned = false;
    let finishPrintLifecycle;
    const printLifecycle = new Promise((resolve) => {
        finishPrintLifecycle = resolve;
    });

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        documentRef.title = originalTitle;
        surface.remove();
        documentRef.body.classList.remove('notes-print-prepared');
        windowRef.removeEventListener?.('afterprint', cleanup);
        windowRef.removeEventListener?.('pagehide', cleanup);
        finishPrintLifecycle();
    };

    documentRef.body.classList.add('notes-print-prepared');
    windowRef.addEventListener?.('afterprint', cleanup, { once: true });
    windowRef.addEventListener?.('pagehide', cleanup, { once: true });

    try {
        await waitForPrintableImages(surface, { timeoutMs: imageTimeoutMs, timerHost: windowRef });
        await nextPaint(windowRef);
        await nextPaint(windowRef);
        documentRef.title = normalizePrintTitle(title);
        windowRef.print();
        await printLifecycle;
    } catch (error) {
        cleanup();
        throw error;
    }
}

export function printNote(options) {
    const windowRef = options?.windowRef || globalThis.window;
    if (windowRef?.[ACTIVE_PRINT_KEY]) return windowRef[ACTIVE_PRINT_KEY];

    const printPromise = runPrintNote(options);
    if (windowRef) windowRef[ACTIVE_PRINT_KEY] = printPromise;
    void printPromise.then(
        () => {
            if (windowRef?.[ACTIVE_PRINT_KEY] === printPromise) delete windowRef[ACTIVE_PRINT_KEY];
        },
        () => {
            if (windowRef?.[ACTIVE_PRINT_KEY] === printPromise) delete windowRef[ACTIVE_PRINT_KEY];
        },
    );
    return printPromise;
}
