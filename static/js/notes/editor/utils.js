export function noteIdFromPath(pathname = window.location.pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const editorIndex = parts.indexOf('editor');
    if (editorIndex !== -1) return parts[editorIndex + 1] || '';
    if (parts[0] === 'notes' && parts[1] && parts[1] !== 'folders') return parts[1];
    return '';
}

export function handlePageSetupTriggerClick(event, trigger, popover, openPageSetupPopover, closePageSetupPopover) {
    if (!trigger || !popover) return false;
    const triggerRect = trigger.getBoundingClientRect?.() || null;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (popover.hidden) {
        openPageSetupPopover(trigger, triggerRect);
    } else {
        closePageSetupPopover();
    }
    return true;
}

export function handlePageSetupToolbarClick(event, toolbar, popover, openPageSetupPopover, closePageSetupPopover) {
    const trigger = event?.target?.closest?.('button[data-editor-action="page-setup"]');
    if (!trigger || !toolbar?.contains?.(trigger)) return false;
    return handlePageSetupTriggerClick(
        event,
        trigger,
        popover,
        openPageSetupPopover,
        closePageSetupPopover
    );
}

export function claimElementBinding(element, bindingName) {
    if (!element || !bindingName) return false;
    const attribute = `data-${String(bindingName).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    if (element.getAttribute?.(attribute) === 'true') return false;
    element.setAttribute?.(attribute, 'true');
    return true;
}

export function floatingPopoverPosition({
    triggerRect,
    popoverRect,
    boundaryRect = null,
    viewportWidth = window.innerWidth,
    viewportHeight = window.innerHeight,
    gap = 6,
    margin = 8,
} = {}) {
    if (!triggerRect || !popoverRect) return { left: margin, top: margin };

    const boundaryLeft = Math.max(margin, (boundaryRect?.left ?? 0) + margin);
    const boundaryRight = Math.min(viewportWidth - margin, (boundaryRect?.right ?? viewportWidth) - margin);
    const maxLeft = Math.max(boundaryLeft, boundaryRight - popoverRect.width);
    const left = Math.min(maxLeft, Math.max(boundaryLeft, triggerRect.left));

    const below = triggerRect.bottom + gap;
    const above = triggerRect.top - popoverRect.height - gap;
    const preferredTop = below + popoverRect.height <= viewportHeight - margin || above < margin
        ? below
        : above;
    const maxTop = Math.max(margin, viewportHeight - margin - popoverRect.height);
    const top = Math.min(maxTop, Math.max(margin, preferredTop));

    return { left, top };
}

export function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
    return window.APStudyLoader.html(label, options);
}

export function parseSavedDate(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatRelativeSavedTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds} sec ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes} min ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours} hr ago`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) {
        return `${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
    }

    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    });
}

export function blockOwnContentIsEmpty(block) {
    if (!block || !Array.isArray(block.content)) return false;
    if (block.content.length === 0) return true;

    return block.content.every((item) => {
        if (!item) return true;
        if (typeof item === 'string') return item.trim() === '';
        if (typeof item.text === 'string') return item.text.trim() === '';
        return false;
    });
}

export function blockText(block) {
    if (!block) return '';
    const ownText = Array.isArray(block.content)
        ? block.content.map((item) => item?.text || '').join(' ')
        : '';
    const childText = Array.isArray(block.children)
        ? block.children.map(blockText).join(' ')
        : '';
    return `${ownText} ${childText}`.trim();
}

export function documentHasText(documentValue) {
    return Array.isArray(documentValue)
        && documentValue.some((block) => blockText(block).trim().length > 0);
}

export function isBlankTitle(title) {
    const value = String(title || '').trim();
    return value === '' || value.toLowerCase() === 'untitled';
}
