(function registerNotesSharing(global) {
    let activeModal = null;
    let returnFocus = null;
    let searchTimer = null;

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function apiJson(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Unable to update sharing.');
        return payload;
    }

    function endpointFor(resourceType, resourceId) {
        const encoded = encodeURIComponent(resourceId);
        return resourceType === 'folder'
            ? `/api/notes/folders/${encoded}/sharing`
            : `/api/notes/${encoded}/sharing`;
    }

    function close() {
        if (!activeModal) return;
        activeModal.remove();
        activeModal = null;
        clearTimeout(searchTimer);
        document.body.classList.remove('notes-modal-open');
        returnFocus?.focus?.({ preventScroll: true });
        returnFocus = null;
    }

    async function copyText(value) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const input = document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
    }

    function renderSelected(modal, users) {
        const list = modal.querySelector('[data-share-selected]');
        if (!list) return;
        list.innerHTML = users.length ? users.map((user) => `
            <div class="notes-share-person" data-selected-user="${escapeHtml(user.id)}">
                ${user.picture_url ? `<img src="${escapeHtml(user.picture_url)}" alt="" loading="lazy">` : '<span class="material-symbols-outlined" aria-hidden="true">account_circle</span>'}
                <span class="notes-share-person-copy">
                    <strong>${escapeHtml(user.name || user.username || 'Nest User')}</strong>
                    <small>${escapeHtml(user.username ? `@${user.username}` : 'Nest user')}</small>
                </span>
                <span class="notes-share-role">Viewer</span>
                <button type="button" class="notes-share-remove" data-remove-user="${escapeHtml(user.id)}" aria-label="Remove ${escapeHtml(user.name || user.username || 'user')}">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
        `).join('') : '<p class="notes-share-empty">No people have access yet.</p>';
    }

    function renderSearchResults(modal, results, selectedIds) {
        const container = modal.querySelector('[data-share-results]');
        if (!container) return;
        const available = results.filter((user) => !selectedIds.has(String(user.id)));
        container.hidden = false;
        container.innerHTML = available.length ? available.map((user) => `
            <button type="button" class="notes-share-result" data-add-user="${escapeHtml(user.id)}">
                ${user.picture_url ? `<img src="${escapeHtml(user.picture_url)}" alt="" loading="lazy">` : '<span class="material-symbols-outlined" aria-hidden="true">account_circle</span>'}
                <span>
                    <strong>${escapeHtml(user.name || user.username || 'Nest User')}</strong>
                    <small>${escapeHtml(user.username ? `@${user.username}` : 'Nest user')}</small>
                </span>
            </button>
        `).join('') : '<p class="notes-share-empty">No matching users.</p>';
    }

    function setError(modal, message = '') {
        const error = modal.querySelector('[data-share-error]');
        if (!error) return;
        error.textContent = message;
        error.hidden = !message;
    }

    function buildModal(resourceType, resourceId, resourceTitle, sharing, onSaved) {
        const users = [...(sharing.users || [])];
        const modal = document.createElement('div');
        modal.className = 'notes-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'notes-share-title');
        modal.innerHTML = `
            <div class="notes-modal-panel notes-share-panel">
                <header class="notes-modal-header">
                    <div>
                        <h2 id="notes-share-title">Share ${escapeHtml(resourceTitle || (resourceType === 'folder' ? 'folder' : 'note'))}</h2>
                        <p>Anyone you add receives view-only access.</p>
                    </div>
                    <button type="button" class="notes-icon-button" data-share-close aria-label="Close sharing">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <label class="notes-field notes-share-general">
                    <span>General access</span>
                    <select data-share-public>
                        <option value="restricted" ${sharing.public ? '' : 'selected'}>Restricted</option>
                        <option value="public" ${sharing.public ? 'selected' : ''}>Anyone with the link</option>
                    </select>
                </label>
                <div class="notes-share-link-row">
                    <input type="text" readonly value="${escapeHtml(sharing.share_url || '')}" data-share-url aria-label="Share link">
                    <button type="button" class="btn-secondary" data-share-copy>Copy link</button>
                </div>
                <div class="notes-share-people">
                    <label class="notes-field">
                        <span>People with access</span>
                        <input type="search" autocomplete="off" placeholder="Search by name or @username" data-share-search>
                    </label>
                    <div class="notes-share-results" data-share-results hidden></div>
                    <div class="notes-share-selected" data-share-selected></div>
                </div>
                <div class="notes-form-error" data-share-error role="alert" hidden></div>
                <footer class="notes-modal-actions">
                    <button type="button" class="btn-secondary" data-share-close>Cancel</button>
                    <button type="button" class="btn-primary" data-share-save>Save</button>
                </footer>
            </div>
        `;
        renderSelected(modal, users);

        modal.addEventListener('mousedown', (event) => {
            if (event.target === modal) close();
        });
        modal.addEventListener('click', async (event) => {
            if (event.target.closest('[data-share-close]')) {
                close();
                return;
            }
            const remove = event.target.closest('[data-remove-user]');
            if (remove) {
                const index = users.findIndex((user) => String(user.id) === remove.dataset.removeUser);
                if (index >= 0) users.splice(index, 1);
                renderSelected(modal, users);
                return;
            }
            const add = event.target.closest('[data-add-user]');
            if (add) {
                const results = modal._shareSearchResults || [];
                const user = results.find((entry) => String(entry.id) === add.dataset.addUser);
                if (user && !users.some((entry) => String(entry.id) === String(user.id))) users.push(user);
                renderSelected(modal, users);
                modal.querySelector('[data-share-results]').hidden = true;
                modal.querySelector('[data-share-search]').value = '';
                return;
            }
            if (event.target.closest('[data-share-copy]')) {
                try {
                    await copyText(sharing.share_url || '');
                    global.APStudyToast?.show?.({ message: 'Share link copied.', type: 'success' });
                } catch {
                    setError(modal, 'Unable to copy the link.');
                }
                return;
            }
            const save = event.target.closest('[data-share-save]');
            if (!save) return;
            save.disabled = true;
            setError(modal);
            try {
                const updated = await apiJson(endpointFor(resourceType, resourceId), {
                    method: 'PATCH',
                    body: JSON.stringify({
                        public: modal.querySelector('[data-share-public]').value === 'public',
                        user_ids: users.map((user) => user.id),
                    }),
                });
                onSaved?.(updated);
                global.APStudyToast?.show?.({ message: 'Sharing updated.', type: 'success' });
                close();
            } catch (error) {
                setError(modal, error.message || 'Unable to update sharing.');
                save.disabled = false;
            }
        });

        const search = modal.querySelector('[data-share-search]');
        search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            const query = search.value.trim();
            const results = modal.querySelector('[data-share-results]');
            if (query.length < 2) {
                results.hidden = true;
                results.innerHTML = '';
                return;
            }
            searchTimer = setTimeout(async () => {
                try {
                    const payload = await apiJson(`/api/notes/share-users?q=${encodeURIComponent(query)}`);
                    modal._shareSearchResults = payload.results || [];
                    renderSearchResults(modal, modal._shareSearchResults, new Set(users.map((user) => String(user.id))));
                } catch (error) {
                    results.hidden = false;
                    results.innerHTML = `<p class="notes-share-empty">${escapeHtml(error.message)}</p>`;
                }
            }, 250);
        });
        return modal;
    }

    async function open({ resourceType, resourceId, resourceTitle, onSaved } = {}) {
        if (!resourceId || !['note', 'folder'].includes(resourceType)) return;
        close();
        returnFocus = document.activeElement;
        try {
            const sharing = await apiJson(endpointFor(resourceType, resourceId));
            activeModal = buildModal(resourceType, resourceId, resourceTitle, sharing, onSaved);
            document.body.appendChild(activeModal);
            document.body.classList.add('notes-modal-open');
            activeModal.querySelector('[data-share-search]')?.focus({ preventScroll: true });
        } catch (error) {
            global.APStudyToast?.show?.({ message: error.message || 'Unable to load sharing.', type: 'error' });
        }
    }

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-notes-share-resource]');
        if (!trigger) return;
        event.preventDefault();
        event.stopPropagation();
        void open({
            resourceType: trigger.dataset.notesShareResource,
            resourceId: trigger.dataset.resourceId,
            resourceTitle: trigger.dataset.resourceTitle,
        });
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeModal) close();
    });

    global.APStudyNotesSharing = { open, close };
})(window);
