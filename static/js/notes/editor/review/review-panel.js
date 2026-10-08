import { escapeHtml } from '../../../core/ui-primitives-module.js';

function requestId() {
    return globalThis.crypto?.randomUUID?.() || `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** @returns {Promise<Record<string, unknown>>} */
async function apiJson(url, options = {}, signal) {
    signal?.throwIfAborted();
    let response;
    try {
        response = await fetch(url, {
            ...options,
            signal,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('Unable to reach Nest. Check your connection and try again.', { cause: error });
    }
    signal?.throwIfAborted();
    if (response.redirected || response.status === 401) {
        throw new Error('Sign in to Nest, then try again.');
    }
    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (response.ok) throw new Error('Nest returned invalid review data. Try again.', { cause: error });
    }
    signal?.throwIfAborted();
    if (!response.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
        throw new Error(message || (response.status === 403
            ? 'You no longer have permission for this review action.'
            : 'Unable to load review data. Try again.'));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Nest returned invalid review data. Try again.');
    }
    return payload;
}

/**
 * @template {'threads'|'suggestions'|'versions'} K
 * @param {Record<string, unknown>} payload
 * @param {K} key
 * @returns {import('./review-contracts.js').ReviewRecords[K]}
 */
function reviewItems(payload, key) {
    const isRecord = (item) => item && typeof item === 'object' && !Array.isArray(item) && item.id != null;
    if (!Array.isArray(payload[key]) || !payload[key].every((item) => (
        isRecord(item) && (key !== 'threads' || item.replies == null
            || (Array.isArray(item.replies) && item.replies.every(isRecord)))
    ))) throw new Error('Nest returned invalid review data. Try again.');
    return /** @type {import('./review-contracts.js').ReviewRecords[K]} */ (payload[key]);
}

function statusBadge(status) {
    return `<span class="notes-review-badge notes-review-badge--${escapeHtml(status || 'open')}">${escapeHtml(status || 'open')}</span>`;
}

/** @param {import('./review-contracts.js').ReviewSuggestion} suggestion */
function suggestionHtml(suggestion, canManageReviews) {
    return `
        <article class="notes-review-card notes-suggestion-card" data-suggestion-id="${escapeHtml(suggestion.id)}">
            <header><strong>${escapeHtml(suggestion.author?.name || 'Reviewer')}</strong>${statusBadge(suggestion.status)}</header>
            <p>${escapeHtml(suggestion.summary || suggestion.operation_kind || 'Suggested change')}</p>
            ${canManageReviews && suggestion.status === 'open' ? `
                <div class="notes-review-card-actions">
                    <button type="button" data-suggestion-action="accept" data-suggestion-id="${escapeHtml(suggestion.id)}">Accept</button>
                    <button type="button" data-suggestion-action="reject" data-suggestion-id="${escapeHtml(suggestion.id)}">Reject</button>
                </div>` : ''}
        </article>`;
}

/** @param {import('./review-contracts.js').CommentReply} reply */
function replyHtml(reply) {
    const deleted = Boolean(reply.deleted_at);
    return `
        <div class="notes-comment-reply${deleted ? ' is-deleted' : ''}" data-reply-id="${escapeHtml(reply.id)}">
            <p><strong>${escapeHtml(reply.author?.name || 'User')}</strong> ${deleted ? '<em>Reply deleted</em>' : escapeHtml(reply.body)}</p>
            ${reply.edited_at && !deleted ? '<small>Edited</small>' : ''}
            ${!deleted && (reply.can_edit || reply.can_delete) ? `<div class="notes-comment-message-actions">
                ${reply.can_edit ? '<button type="button" data-reply-action="edit">Edit</button>' : ''}
                ${reply.can_delete ? '<button type="button" data-reply-action="delete">Delete</button>' : ''}
            </div>` : ''}
        </div>`;
}

/** @param {import('./review-contracts.js').CommentThread} thread */
function commentHtml(thread) {
    const deleted = Boolean(thread.deleted_at);
    const detached = thread.anchor?.state === 'detached';
    return `
        <article class="notes-review-card notes-comment-card${detached ? ' is-detached' : ''}" data-comment-id="${escapeHtml(thread.id)}" tabindex="0">
            <header>
                <span class="notes-comment-author"><i style="--comment-color:${escapeHtml(thread.author?.color || '')}"></i><strong>${escapeHtml(thread.author?.name || 'Commenter')}</strong></span>
                ${statusBadge(detached ? 'detached' : thread.status)}
            </header>
            <p>${deleted ? '<em>Comment deleted</em>' : escapeHtml(thread.body || '')}</p>
            ${thread.edited_at && !deleted ? '<small>Edited</small>' : ''}
            ${thread.anchor?.quoted_text ? `<blockquote>${escapeHtml(thread.anchor.quoted_text)}</blockquote>` : ''}
            ${(thread.replies || []).length ? `<div class="notes-review-replies">${thread.replies.map(replyHtml).join('')}</div>` : ''}
            ${!deleted ? `<form class="notes-review-reply-form" data-comment-reply="${escapeHtml(thread.id)}">
                <input type="text" name="body" placeholder="Reply" maxlength="5000" required>
                <button type="submit">Reply</button>
            </form>` : ''}
            <div class="notes-review-card-actions">
                ${thread.can_edit && !deleted ? '<button type="button" data-comment-action="edit">Edit</button>' : ''}
                ${thread.can_delete && !deleted ? '<button type="button" data-comment-action="delete">Delete</button>' : ''}
                ${thread.can_resolve && !deleted ? `<button type="button" data-comment-action="${thread.status === 'resolved' ? 'reopen' : 'resolve'}">${thread.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>` : ''}
            </div>
        </article>`;
}

/** @param {import('./review-contracts.js').NoteVersion} version */
function versionHtml(version) {
    return `<article class="notes-review-card"><header><strong>${escapeHtml(version.name || version.reason || 'Snapshot')}</strong><small>${escapeHtml(version.created_at || '')}</small></header><p>${escapeHtml(version.actor?.name ? `By ${version.actor.name}` : 'Automatic version')}</p><div class="notes-review-card-actions"><button type="button" data-version-restore="${escapeHtml(version.id)}">Restore</button></div></article>`;
}

function emptyHtml(message) {
    return `<p class="notes-review-empty">${escapeHtml(message)}</p>`;
}

/**
 * @param {Partial<import('./review-contracts.js').ReviewPanelOptions>} options
 * @returns {import('./review-contracts.js').ReviewPanelController|null}
 */
export function bindReviewPanel({
    noteId,
    canReview,
    canManageReviews,
    canViewVersions,
    panel,
    reviewButton,
    historyButton,
    toast,
    captureAnchor,
    onThreads,
    onSelectThread,
    anchorTop,
} = {}) {
    if (!noteId || !panel) return null;
    const title = panel.querySelector('[data-review-panel-title]');
    const body = panel.querySelector('[data-review-panel-body]');
    const closeButton = panel.querySelector('[data-review-panel-close]');
    const lifecycle = new AbortController();
    let loadController = null;
    let mode = 'review';
    let tab = 'comments';
    let filter = 'open';
    /** @type {import('./review-contracts.js').CommentThread[]} */
    let threads = [];
    /** @type {import('./review-contracts.js').CommentAnchor|null} */
    let pendingAnchor = null;
    let activeThreadId = null;
    let hasRenderedContent = false;
    let loadPromise = null;
    let refreshPromise = null;
    let refreshRequested = false;
    let alignmentFrame = null;
    const drafts = new Map();
    const inFlight = new Set();

    function draftKey(field) {
        const form = field.closest('form');
        if (form?.matches('[data-comment-create]')) return 'comment';
        if (form?.matches('[data-comment-reply]')) return `reply:${form.dataset.commentReply}`;
        if (form?.matches('[data-version-create]')) return 'version';
        return null;
    }

    function replaceContent(html) {
        let focusedDraft = null;
        body.querySelectorAll('input[name], textarea[name]').forEach((field) => {
            const key = draftKey(field);
            if (!key) return;
            drafts.set(key, field.value);
            if (field === panel.ownerDocument?.activeElement) {
                focusedDraft = { key, start: field.selectionStart, end: field.selectionEnd };
            }
        });
        body.innerHTML = html;
        body.querySelectorAll('input[name], textarea[name]').forEach((field) => {
            const key = draftKey(field);
            if (!key || !drafts.has(key)) return;
            field.value = drafts.get(key);
            if (key === focusedDraft?.key) {
                field.focus({ preventScroll: true });
                field.setSelectionRange(focusedDraft.start, focusedDraft.end);
            }
        });
    }

    function clearDraft(key, submittedValue) {
        const field = [...body.querySelectorAll('input[name], textarea[name]')].find((item) => draftKey(item) === key);
        const currentValue = field?.value ?? drafts.get(key) ?? '';
        if (String(currentValue).trim() !== submittedValue) return false;
        drafts.delete(key);
        if (field) field.value = '';
        return true;
    }

    function showRequestError(error) {
        if (error.name === 'AbortError' || lifecycle.signal.aborted) return;
        const message = error.message || 'Unable to load review data. Try again.';
        if (!hasRenderedContent) body.innerHTML = emptyHtml(message);
        if (toast?.show) toast.show({ message, type: 'error' });
        else if (hasRenderedContent) {
            let errorNode = body.querySelector('[data-review-error]');
            if (!errorNode) {
                errorNode = panel.ownerDocument.createElement('p');
                errorNode.dataset.reviewError = '';
                errorNode.className = 'notes-review-empty';
                errorNode.setAttribute('role', 'alert');
                body.prepend(errorNode);
            }
            errorNode.textContent = message;
        }
    }

    function visibleThreads() {
        return threads.filter((thread) => {
            if (filter === 'resolved') return thread.status === 'resolved';
            if (filter === 'detached') return thread.anchor?.state === 'detached';
            return thread.status === 'open' && thread.anchor?.state !== 'detached' && !thread.deleted_at;
        });
    }

    function alignCards() {
        if (lifecycle.signal.aborted || panel.hidden) return;
        if (window.innerWidth < 1180 || tab !== 'comments') return;
        let previousBottom = 0;
        panel.querySelectorAll('[data-comment-id]').forEach((card) => {
            const thread = threads.find((item) => String(item.id) === card.dataset.commentId);
            const top = anchorTop?.(thread);
            if (!Number.isFinite(top)) return;
            const desired = Math.max(0, top - panel.getBoundingClientRect().top - 80);
            const offset = Math.max(desired, previousBottom);
            card.style.marginTop = `${Math.max(0, offset - previousBottom)}px`;
            previousBottom = offset + card.offsetHeight + 10;
        });
    }

    function renderComments() {
        const visible = visibleThreads();
        title.textContent = 'Review';
        replaceContent(`
            <div class="notes-review-tabs" role="tablist">
                <button type="button" role="tab" data-review-tab="comments" aria-selected="true">Comments</button>
                <button type="button" role="tab" data-review-tab="suggestions" aria-selected="false">Suggestions</button>
            </div>
            <div class="notes-review-filters" aria-label="Comment filters">
                ${['open', 'resolved', 'detached'].map((value) => `<button type="button" data-review-filter="${value}" class="${filter === value ? 'is-active' : ''}">${value[0].toUpperCase()}${value.slice(1)}</button>`).join('')}
            </div>
            ${pendingAnchor ? `<form class="notes-review-new-comment" data-comment-create>
                ${pendingAnchor.quoted_text ? `<blockquote>${escapeHtml(pendingAnchor.quoted_text)}</blockquote>` : ''}
                <textarea name="body" rows="3" maxlength="5000" placeholder="Add a comment" required autofocus></textarea>
                <div><button type="button" data-comment-cancel>Cancel</button><button type="submit">Comment</button></div>
                <p class="notes-comment-form-error" data-comment-error hidden></p>
            </form>` : ''}
            <section class="notes-review-section notes-comment-thread-list">
                ${visible.length ? visible.map(commentHtml).join('') : emptyHtml(`No ${filter} comments.`)}
            </section>`);
        hasRenderedContent = true;
        if (alignmentFrame !== null) window.cancelAnimationFrame(alignmentFrame);
        alignmentFrame = requestAnimationFrame(() => {
            alignmentFrame = null;
            alignCards();
        });
    }

    async function renderSuggestions(signal = lifecycle.signal) {
        const payload = await apiJson(`/api/notes/${encodeURIComponent(noteId)}/suggestions`, {}, signal);
        const suggestions = reviewItems(payload, 'suggestions');
        if (signal.aborted) return;
        title.textContent = 'Review';
        replaceContent(`
            <div class="notes-review-tabs" role="tablist">
                <button type="button" role="tab" data-review-tab="comments" aria-selected="false">Comments</button>
                <button type="button" role="tab" data-review-tab="suggestions" aria-selected="true">Suggestions</button>
            </div>
            <section class="notes-review-section">${suggestions.length ? suggestions.map((item) => suggestionHtml(item, canManageReviews)).join('') : emptyHtml('No suggestions yet.')}</section>`);
        hasRenderedContent = true;
    }

    async function loadComments(signal = lifecycle.signal) {
        const payload = await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments`, {}, signal);
        const nextThreads = reviewItems(payload, 'threads');
        if (signal.aborted) return;
        threads = nextThreads;
        onThreads?.(threads, activeThreadId);
        renderComments();
    }

    function renderReview() {
        if (!canReview || lifecycle.signal.aborted) return;
        loadController?.abort();
        loadController = new AbortController();
        if (!hasRenderedContent) body.innerHTML = emptyHtml('Loading review activity...');
        const signal = loadController.signal;
        loadPromise = (async () => {
            try {
                if (tab === 'suggestions') await renderSuggestions(signal);
                else await loadComments(signal);
            } catch (error) { showRequestError(error); }
        })().finally(() => { if (loadController?.signal === signal) loadPromise = null; });
        return loadPromise;
    }

    function renderHistory() {
        if (!canViewVersions || lifecycle.signal.aborted) return;
        loadController?.abort();
        loadController = new AbortController();
        if (!hasRenderedContent) body.innerHTML = emptyHtml('Loading versions...');
        const signal = loadController.signal;
        loadPromise = (async () => { try {
            const payload = await apiJson(`/api/notes/${encodeURIComponent(noteId)}/versions`, {}, signal);
            const versions = reviewItems(payload, 'versions');
            if (signal.aborted) return;
            title.textContent = 'Version history';
            replaceContent(`<section class="notes-review-section"><h3>Snapshots</h3>${versions.length ? versions.map(versionHtml).join('') : emptyHtml('No versions yet.')}</section><form class="notes-review-new-version" data-version-create><input type="text" name="name" placeholder="Snapshot name"><button type="submit">Create snapshot</button></form>`);
            hasRenderedContent = true;
        } catch (error) { showRequestError(error); } })()
            .finally(() => { if (loadController?.signal === signal) loadPromise = null; });
        return loadPromise;
    }

    function refresh() {
        if (lifecycle.signal.aborted || panel.hidden) return Promise.resolve();
        refreshRequested = true;
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async () => {
            // Keep the initial open or tab request alive. A burst of remote
            // events requires at most one subsequent request per pending load.
            if (loadPromise) await loadPromise;
            while (refreshRequested && !lifecycle.signal.aborted && !panel.hidden) {
                refreshRequested = false;
                if (mode === 'history') await renderHistory();
                else await renderReview();
            }
        })().finally(() => { refreshPromise = null; });
        return refreshPromise;
    }

    async function open(nextMode = 'review') {
        if (lifecycle.signal.aborted) return;
        mode = nextMode;
        panel.hidden = false;
        panel.dataset.mode = mode;
        if (mode === 'history') await renderHistory();
        else await renderReview();
    }

    function close() { panel.hidden = true; }

    function startComment(anchor = captureAnchor?.()) {
        if (!canReview) return;
        pendingAnchor = anchor || { kind: 'document', state: 'detached', version: 1 };
        tab = 'comments';
        filter = 'open';
        void open('review').then(() => {
            if (!lifecycle.signal.aborted && !panel.hidden) body.querySelector('[data-comment-create] textarea')?.focus();
        });
    }

    function selectThread(id) {
        activeThreadId = String(id || '');
        onThreads?.(threads, activeThreadId);
        const thread = threads.find((item) => String(item.id) === activeThreadId);
        if (thread) onSelectThread?.(thread);
        panel.querySelectorAll('[data-comment-id]').forEach((card) => card.classList.toggle('is-active', card.dataset.commentId === activeThreadId));
    }

    async function perform(key, action) {
        if (lifecycle.signal.aborted || inFlight.has(key)) return;
        inFlight.add(key);
        try { await action(); }
        catch (error) { showRequestError(error); }
        finally { inFlight.delete(key); }
    }

    function handleClick(event) {
        const tabButton = event.target.closest('[data-review-tab]');
        if (tabButton) { tab = tabButton.dataset.reviewTab; void renderReview(); return; }
        const filterButton = event.target.closest('[data-review-filter]');
        if (filterButton) { filter = filterButton.dataset.reviewFilter; renderComments(); return; }
        if (event.target.closest('[data-comment-cancel]')) { pendingAnchor = null; renderComments(); drafts.delete('comment'); return; }
        const card = event.target.closest('[data-comment-id]');
        if (card && !event.target.closest('button,input,form')) selectThread(card.dataset.commentId);
        const suggestionAction = event.target.closest('[data-suggestion-action]');
        if (suggestionAction) void perform(`suggestion:${suggestionAction.dataset.suggestionId}`, async () => {
            await apiJson(`/api/notes/${encodeURIComponent(noteId)}/suggestions/${encodeURIComponent(suggestionAction.dataset.suggestionId)}/${suggestionAction.dataset.suggestionAction}`, { method: 'POST', body: '{}' }, lifecycle.signal);
            toast?.show?.({ message: 'Suggestion updated.', type: 'success' });
            await renderReview();
        });
        const actionButton = event.target.closest('[data-comment-action]');
        if (actionButton && card) void perform(`comment:${card.dataset.commentId}`, async () => {
            const action = actionButton.dataset.commentAction;
            if (action === 'edit') {
                const current = threads.find((item) => String(item.id) === card.dataset.commentId);
                const value = window.prompt('Edit comment', current?.body || '');
                if (value == null) return;
                await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(card.dataset.commentId)}`, { method: 'PATCH', body: JSON.stringify({ body: value }) }, lifecycle.signal);
            } else if (action === 'delete') {
                if (!window.confirm('Delete this comment?')) return;
                await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(card.dataset.commentId)}`, { method: 'DELETE', body: '{}' }, lifecycle.signal);
            } else {
                await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(card.dataset.commentId)}/${action}`, { method: 'POST', body: '{}' }, lifecycle.signal);
            }
            await loadComments();
        });
        const replyAction = event.target.closest('[data-reply-action]');
        const reply = replyAction?.closest('[data-reply-id]');
        if (replyAction && reply && card) void perform(`reply:${reply.dataset.replyId}`, async () => {
            const url = `/api/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(card.dataset.commentId)}/replies/${encodeURIComponent(reply.dataset.replyId)}`;
            if (replyAction.dataset.replyAction === 'delete') {
                if (!window.confirm('Delete this reply?')) return;
                await apiJson(url, { method: 'DELETE', body: '{}' }, lifecycle.signal);
            } else {
                const thread = threads.find((item) => String(item.id) === card.dataset.commentId);
                const current = thread?.replies?.find((item) => String(item.id) === reply.dataset.replyId);
                const value = window.prompt('Edit reply', current?.body || '');
                if (value == null) return;
                await apiJson(url, { method: 'PATCH', body: JSON.stringify({ body: value }) }, lifecycle.signal);
            }
            await loadComments();
        });
        const versionRestore = event.target.closest('[data-version-restore]');
        if (versionRestore && window.confirm('Restore this note version? A snapshot of the current state will be kept.')) void perform('restore', async () => {
            await apiJson(`/api/notes/${encodeURIComponent(noteId)}/versions/${encodeURIComponent(versionRestore.dataset.versionRestore)}/restore`, { method: 'POST', body: '{}' }, lifecycle.signal);
            window.location.reload();
        });
    }

    function handleSubmit(event) {
        const commentCreate = event.target.closest('[data-comment-create]');
        const commentReply = event.target.closest('[data-comment-reply]');
        const versionCreate = event.target.closest('[data-version-create]');
        if (!commentCreate && !commentReply && !versionCreate) return;
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        const bodyValue = String(formData.get('body') || '').trim();
        const key = `submit:${commentReply?.dataset.commentReply || (commentCreate ? 'new' : 'version')}`;
        void perform(key, async () => {
            const submit = form.querySelector('[type="submit"]');
            if (submit) submit.disabled = true;
            try {
                if (commentCreate) {
                    await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments`, { method: 'POST', body: JSON.stringify({ body: bodyValue, anchor: pendingAnchor, client_request_id: requestId() }) }, lifecycle.signal);
                    const submittedDraftCleared = clearDraft('comment', bodyValue);
                    if (submittedDraftCleared) pendingAnchor = null;
                    await loadComments();
                    if (submittedDraftCleared) drafts.delete('comment');
                } else if (commentReply) {
                    await apiJson(`/api/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(commentReply.dataset.commentReply)}/replies`, { method: 'POST', body: JSON.stringify({ body: bodyValue, client_request_id: requestId() }) }, lifecycle.signal);
                    clearDraft(`reply:${commentReply.dataset.commentReply}`, bodyValue);
                    await loadComments();
                } else {
                    const name = String(formData.get('name') || '').trim() || 'Manual snapshot';
                    await apiJson(`/api/notes/${encodeURIComponent(noteId)}/versions`, { method: 'POST', body: JSON.stringify({ name }) }, lifecycle.signal);
                    clearDraft('version', String(formData.get('name') || '').trim());
                    await renderHistory();
                }
            } catch (error) {
                const errorNode = form.querySelector('[data-comment-error]');
                if (errorNode) { errorNode.textContent = error.message; errorNode.hidden = false; }
                else throw error;
            } finally {
                if (submit) submit.disabled = false;
            }
        });
    }

    const options = { signal: lifecycle.signal };
    reviewButton?.addEventListener('click', () => open('review'), options);
    historyButton?.addEventListener('click', () => open('history'), options);
    closeButton?.addEventListener('click', close, options);
    panel.addEventListener('click', handleClick, options);
    panel.addEventListener('submit', handleSubmit, options);
    window.addEventListener('resize', alignCards, options);
    window.addEventListener('scroll', alignCards, { ...options, passive: true });

    return {
        open,
        close,
        startComment,
        selectThread,
        refresh,
        refreshDecorations: () => onThreads?.(threads, activeThreadId),
        destroy() {
            if (lifecycle.signal.aborted) return;
            refreshRequested = false;
            loadController?.abort();
            lifecycle.abort();
            if (alignmentFrame !== null) window.cancelAnimationFrame(alignmentFrame);
            alignmentFrame = null;
            drafts.clear();
            panel.hidden = true;
            onThreads?.([], null);
        },
    };
}
