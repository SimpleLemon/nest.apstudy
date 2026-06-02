(function () {
    const els = {
        page: document.getElementById('notes-page'),
        notesGrid: document.getElementById('notes-grid'),
        foldersGrid: document.getElementById('folders-grid'),
        foldersSection: document.getElementById('folders-section'),
        notesSection: document.getElementById('notes-section'),
        notesEmptyState: document.getElementById('notes-empty-state'),
        notesEmptyNewNote: document.getElementById('notes-empty-new-note'),
        btnNewNote: document.getElementById('btn-new-note'),
        btnNewFolder: document.getElementById('btn-new-folder'),
        alert: document.getElementById('notes-alert'),
        foldersCount: document.getElementById('folders-count'),
        notesCount: document.getElementById('notes-count'),
        folderModal: document.getElementById('notes-folder-modal'),
        folderForm: document.getElementById('notes-folder-form'),
        folderTitle: document.getElementById('notes-folder-modal-title'),
        folderSubtitle: document.getElementById('notes-folder-modal-subtitle'),
        folderName: document.getElementById('notes-folder-name'),
        folderError: document.getElementById('notes-folder-error'),
        folderSave: document.getElementById('notes-folder-save'),
        moveModal: document.getElementById('notes-move-modal'),
        moveForm: document.getElementById('notes-move-form'),
        moveDestination: document.getElementById('notes-move-destination'),
        moveError: document.getElementById('notes-move-error'),
        moveSave: document.getElementById('notes-move-save'),
    };

    const state = {
        folders: [],
        notes: [],
        folderModalMode: 'create',
        activeFolder: null,
        moveNote: null,
        activeModal: null,
        lastFocusedElement: null,
        loading: false,
    };

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function cssEscape(value) {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function formatCount(count, singular) {
        return `${count} ${singular}${count === 1 ? '' : 's'}`;
    }

    function formatDate(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) return 'Updated recently';
        return `Updated ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }

    function notePreview(note) {
        if (typeof note.content !== 'string' || !note.content.trim()) return 'Blank note';
        try {
            const blocks = JSON.parse(note.content);
            const text = (Array.isArray(blocks) ? blocks : [])
                .flatMap((block) => Array.isArray(block.content) ? block.content : [])
                .map((item) => item?.text || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            return text || 'Blank note';
        } catch {
            return 'Blank note';
        }
    }

    function setButtonBusy(button, busy) {
        if (!button) return;
        button.disabled = busy;
        button.classList.toggle('is-busy', busy);
    }

    function showAlert(message, type = 'info') {
        if (!els.alert) return;
        els.alert.textContent = message;
        els.alert.hidden = false;
        els.alert.classList.toggle('notes-alert-error', type === 'error');
    }

    function clearAlert() {
        if (!els.alert) return;
        els.alert.hidden = true;
        els.alert.textContent = '';
        els.alert.classList.remove('notes-alert-error');
    }

    function showFormError(element, message) {
        if (!element) return;
        element.textContent = message;
        element.hidden = false;
    }

    function clearFormError(element) {
        if (!element) return;
        element.textContent = '';
        element.hidden = true;
    }

    function buildLoadingIndicatorHtml(label = 'Loading notes...', options = {}) {
        return window.APStudyLoader.html(label, options);
    }

    async function apiJson(url, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const method = String(options.method || 'GET').toUpperCase();
        const request = fetch(url, { ...options, headers });
        const response = await (method === 'GET'
            ? request
            : window.APStudyPendingMutations?.track(request, 'notes-save') || request);
        const contentType = response.headers.get('Content-Type') || '';
        const payload = contentType.includes('application/json') ? await response.json() : null;
        if (!response.ok) {
            throw new Error(payload?.error || payload?.message || response.statusText || 'Request failed.');
        }
        return payload || {};
    }

    function setLoadingState(isLoading, label = 'Loading notes...') {
        state.loading = isLoading;
        els.page?.classList.toggle('is-loading', isLoading);
        if (!els.notesGrid) return;
        if (isLoading) {
            els.notesGrid.innerHTML = `
                <div class="notes-loading-card">
                    ${buildLoadingIndicatorHtml(label, { sizePx: 52, textToneClass: 'text-on-surface' })}
                </div>
            `;
            if (els.notesEmptyState) els.notesEmptyState.style.display = 'none';
        }
    }

    function closeAllMenus() {
        document.querySelectorAll('.note-card-menu, .folder-card-menu').forEach((menu) => {
            menu.classList.add('note-menu-hidden');
        });
        document.querySelectorAll('.note-card-menu-btn, .folder-card-menu-btn').forEach((button) => {
            button.setAttribute('aria-expanded', 'false');
        });
    }

    function toggleCardMenu(button, menu) {
        const isHidden = menu.classList.contains('note-menu-hidden');
        closeAllMenus();
        if (isHidden) {
            menu.classList.remove('note-menu-hidden');
            button.setAttribute('aria-expanded', 'true');
            menu.querySelector('button')?.focus({ preventScroll: true });
        }
    }

    function openModal(modal, focusTarget = null) {
        if (!modal) return;
        state.lastFocusedElement = document.activeElement;
        modal.hidden = false;
        state.activeModal = modal;
        document.body.classList.add('notes-modal-open');
        requestAnimationFrame(() => {
            const target = focusTarget || modal.querySelector('input, select, button, [tabindex]:not([tabindex="-1"])');
            target?.focus({ preventScroll: true });
        });
    }

    function closeModal(modal = state.activeModal) {
        if (!modal) return;
        modal.hidden = true;
        if (state.activeModal === modal) state.activeModal = null;
        if (!document.querySelector('.notes-modal:not([hidden])')) {
            document.body.classList.remove('notes-modal-open');
        }
        state.lastFocusedElement?.focus?.({ preventScroll: true });
    }

    function folderById(folderId) {
        return state.folders.find((folder) => (folder.$id || folder.id) === folderId) || null;
    }

    function openFolderModal(mode, folder = null) {
        state.folderModalMode = mode;
        state.activeFolder = folder;
        clearFormError(els.folderError);
        if (els.folderTitle) els.folderTitle.textContent = mode === 'rename' ? 'Rename folder' : 'New folder';
        if (els.folderSubtitle) {
            els.folderSubtitle.textContent = mode === 'rename'
                ? 'Update this folder name.'
                : 'Create a folder for related notes.';
        }
        if (els.folderName) els.folderName.value = mode === 'rename' ? (folder?.name || '') : 'New Folder';
        if (els.folderSave) els.folderSave.textContent = mode === 'rename' ? 'Save changes' : 'Create folder';
        openModal(els.folderModal, els.folderName);
        els.folderName?.select();
    }

    function openMoveModal(note) {
        state.moveNote = note;
        clearFormError(els.moveError);
        const currentFolderId = note.folder_id || '';
        if (els.moveDestination) {
            els.moveDestination.innerHTML = [
                '<option value="">No folder</option>',
                ...state.folders.map((folder) => {
                    const folderId = folder.$id || folder.id || '';
                    const selected = folderId === currentFolderId ? ' selected' : '';
                    return `<option value="${escapeHtml(folderId)}"${selected}>${escapeHtml(folder.name || 'Untitled Folder')}</option>`;
                }),
            ].join('');
        }
        openModal(els.moveModal, els.moveDestination);
    }

    function createNoteCard(note) {
        const noteId = note.$id || note.id || '';
        const title = note.title || 'Untitled';
        const card = document.createElement('article');
        card.className = 'note-card';
        card.tabIndex = 0;
        card.dataset.noteId = noteId;
        card.dataset.folderId = note.folder_id || '';
        card.setAttribute('aria-label', `Open note ${title}`);

        card.innerHTML = `
            <div class="note-card-header">
                <span class="note-card-title">${escapeHtml(title)}</span>
                <button type="button" class="note-card-menu-btn" aria-label="Note options for ${escapeHtml(title)}" aria-haspopup="menu" aria-expanded="false">
                    <span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>
                </button>
            </div>
            <p class="note-card-preview">${escapeHtml(notePreview(note))}</p>
            <div class="note-card-date">${escapeHtml(formatDate(note.updated_at || note.created_at))}</div>
            <div class="note-card-menu note-menu-hidden" role="menu">
                <button type="button" class="note-menu-item" role="menuitem" data-action="open">Open</button>
                <button type="button" class="note-menu-item" role="menuitem" data-action="move">Move to folder</button>
                <button type="button" class="note-menu-item" role="menuitem" data-action="export-txt">Export TXT</button>
                <button type="button" class="note-menu-item" role="menuitem" data-action="export-pdf">Export PDF</button>
                <hr class="note-menu-divider"/>
                <button type="button" class="note-menu-item note-menu-item-danger" role="menuitem" data-action="delete">Delete</button>
            </div>
        `;

        const menuBtn = card.querySelector('.note-card-menu-btn');
        const menu = card.querySelector('.note-card-menu');
        menuBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleCardMenu(menuBtn, menu);
        });

        menu.querySelector('[data-action="open"]').addEventListener('click', (event) => {
            event.stopPropagation();
            window.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
        });
        menu.querySelector('[data-action="move"]').addEventListener('click', (event) => {
            event.stopPropagation();
            closeAllMenus();
            openMoveModal(note);
        });
        menu.querySelector('[data-action="export-txt"]').addEventListener('click', (event) => {
            event.stopPropagation();
            closeAllMenus();
            window.NotesExport?.exportNoteJsonToTxt(note.content || '', title);
        });
        menu.querySelector('[data-action="export-pdf"]').addEventListener('click', (event) => {
            event.stopPropagation();
            closeAllMenus();
            window.NotesExport?.exportNoteJsonToPdf(note.content || '', title);
        });

        const openNote = () => {
            window.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
        };
        card.addEventListener('click', (event) => {
            if (event.target.closest('.note-card-menu') || event.target.closest('.note-card-menu-btn')) return;
            openNote();
        });
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.target.closest('button')) {
                event.preventDefault();
                openNote();
            }
        });

        return card;
    }

    function createFolderCard(folder, notes) {
        const folderId = folder.$id || folder.id || '';
        const folderName = folder.name || 'Untitled Folder';
        const el = document.createElement('article');
        el.className = 'folder-card';
        el.dataset.folderId = folderId;

        el.innerHTML = `
            <button type="button" class="folder-card-inner" aria-expanded="false">
                <span class="folder-card-icon">
                    <span class="material-symbols-outlined" aria-hidden="true">folder</span>
                </span>
                <span class="folder-card-info">
                    <span class="folder-card-name">${escapeHtml(folderName)}</span>
                    <span class="folder-card-count">${formatCount(notes.length, 'note')}</span>
                </span>
                <span class="material-symbols-outlined folder-card-chevron" aria-hidden="true">expand_more</span>
            </button>
            <button type="button" class="folder-card-menu-btn" aria-label="Folder options for ${escapeHtml(folderName)}" aria-haspopup="menu" aria-expanded="false">
                <span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>
            </button>
            <div class="folder-card-menu note-menu-hidden" role="menu">
                <button type="button" class="note-menu-item" role="menuitem" data-action="rename">Rename</button>
                <button type="button" class="note-menu-item note-menu-item-danger" role="menuitem" data-action="delete-folder">Delete</button>
            </div>
            <div class="folder-card-notes folder-collapsed" data-folder-notes="${escapeHtml(folderId)}">
                <div class="folder-card-notes-inner"></div>
            </div>
        `;

        const notesSection = el.querySelector('.folder-card-notes');
        const inner = el.querySelector('.folder-card-notes-inner');
        if (notes.length) {
            notes.forEach((note) => inner.appendChild(createNoteCard(note)));
        } else {
            inner.innerHTML = '<p class="folder-empty-note">No notes in this folder yet.</p>';
        }

        const folderButton = el.querySelector('.folder-card-inner');
        folderButton.addEventListener('click', () => {
            const isCollapsed = notesSection.classList.contains('folder-collapsed');
            notesSection.classList.toggle('folder-collapsed', !isCollapsed);
            notesSection.classList.toggle('folder-expanded', isCollapsed);
            folderButton.setAttribute('aria-expanded', String(isCollapsed));
            el.classList.toggle('is-expanded', isCollapsed);
        });

        const menuBtn = el.querySelector('.folder-card-menu-btn');
        const menu = el.querySelector('.folder-card-menu');
        menuBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleCardMenu(menuBtn, menu);
        });
        menu.querySelector('[data-action="rename"]').addEventListener('click', (event) => {
            event.stopPropagation();
            closeAllMenus();
            openFolderModal('rename', folder);
        });

        return el;
    }

    function render(data) {
        state.notes = data.notes || [];
        state.folders = data.folders || [];
        const notesByFolder = {};
        state.notes.forEach((note) => {
            const folderId = note.folder_id || 'root';
            if (!notesByFolder[folderId]) notesByFolder[folderId] = [];
            notesByFolder[folderId].push(note);
        });

        if (els.foldersCount) els.foldersCount.textContent = formatCount(state.folders.length, 'folder');
        if (els.notesCount) els.notesCount.textContent = formatCount((notesByFolder.root || []).length, 'note');

        if (els.foldersGrid) els.foldersGrid.innerHTML = '';
        if (!state.folders.length) {
            if (els.foldersSection) els.foldersSection.hidden = true;
        } else {
            if (els.foldersSection) els.foldersSection.hidden = false;
            [...state.folders]
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .forEach((folder) => {
                    const folderId = folder.$id || folder.id;
                    els.foldersGrid.appendChild(createFolderCard(folder, notesByFolder[folderId] || []));
                });
        }

        if (els.notesGrid) els.notesGrid.innerHTML = '';
        const unfiled = notesByFolder.root || [];
        if (!unfiled.length) {
            if (els.notesEmptyState) els.notesEmptyState.style.display = '';
        } else {
            if (els.notesEmptyState) els.notesEmptyState.style.display = 'none';
            unfiled.forEach((note) => els.notesGrid.appendChild(createNoteCard(note)));
        }

        initDragDrop();
    }

    async function loadAndRender(options = {}) {
        if (options.clearAlert !== false) clearAlert();
        setLoadingState(true, 'Loading notes...');
        try {
            const data = await apiJson('/api/notes');
            render(data);
        } catch (error) {
            render({ notes: [], folders: [] });
            showAlert(error.message || 'Unable to load notes right now.', 'error');
        } finally {
            setLoadingState(false);
        }
    }

    async function createNote() {
        clearAlert();
        setButtonBusy(els.btnNewNote, true);
        setButtonBusy(els.notesEmptyNewNote, true);
        try {
            const note = await apiJson('/api/notes', {
                method: 'POST',
                body: JSON.stringify({ title: '', content: '' }),
            });
            const noteId = note.$id || note.id;
            if (noteId) {
                window.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
                return;
            }
            await loadAndRender({ clearAlert: false });
        } catch (error) {
            showAlert(error.message || 'Unable to create note.', 'error');
        } finally {
            setButtonBusy(els.btnNewNote, false);
            setButtonBusy(els.notesEmptyNewNote, false);
        }
    }

    async function saveFolderModal() {
        const name = (els.folderName?.value || '').trim();
        if (!name) {
            showFormError(els.folderError, 'Enter a folder name.');
            return;
        }
        clearFormError(els.folderError);
        setButtonBusy(els.folderSave, true);
        try {
            if (state.folderModalMode === 'rename') {
                const folderId = state.activeFolder?.$id || state.activeFolder?.id;
                await apiJson(`/api/notes/folders/${encodeURIComponent(folderId)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ name }),
                });
                showAlert('Folder renamed.');
            } else {
                await apiJson('/api/notes/folders', {
                    method: 'POST',
                    body: JSON.stringify({ name }),
                });
                showAlert('Folder created.');
            }
            closeModal(els.folderModal);
            await loadAndRender({ clearAlert: false });
        } catch (error) {
            showFormError(els.folderError, error.message || 'Unable to save folder.');
        } finally {
            setButtonBusy(els.folderSave, false);
        }
    }

    async function saveMoveModal() {
        const noteId = state.moveNote?.$id || state.moveNote?.id;
        if (!noteId) return;
        const folderId = els.moveDestination?.value || null;
        clearFormError(els.moveError);
        setButtonBusy(els.moveSave, true);
        try {
            await apiJson(`/api/notes/${encodeURIComponent(noteId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ folder_id: folderId }),
            });
            closeModal(els.moveModal);
            showAlert(folderId ? `Moved to ${folderById(folderId)?.name || 'folder'}.` : 'Moved to unfiled notes.');
            await loadAndRender({ clearAlert: false });
        } catch (error) {
            showFormError(els.moveError, error.message || 'Unable to move note.');
        } finally {
            setButtonBusy(els.moveSave, false);
        }
    }

    async function deleteNote(noteCard, button) {
        const noteId = noteCard?.dataset.noteId;
        if (!noteId) return;
        const note = state.notes.find((item) => (item.$id || item.id) === noteId);
        const title = note?.title || 'Untitled';
        const accepted = await (window.APStudyConfirm?.request?.({
            title: 'Delete note?',
            message: `"${title}" will be permanently removed.`,
            acceptLabel: 'Delete note',
            danger: true,
        }) ?? Promise.resolve(false));
        if (!accepted) return;
        setButtonBusy(button, true);
        try {
            await apiJson(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
            showAlert('Note deleted.');
            await loadAndRender({ clearAlert: false });
        } catch (error) {
            showAlert(error.message || 'Unable to delete note.', 'error');
        } finally {
            setButtonBusy(button, false);
        }
    }

    async function deleteFolder(folderCard, button) {
        const folderId = folderCard?.dataset.folderId;
        if (!folderId) return;
        const folder = folderById(folderId);
        const noteCount = state.notes.filter((note) => note.folder_id === folderId).length;
        const accepted = await (window.APStudyConfirm?.request?.({
            title: 'Delete folder?',
            message: `"${folder?.name || 'This folder'}" and ${formatCount(noteCount, 'note')} inside it will be permanently removed.`,
            acceptLabel: 'Delete folder',
            danger: true,
        }) ?? Promise.resolve(false));
        if (!accepted) return;
        setButtonBusy(button, true);
        try {
            await apiJson(`/api/notes/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
            showAlert('Folder deleted.');
            await loadAndRender({ clearAlert: false });
        } catch (error) {
            showAlert(error.message || 'Unable to delete folder.', 'error');
        } finally {
            setButtonBusy(button, false);
        }
    }

    function initDragDrop() {
        if (typeof Sortable === 'undefined') return;
        if (els.notesGrid) {
            Sortable.create(els.notesGrid, {
                group: { name: 'notes', pull: true, put: true },
                animation: 150,
                draggable: '.note-card',
                ghostClass: 'note-card-ghost',
                chosenClass: 'note-card-chosen',
                dragClass: 'note-card-drag',
                onEnd: handleDragEnd,
            });
        }
        document.querySelectorAll('.folder-card-notes-inner').forEach((container) => {
            Sortable.create(container, {
                group: { name: 'notes', pull: true, put: true },
                animation: 150,
                draggable: '.note-card',
                ghostClass: 'note-card-ghost',
                chosenClass: 'note-card-chosen',
                dragClass: 'note-card-drag',
                onEnd: handleDragEnd,
            });
        });
        document.querySelectorAll('.folder-card').forEach((folderCard) => {
            folderCard.addEventListener('dragover', (event) => {
                event.preventDefault();
                folderCard.classList.add('folder-drop-target');
            });
            folderCard.addEventListener('dragleave', () => folderCard.classList.remove('folder-drop-target'));
            folderCard.addEventListener('drop', (event) => {
                event.preventDefault();
                folderCard.classList.remove('folder-drop-target');
                const notesSection = folderCard.querySelector('.folder-card-notes');
                const folderButton = folderCard.querySelector('.folder-card-inner');
                notesSection.classList.remove('folder-collapsed');
                notesSection.classList.add('folder-expanded');
                folderCard.classList.add('is-expanded');
                folderButton?.setAttribute('aria-expanded', 'true');
            });
        });
    }

    async function handleDragEnd(evt) {
        const item = evt.item;
        if (!item) return;
        const noteId = item.dataset.noteId;
        const folderCard = evt.to.closest('.folder-card');
        const newFolderId = folderCard?.dataset.folderId || null;
        try {
            await apiJson(`/api/notes/${encodeURIComponent(noteId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ folder_id: newFolderId, order: evt.newIndex }),
            });
            item.dataset.folderId = newFolderId || '';
        } catch (error) {
            showAlert(error.message || 'Unable to update note position.', 'error');
            await loadAndRender();
        }
    }

    function bindEvents() {
        els.btnNewNote?.addEventListener('click', createNote);
        els.notesEmptyNewNote?.addEventListener('click', createNote);
        els.btnNewFolder?.addEventListener('click', () => openFolderModal('create'));
        els.folderForm?.addEventListener('submit', (event) => {
            event.preventDefault();
            void saveFolderModal();
        });
        els.moveForm?.addEventListener('submit', (event) => {
            event.preventDefault();
            void saveMoveModal();
        });
        document.querySelectorAll('[data-close-notes-modal]').forEach((button) => {
            button.addEventListener('click', () => closeModal(button.closest('.notes-modal')));
        });
        document.querySelectorAll('.notes-modal').forEach((modal) => {
            modal.addEventListener('mousedown', (event) => {
                if (event.target === modal) closeModal(modal);
            });
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('.note-card-menu, .folder-card-menu, .note-card-menu-btn, .folder-card-menu-btn')) {
                closeAllMenus();
            }
            const deleteNoteButton = event.target.closest('.note-menu-item-danger[data-action="delete"]');
            if (deleteNoteButton) {
                event.stopPropagation();
                closeAllMenus();
                void deleteNote(deleteNoteButton.closest('.note-card'), deleteNoteButton);
                return;
            }
            const deleteFolderButton = event.target.closest('.note-menu-item-danger[data-action="delete-folder"]');
            if (deleteFolderButton) {
                event.stopPropagation();
                closeAllMenus();
                void deleteFolder(deleteFolderButton.closest('.folder-card'), deleteFolderButton);
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (state.activeModal) {
                closeModal();
                return;
            }
            closeAllMenus();
        });
        window.addEventListener('resize', closeAllMenus);
        window.addEventListener('scroll', closeAllMenus, true);
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        void loadAndRender();
    });
})();
