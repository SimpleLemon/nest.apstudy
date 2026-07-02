(function registerNotesSharing(global) {
    const ROLE_OPTIONS = [
        { value: 'viewer', label: 'Viewer', icon: 'visibility', description: 'Can view live content.' },
        { value: 'reviewer', label: 'Reviewer', icon: 'rate_review', description: 'Can comment and suggest changes.' },
        { value: 'editor', label: 'Editor', icon: 'edit', description: 'Can edit and manage sharing.' },
    ];
    const GENERAL_ACCESS_OPTIONS = [
        { value: 'restricted', label: 'Restricted', icon: 'lock', description: 'Only people with access can open this.' },
        { value: 'public', label: 'Anyone with the link', icon: 'link', description: 'Anyone with the link can view.' },
    ];
    const VALID_ROLES = new Set(ROLE_OPTIONS.map((role) => role.value));
    let activeModal = null;
    let returnFocus = null;
    let searchTimer = null;
    let menuSequence = 0;

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeRole(value) {
        const role = String(value || 'viewer').toLowerCase();
        return VALID_ROLES.has(role) ? role : 'viewer';
    }

    function roleLabel(role) {
        return ROLE_OPTIONS.find((option) => option.value === normalizeRole(role))?.label || 'Viewer';
    }

    function selectionMenuHtml({ selectedValue, options, attrs = '', ariaLabel = 'Choose an option', compact = false }) {
        const selected = options.find((option) => option.value === selectedValue) || options[0];
        const menuId = `notes-share-menu-${++menuSequence}`;
        return `
            <div class="notes-share-menu${compact ? ' notes-share-menu--compact' : ''}" data-share-menu data-share-menu-value="${escapeHtml(selected.value)}" ${attrs}>
                <button type="button" class="notes-share-menu-trigger" data-share-menu-trigger aria-haspopup="listbox" aria-expanded="false" aria-controls="${menuId}" aria-label="${escapeHtml(ariaLabel)}">
                    <span class="material-symbols-outlined notes-share-menu-trigger-icon" data-share-menu-icon aria-hidden="true">${escapeHtml(selected.icon)}</span>
                    <span data-share-menu-label>${escapeHtml(selected.label)}</span>
                    <span class="material-symbols-outlined notes-share-menu-chevron" aria-hidden="true">expand_more</span>
                </button>
                <div class="notes-share-menu-popover" id="${menuId}" data-share-menu-popover role="listbox" aria-label="${escapeHtml(ariaLabel)}" hidden>
                    ${options.map((option) => `
                        <button type="button" class="notes-share-menu-option${option.value === selected.value ? ' is-selected' : ''}" data-share-menu-option="${escapeHtml(option.value)}" role="option" aria-selected="${option.value === selected.value ? 'true' : 'false'}" tabindex="-1">
                            <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(option.icon)}</span>
                            <span class="notes-share-menu-option-copy">
                                <strong>${escapeHtml(option.label)}</strong>
                                <small>${escapeHtml(option.description)}</small>
                            </span>
                            <span class="material-symbols-outlined notes-share-menu-check" aria-hidden="true">check</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function roleMenuHtml(selectedRole, attrs = '', ariaLabel = 'Choose a role') {
        return selectionMenuHtml({
            selectedValue: normalizeRole(selectedRole),
            options: ROLE_OPTIONS,
            attrs,
            ariaLabel,
            compact: true,
        });
    }

    function closeShareMenus(modal, except = null) {
        modal.querySelectorAll('[data-share-menu]').forEach((menu) => {
            if (menu === except) return;
            menu.querySelector('[data-share-menu-popover]')?.setAttribute('hidden', '');
            menu.querySelector('[data-share-menu-trigger]')?.setAttribute('aria-expanded', 'false');
        });
    }

    function setShareMenuOpen(modal, menu, open) {
        closeShareMenus(modal, open ? menu : null);
        const popover = menu.querySelector('[data-share-menu-popover]');
        const trigger = menu.querySelector('[data-share-menu-trigger]');
        if (!popover || !trigger) return;
        popover.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        if (open) {
            const selected = popover.querySelector('[aria-selected="true"]') || popover.querySelector('[data-share-menu-option]');
            selected?.focus({ preventScroll: true });
        }
    }

    function updateShareMenu(menu, value, options) {
        const selected = options.find((option) => option.value === value) || options[0];
        menu.dataset.shareMenuValue = selected.value;
        const icon = menu.querySelector('[data-share-menu-icon]');
        const label = menu.querySelector('[data-share-menu-label]');
        if (icon) icon.textContent = selected.icon;
        if (label) label.textContent = selected.label;
        menu.querySelectorAll('[data-share-menu-option]').forEach((option) => {
            const isSelected = option.dataset.shareMenuOption === selected.value;
            option.classList.toggle('is-selected', isSelected);
            option.setAttribute('aria-selected', String(isSelected));
        });
        return selected.value;
    }

    function initialsFor(value) {
        const words = String(value || 'Nest User').trim().split(/\s+/).filter(Boolean);
        return words.slice(0, 2).map((word) => word[0]?.toUpperCase() || '').join('') || 'N';
    }

    async function apiJson(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || 'Unable to update sharing.');
            error.payload = payload;
            error.status = response.status;
            throw error;
        }
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

    function avatarHtml(person) {
        if (person?.picture_url) {
            return `<img src="${escapeHtml(person.picture_url)}" alt="" loading="lazy">`;
        }
        return `<span class="notes-share-initials" aria-hidden="true">${escapeHtml(initialsFor(person?.name || person?.username))}</span>`;
    }

    function renderSelected(modal, users) {
        const list = modal.querySelector('[data-share-selected]');
        if (!list) return;
        list.innerHTML = users.map((user) => `
            <div class="notes-share-person" data-selected-user="${escapeHtml(user.id)}">
                ${avatarHtml(user)}
                <span class="notes-share-person-copy">
                    <strong>${escapeHtml(user.name || user.username || 'Nest User')}</strong>
                    <small>${escapeHtml(user.username ? `@${user.username}` : 'Nest user')}</small>
                </span>
                ${roleMenuHtml(user.role, `data-user-role="${escapeHtml(user.id)}"`, `Role for ${user.name || user.username || 'user'}`)}
                <button type="button" class="notes-share-remove" data-remove-user="${escapeHtml(user.id)}" aria-label="Remove ${escapeHtml(user.name || user.username || 'user')}">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
        `).join('');
        syncAccessSections(modal, users, modal._sharePending || []);
    }

    function renderPending(modal, pending) {
        const list = modal.querySelector('[data-share-pending]');
        if (!list) return;
        list.innerHTML = pending.map((invite) => `
            <div class="notes-share-person notes-share-person--pending" data-pending-email="${escapeHtml(invite.email)}">
                <span class="notes-share-pending-icon material-symbols-outlined" aria-hidden="true">schedule</span>
                <span class="notes-share-person-copy">
                    <strong>${escapeHtml(invite.email)}</strong>
                    <small>Pending · expires ${escapeHtml(invite.expires_at || 'in 7 days')}</small>
                </span>
                ${roleMenuHtml(invite.role, `data-pending-role="${escapeHtml(invite.email)}"`, `Pending role for ${invite.email}`)}
                <button type="button" class="notes-share-remove" data-remove-pending="${escapeHtml(invite.email)}" aria-label="Remove pending invitation for ${escapeHtml(invite.email)}">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
        `).join('');
        syncAccessSections(modal, modal._shareUsers || [], pending);
    }

    function renderInherited(modal, inherited) {
        const list = modal.querySelector('[data-share-inherited]');
        if (!list) return;
        list.innerHTML = inherited.map((entry) => `
            <div class="notes-share-person notes-share-person--inherited">
                ${entry.id === '*' ? '<span class="material-symbols-outlined" aria-hidden="true">link</span>' : avatarHtml(entry)}
                <span class="notes-share-person-copy">
                    <strong>${escapeHtml(entry.name || entry.username || 'Inherited access')}</strong>
                    <small>${escapeHtml(roleLabel(entry.role))} from ${escapeHtml(entry.source_label || 'folder')}</small>
                </span>
                <span class="notes-share-role">${escapeHtml(roleLabel(entry.role))}</span>
            </div>
        `).join('');
    }

    function syncAccessSections(modal, users, pending) {
        const directSection = modal.querySelector('[data-share-section="direct"]');
        const pendingSection = modal.querySelector('[data-share-section="pending"]');
        const emptyState = modal.querySelector('[data-share-empty-state]');
        const directCount = modal.querySelector('[data-share-direct-count]');
        const pendingCount = modal.querySelector('[data-share-pending-count]');
        if (directSection) directSection.hidden = users.length === 0;
        if (pendingSection) pendingSection.hidden = pending.length === 0;
        if (directCount) directCount.textContent = String(users.length);
        if (pendingCount) pendingCount.textContent = String(pending.length);
        if (!emptyState) return;
        emptyState.hidden = users.length > 0 || pending.length > 0;
        const title = emptyState.querySelector('[data-share-empty-title]');
        if (title) {
            title.textContent = modal._shareInherited?.length
                ? 'No direct access added'
                : (modal._sharePublic ? 'No people added yet' : 'Only you have access');
        }
    }

    function renderSearchResults(modal, results, selectedIds, emailState) {
        const container = modal.querySelector('[data-share-results]');
        if (!container) return;
        modal._shareEmailState = emailState;
        const available = results.filter((user) => !selectedIds.has(String(user.id)));
        container.hidden = false;
        const resultHtml = available.map((user) => `
            <button type="button" class="notes-share-result" data-add-user="${escapeHtml(user.id)}">
                ${avatarHtml(user)}
                <span>
                    <strong>${escapeHtml(user.name || user.username || 'Nest User')}</strong>
                    <small>${escapeHtml(user.username ? `@${user.username}` : 'Nest user')} · add as ${escapeHtml(roleLabel(modal._shareAddRole))}</small>
                </span>
            </button>
        `).join('');
        const emailHtml = emailState?.status === 'unmatched' ? `
            <button type="button" class="notes-share-result notes-share-result--email" data-add-email="${escapeHtml(emailState.query)}">
                <span class="material-symbols-outlined" aria-hidden="true">alternate_email</span>
                <span>
                    <strong>${escapeHtml(emailState.query)}</strong>
                    <small>${escapeHtml(emailState.warning || 'Invite by email. Recipient must sign up with this OAuth email.')}</small>
                </span>
            </button>
        ` : '';
        container.innerHTML = resultHtml || emailHtml
            ? `${resultHtml}${emailHtml}`
            : '<p class="notes-share-empty">No matching users.</p>';
    }

    function setError(modal, message = '') {
        const error = modal.querySelector('[data-share-error]');
        if (!error) return;
        error.textContent = message;
        error.hidden = !message;
    }

    function buildModal(resourceType, resourceId, resourceTitle, sharing, onSaved) {
        const users = [...(sharing.users || [])].map((user) => ({ ...user, role: normalizeRole(user.role) }));
        const pending = [...(sharing.pending_invitations || [])].map((invite) => ({ ...invite, role: normalizeRole(invite.role) }));
        const inherited = [...(sharing.inherited || [])];
        const modal = document.createElement('div');
        modal.className = 'notes-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'notes-share-title');
        modal._shareAddRole = 'viewer';
        modal._sharePublic = sharing.public === true;
        modal._shareUsers = users;
        modal._sharePending = pending;
        modal._shareInherited = inherited;
        modal.innerHTML = `
            <div class="notes-modal-panel notes-share-panel">
                <header class="notes-modal-header notes-share-header">
                    <div class="notes-share-heading">
                        <span class="notes-share-heading-icon material-symbols-outlined" aria-hidden="true">person_add</span>
                        <div>
                        <h2 id="notes-share-title">Share ${escapeHtml(resourceTitle || (resourceType === 'folder' ? 'folder' : 'note'))}</h2>
                        <p>Invite people and choose what they can do.</p>
                        </div>
                    </div>
                    <button type="button" class="notes-icon-button" data-share-close aria-label="Close sharing">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </header>
                <div class="notes-share-people">
                    <div class="notes-share-invite-card">
                        <label class="notes-share-search-field">
                            <span class="material-symbols-outlined" aria-hidden="true">search</span>
                            <span class="sr-only">Add people or email</span>
                            <input type="search" autocomplete="off" placeholder="Search name, @username, or exact email" data-share-search>
                        </label>
                        ${roleMenuHtml('viewer', 'data-share-add-role', 'Role for new access')}
                    </div>
                    <div class="notes-share-results" data-share-results hidden></div>
                    <div class="notes-share-empty-state" data-share-empty-state>
                        <span class="notes-share-empty-icon material-symbols-outlined" aria-hidden="true">group_add</span>
                        <strong data-share-empty-title>Only you have access</strong>
                        <span>Search for a Nest user or enter their exact email above.</span>
                    </div>
                    <section class="notes-share-section" data-share-section="direct">
                        <h3><span class="material-symbols-outlined" aria-hidden="true">group</span>People with access <span class="notes-share-count" data-share-direct-count>0</span></h3>
                        <div class="notes-share-selected" data-share-selected></div>
                    </section>
                    <section class="notes-share-section" data-share-section="pending">
                        <h3><span class="material-symbols-outlined" aria-hidden="true">schedule</span>Pending invitations <span class="notes-share-count" data-share-pending-count>0</span></h3>
                        <p class="notes-share-help">They must register through OAuth signup using exactly the invited email.</p>
                        <div class="notes-share-selected" data-share-pending></div>
                    </section>
                    ${inherited.length ? `
                    <section class="notes-share-section">
                        <h3><span class="material-symbols-outlined" aria-hidden="true">account_tree</span>Inherited access</h3>
                        <div class="notes-share-selected" data-share-inherited></div>
                    </section>
                    ` : ''}
                    <section class="notes-share-general-card">
                        <span class="notes-share-general-icon material-symbols-outlined" data-share-general-icon aria-hidden="true">${sharing.public ? 'link' : 'lock'}</span>
                        <span class="notes-share-general-copy">
                            <strong>General access</strong>
                            <small>Public links are view-only</small>
                        </span>
                        ${selectionMenuHtml({
                            selectedValue: sharing.public ? 'public' : 'restricted',
                            options: GENERAL_ACCESS_OPTIONS,
                            attrs: 'data-share-public',
                            ariaLabel: 'General access',
                            compact: true,
                        })}
                        <button type="button" class="btn-secondary notes-share-copy-button" data-share-copy aria-label="Copy share link">
                            <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
                            <span>Copy link</span>
                        </button>
                    </section>
                </div>
                <div class="notes-form-error" data-share-error role="alert" hidden></div>
                <footer class="notes-modal-actions">
                    <button type="button" class="btn-secondary" data-share-close>Cancel</button>
                    <button type="button" class="btn-primary" data-share-save>
                        <span class="material-symbols-outlined" aria-hidden="true">check</span>
                        Save sharing
                    </button>
                </footer>
            </div>
        `;
        renderSelected(modal, users);
        renderPending(modal, pending);
        renderInherited(modal, inherited);

        modal.addEventListener('mousedown', (event) => {
            if (event.target === modal) close();
        });
        modal.addEventListener('click', async (event) => {
            const menuOption = event.target.closest('[data-share-menu-option]');
            if (menuOption) {
                const menu = menuOption.closest('[data-share-menu]');
                const value = menuOption.dataset.shareMenuOption;
                if (menu.hasAttribute('data-share-public')) {
                    modal._sharePublic = updateShareMenu(menu, value, GENERAL_ACCESS_OPTIONS) === 'public';
                    const icon = modal.querySelector('[data-share-general-icon]');
                    if (icon) icon.textContent = modal._sharePublic ? 'link' : 'lock';
                    syncAccessSections(modal, users, pending);
                } else {
                    const role = updateShareMenu(menu, normalizeRole(value), ROLE_OPTIONS);
                    if (menu.hasAttribute('data-share-add-role')) {
                        modal._shareAddRole = role;
                        if (!modal.querySelector('[data-share-results]')?.hidden) {
                            renderSearchResults(
                                modal,
                                modal._shareSearchResults || [],
                                new Set(users.map((user) => String(user.id))),
                                modal._shareEmailState
                            );
                        }
                    } else if (menu.hasAttribute('data-user-role')) {
                        const user = users.find((entry) => String(entry.id) === menu.dataset.userRole);
                        if (user) user.role = role;
                    } else if (menu.hasAttribute('data-pending-role')) {
                        const invite = pending.find((entry) => String(entry.email) === menu.dataset.pendingRole);
                        if (invite) invite.role = role;
                    }
                }
                setShareMenuOpen(modal, menu, false);
                menu.querySelector('[data-share-menu-trigger]')?.focus({ preventScroll: true });
                return;
            }
            const menuTrigger = event.target.closest('[data-share-menu-trigger]');
            if (menuTrigger) {
                const menu = menuTrigger.closest('[data-share-menu]');
                setShareMenuOpen(modal, menu, menuTrigger.getAttribute('aria-expanded') !== 'true');
                return;
            }
            closeShareMenus(modal);
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
            const removePending = event.target.closest('[data-remove-pending]');
            if (removePending) {
                const index = pending.findIndex((invite) => String(invite.email) === removePending.dataset.removePending);
                if (index >= 0) pending.splice(index, 1);
                renderPending(modal, pending);
                return;
            }
            const add = event.target.closest('[data-add-user]');
            if (add) {
                const results = modal._shareSearchResults || [];
                const user = results.find((entry) => String(entry.id) === add.dataset.addUser);
                if (user && !users.some((entry) => String(entry.id) === String(user.id))) {
                    users.push({ ...user, role: normalizeRole(modal._shareAddRole) });
                }
                renderSelected(modal, users);
                modal.querySelector('[data-share-results]').hidden = true;
                modal.querySelector('[data-share-search]').value = '';
                return;
            }
            const addEmail = event.target.closest('[data-add-email]');
            if (addEmail) {
                const email = addEmail.dataset.addEmail;
                if (email && !pending.some((entry) => String(entry.email).toLowerCase() === email.toLowerCase())) {
                    pending.push({ email, role: normalizeRole(modal._shareAddRole), status: 'pending' });
                }
                renderPending(modal, pending);
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
                        expected_revision: sharing.revision,
                        public: modal._sharePublic,
                        grants: users.map((user) => ({ user_id: user.id, role: normalizeRole(user.role) })),
                        invitations: pending.map((invite) => ({ email: invite.email, role: normalizeRole(invite.role) })),
                    }),
                });
                onSaved?.(updated);
                global.APStudyToast?.show?.({ message: 'Sharing updated.', type: 'success' });
                close();
            } catch (error) {
                const conflict = error.payload?.code === 'sharing_revision_conflict';
                setError(modal, conflict ? 'Sharing changed in another tab. Reopen this dialog to review the latest access.' : (error.message || 'Unable to update sharing.'));
                save.disabled = false;
            }
        });
        modal.addEventListener('keydown', (event) => {
            const openMenu = modal.querySelector('[data-share-menu-trigger][aria-expanded="true"]')?.closest('[data-share-menu]');
            if (event.key === 'Escape' && openMenu) {
                event.preventDefault();
                event.stopPropagation();
                setShareMenuOpen(modal, openMenu, false);
                openMenu.querySelector('[data-share-menu-trigger]')?.focus({ preventScroll: true });
                return;
            }
            const menu = event.target.closest('[data-share-menu]');
            if (!menu) return;
            const trigger = event.target.closest('[data-share-menu-trigger]');
            const options = [...menu.querySelectorAll('[data-share-menu-option]')];
            if (trigger && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
                event.preventDefault();
                setShareMenuOpen(modal, menu, true);
                if (event.key === 'ArrowUp') options.at(-1)?.focus({ preventScroll: true });
                return;
            }
            const currentIndex = options.indexOf(document.activeElement);
            if (currentIndex < 0) return;
            if (event.key === 'Tab') {
                setShareMenuOpen(modal, menu, false);
                return;
            }
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? options.length - 1
                    : event.key === 'ArrowDown'
                        ? (currentIndex + 1) % options.length
                        : event.key === 'ArrowUp'
                            ? (currentIndex - 1 + options.length) % options.length
                            : -1;
            if (nextIndex >= 0) {
                event.preventDefault();
                options[nextIndex]?.focus({ preventScroll: true });
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
                    renderSearchResults(
                        modal,
                        modal._shareSearchResults,
                        new Set(users.map((user) => String(user.id))),
                        payload.email
                    );
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
