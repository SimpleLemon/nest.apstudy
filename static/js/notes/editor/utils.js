export function noteIdFromPath(pathname = window.location.pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const editorIndex = parts.indexOf('editor');
    if (editorIndex !== -1) return parts[editorIndex + 1] || '';
    if (parts[0] === 'notes' && parts[1] && parts[1] !== 'folders') return parts[1];
    return '';
}

export function handlePageSetupToolbarClick(event, toolbar, openPageSetupPopover) {
    const actionButton = event?.target?.closest?.('button[data-editor-action="page-setup"]');
    if (!actionButton || !toolbar?.contains?.(actionButton)) return false;
    event.preventDefault?.();
    openPageSetupPopover(actionButton);
    return true;
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
