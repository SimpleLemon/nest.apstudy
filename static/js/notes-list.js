(function () {
    const notesGrid = document.getElementById('notes-grid');
    const foldersGrid = document.getElementById('folders-grid');
    const foldersSection = document.getElementById('folders-section');
    const notesEmptyState = document.getElementById('notes-empty-state');
    const btnNewNote = document.getElementById('btn-new-note');
    const btnNewFolder = document.getElementById('btn-new-folder');
    const notesPage = document.getElementById('notes-page');
    let cachedFolders = [];
    let loadingState = false;

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    function ensureThemeLoaderStyles() {
        const styleId = 'apstudy-theme-loader-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .loader {
                display: inline-block;
                border-radius: 9999px;
                background: linear-gradient(180deg, rgba(99, 102, 241, 0.25), rgba(99, 102, 241, 0.08));
                position: relative;
                overflow: hidden;
            }
            .loader::before,
            .loader::after {
                content: '';
                position: absolute;
                inset: 0;
                border-radius: inherit;
            }
            .loader::before {
                border: 2px solid rgba(255, 255, 255, 0.14);
            }
            .loader::after {
                inset: 18%;
                border-radius: 9999px;
                border: 3px solid transparent;
                border-top-color: var(--border-accent, #6366f1);
                animation: apstudyLoaderRotation 0.85s linear infinite;
            }
            @keyframes apstudyLoaderRotation {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    function buildLoadingIndicatorHtml(label = 'Loading...', options = {}) {
        ensureThemeLoaderStyles();
        const sizePx = Number(options.sizePx) > 0 ? Number(options.sizePx) : 42;
        const textToneClass = options.textToneClass || 'text-on-surface-variant';
        return `
            <div class="flex w-full flex-col items-center justify-center gap-2 text-center text-sm ${textToneClass}">
                <span class="loader" style="width:${sizePx}px; height:${sizePx}px;" aria-hidden="true"></span>
                <span>${escapeHtml(label)}</span>
            </div>
        `;
    }

    function setLoadingState(isLoading, label = 'Loading notes...') {
        loadingState = isLoading;
        if (!notesGrid) return;
        if (isLoading) {
            notesGrid.innerHTML = `
                <div class="notes-loading-card rounded-2xl border border-outline-variant/20 bg-surface-container p-10 text-center">
                    ${buildLoadingIndicatorHtml(label, { sizePx: 52, textToneClass: 'text-on-surface' })}
                </div>
            `;
        }
    }

    async function fetchData() {
        try {
            const res = await fetch('/api/notes', { credentials: 'same-origin' });
            if (!res.ok) throw new Error('Failed to fetch');
            return await res.json();
        } catch (err) {
            console.error(err);
            return { notes: [], folders: [] };
        }
    }

    // Menu handling per spec
    function closeAllMenus() {
        document.querySelectorAll('.note-card-menu').forEach(menu => {
            menu.classList.add('note-menu-hidden');
        });
    }

    function handleMenuToggle(event) {
        event.stopPropagation();
        const btn = event.currentTarget;
        const card = btn.closest('.note-card');
        const menu = card.querySelector('.note-card-menu');
        const isHidden = menu.classList.contains('note-menu-hidden');
        closeAllMenus();
        if (isHidden) {
            menu.classList.remove('note-menu-hidden');
        }
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.note-card-menu') && !e.target.closest('.note-card-menu-btn')) {
            closeAllMenus();
        }
    });

    async function deleteNote(noteId, menuEl) {
        if (!noteId) return;
        if (menuEl) menuEl.classList.add('note-menu-hidden');
        setLoadingState(true, 'Deleting note...');
        try {
            const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error('Failed to delete note');
            await loadAndRender();
        } catch (err) {
            console.error(err);
        } finally {
            if (loadingState) setLoadingState(false);
        }
    }

    async function deleteFolder(folderId, menuEl) {
        if (!folderId) return;
        if (menuEl) menuEl.classList.add('note-menu-hidden');
        setLoadingState(true, 'Deleting folder...');
        try {
            const response = await fetch(`/api/notes/folders/${encodeURIComponent(folderId)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error('Failed to delete folder');
            await loadAndRender();
        } catch (err) {
            console.error(err);
        } finally {
            if (loadingState) setLoadingState(false);
        }
    }

    // Render helpers
    function createNoteCard(note) {
        const noteId = note.$id || note.id || '';
        const formattedDate = new Date(note.created_at || note.updated_at || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        const card = document.createElement('div');
        card.className = 'note-card';
        card.dataset.noteId = noteId;
        card.dataset.folderId = note.folder_id || '';

        card.innerHTML = `
            <div class="note-card-header">
                <span class="note-card-title">${escapeHtml(note.title || 'Untitled')}</span>
                <button type="button" class="note-card-menu-btn" aria-label="Note options">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5"/>
                        <circle cx="8" cy="8" r="1.5"/>
                        <circle cx="8" cy="13" r="1.5"/>
                    </svg>
                </button>
            </div>
            <div class="note-card-date">${formattedDate}</div>
            <div class="note-card-menu note-menu-hidden">
                <button type="button" class="note-menu-item" data-action="open">Open</button>
                <button type="button" class="note-menu-item" data-action="move">Move to Folder</button>
                <button type="button" class="note-menu-item" data-action="export-txt">Export TXT</button>
                <button type="button" class="note-menu-item" data-action="export-pdf">Export PDF</button>
                <hr class="note-menu-divider"/>
                <button type="button" class="note-menu-item note-menu-item-danger" data-action="delete">Delete</button>
            </div>
        `;

        // Wire card clicks
        const menuBtn = card.querySelector('.note-card-menu-btn');
        menuBtn.addEventListener('click', handleMenuToggle);

        const menu = card.querySelector('.note-card-menu');
        menu.querySelector('[data-action="open"]').addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
        });

        menu.querySelector('[data-action="move"]').addEventListener('click', async (e) => {
            e.stopPropagation();

            const folderOptions = (cachedFolders || []).map((folder) => {
                const folderId = folder.$id || folder.id;
                return `${folderId}: ${folder.name || 'Untitled Folder'}`;
            }).join('\n');

            const currentFolderId = note.folder_id || 'none';
            const selection = window.prompt(
                `Move note to folder. Enter a folder ID or type "none" for no folder.\n\n${folderOptions || 'No folders available.'}`,
                currentFolderId
            );

            if (selection === null) return;

            const rawValue = selection.trim();
            const folderId = rawValue.toLowerCase() === 'none' || rawValue === '' ? null : rawValue;

            try {
                const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ folder_id: folderId }),
                });
                if (!response.ok) throw new Error('Failed to move note');
                await loadAndRender();
            } catch (err) {
                console.error(err);
            }
        });

        menu.querySelector('[data-action="export-txt"]').addEventListener('click', (e) => { e.stopPropagation(); if (window.NotesExport) window.NotesExport.exportNoteJsonToTxt(note.content || '', note.title || 'Untitled'); });
        menu.querySelector('[data-action="export-pdf"]').addEventListener('click', (e) => { e.stopPropagation(); if (window.NotesExport) window.NotesExport.exportNoteJsonToPdf(note.content || '', note.title || 'Untitled'); });

        // Clicking card body opens editor
        card.addEventListener('click', (e) => {
            if (e.target.closest('.note-card-menu') || e.target.closest('.note-card-menu-btn')) return;
            window.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
        });

        return card;
    }

    function createFolderCard(folder, noteCount) {
        const folderId = folder.$id || folder.id || '';
        const el = document.createElement('div');
        el.className = 'folder-card';
        el.dataset.folderId = folderId;

        el.innerHTML = `
            <div class="folder-card-inner">
                <div class="folder-card-icon">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 3.89543 2.89543 3 4 3H7.17157C7.70201 3 8.21071 3.21071 8.58579 3.58579L9.41421 4.41421C9.78929 4.78929 10.298 5 10.8284 5H16C17.1046 5 18 5.89543 18 7V15C18 16.1046 17.1046 17 16 17H4C2.89543 17 2 16.1046 2 15V5Z" fill="#6366f1" opacity="0.2" stroke="#6366f1" stroke-width="1.5"/></svg>
                </div>
                <div class="folder-card-info">
                    <span class="folder-card-name">${escapeHtml(folder.name)}</span>
                    <span class="folder-card-count">${noteCount} note${noteCount !== 1 ? 's' : ''}</span>
                </div>
                <button type="button" class="folder-card-menu-btn" aria-label="Folder options">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
                </button>
            </div>
            <div class="folder-card-menu note-menu-hidden">
                <button type="button" class="note-menu-item" data-action="rename">Rename</button>
                <button type="button" class="note-menu-item note-menu-item-danger" data-action="delete-folder">Delete</button>
            </div>
            <div class="folder-card-notes folder-collapsed" data-folder-notes="${folderId}">
                <div class="folder-card-notes-inner"></div>
            </div>
        `;

        // Expand/collapse on inner click
        el.querySelector('.folder-card-inner').addEventListener('click', (e) => {
            const notesSection = el.querySelector('.folder-card-notes');
            const isCollapsed = notesSection.classList.contains('folder-collapsed');
            notesSection.classList.toggle('folder-collapsed', !isCollapsed);
            notesSection.classList.toggle('folder-expanded', isCollapsed);
        });

        // Folder menu actions
        const menuBtn = el.querySelector('.folder-card-menu-btn');
        const menu = el.querySelector('.folder-card-menu');
        menuBtn.addEventListener('click', (ev) => { ev.stopPropagation(); closeAllMenus(); menu.classList.toggle('note-menu-hidden'); });
        menu.querySelector('[data-action="rename"]').addEventListener('click', async (e) => {
            e.stopPropagation();
            const name = prompt('Rename folder', folder.name || '');
            if (name === null) return;
            try { await fetch(`/api/notes/folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ name }) }); loadAndRender(); } catch (err) { console.error(err); }
        });
        return el;
    }

    function render(data) {
        const notes = data.notes || [];
        const folders = data.folders || [];
        cachedFolders = folders;

        // Map notes by folder
        const notesByFolder = {};
        notes.forEach(n => {
            const fid = n.folder_id || 'root';
            if (!notesByFolder[fid]) notesByFolder[fid] = [];
            notesByFolder[fid].push(n);
        });

        // Render folders
        foldersGrid.innerHTML = '';
        if (!folders || folders.length === 0) {
            foldersSection.style.display = 'none';
        } else {
            foldersSection.style.display = '';
            const sorted = [...folders].sort((a, b) => (a.order || 0) - (b.order || 0));
            sorted.forEach(f => {
                const bucket = notesByFolder[f.$id || f.id] || [];
                const folderEl = createFolderCard(f, bucket.length);
                // populate inner notes
                const inner = folderEl.querySelector('.folder-card-notes-inner');
                bucket.forEach(note => inner.appendChild(createNoteCard(note)));
                foldersGrid.appendChild(folderEl);
            });
        }

        // Render unfiled notes
        notesGrid.innerHTML = '';
        const unfiled = notesByFolder['root'] || [];
        if (!unfiled || unfiled.length === 0) {
            notesEmptyState.style.display = '';
        } else {
            notesEmptyState.style.display = 'none';
            unfiled.forEach(n => notesGrid.appendChild(createNoteCard(n)));
        }

        initDragDrop();
    }

    function initDragDrop() {
        if (typeof Sortable === 'undefined') return;

        // root notes grid
        if (notesGrid) {
            Sortable.create(notesGrid, {
                group: { name: 'notes', pull: true, put: true },
                animation: 150,
                draggable: '.note-card',
                ghostClass: 'note-card-ghost',
                chosenClass: 'note-card-chosen',
                dragClass: 'note-card-drag',
                onEnd: handleDragEnd,
            });
        }

        // each folder inner list
        document.querySelectorAll('.folder-card-notes-inner').forEach(container => {
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

        // folder card drop target visuals
        document.querySelectorAll('.folder-card').forEach(folderCard => {
            folderCard.addEventListener('dragover', (e) => { e.preventDefault(); folderCard.classList.add('folder-drop-target'); });
            folderCard.addEventListener('dragleave', () => { folderCard.classList.remove('folder-drop-target'); });
            folderCard.addEventListener('drop', (e) => { e.preventDefault(); folderCard.classList.remove('folder-drop-target'); const notesSection = folderCard.querySelector('.folder-card-notes'); notesSection.classList.remove('folder-collapsed'); notesSection.classList.add('folder-expanded'); });
        });
    }

    async function handleDragEnd(evt) {
        const item = evt.item;
        if (!item) return;
        const noteId = item.dataset.noteId;
        const newContainer = evt.to;
        let newFolderId = null;
        const folderCard = newContainer.closest('.folder-card');
        if (folderCard) newFolderId = folderCard.dataset.folderId || null;
        const newOrder = evt.newIndex;

        try {
            await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ folder_id: newFolderId, order: newOrder }),
            });
        } catch (err) {
            console.error('Failed to update note position:', err);
        }
    }

    async function loadAndRender() {
        setLoadingState(true, 'Loading notes...');
        const data = await fetchData();
        render(data);
        setLoadingState(false);
    }

    // New note / folder
    btnNewNote?.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ title: '', content: '' }) });
            if (!res.ok) throw new Error('Failed');
            const note = await res.json();
            const nid = note.$id || note.id;
            if (nid) { window.location.href = `/notes/editor/${encodeURIComponent(nid)}`; return; }
            await loadAndRender();
        } catch (err) { console.error(err); }
    });

    btnNewFolder?.addEventListener('click', async () => {
        const name = prompt('Folder name', 'New Folder');
        if (name === null) return;
        try {
            await fetch('/api/notes/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ name }) });
            await loadAndRender();
        } catch (err) { console.error(err); }
    });

    document.addEventListener('click', async (event) => {
        const deleteNoteButton = event.target.closest('.note-menu-item-danger[data-action="delete"]');
        if (deleteNoteButton) {
            const noteCard = deleteNoteButton.closest('.note-card');
            const noteId = noteCard?.dataset.noteId;
            const menuEl = deleteNoteButton.closest('.note-card-menu');
            if (!confirm('Delete this note?')) return;
            await deleteNote(noteId, menuEl);
            return;
        }

        const deleteFolderButton = event.target.closest('.note-menu-item-danger[data-action="delete-folder"]');
        if (deleteFolderButton) {
            const folderCard = deleteFolderButton.closest('.folder-card');
            const folderId = folderCard?.dataset.folderId;
            const menuEl = deleteFolderButton.closest('.folder-card-menu');
            if (!confirm('Delete folder and its notes?')) return;
            await deleteFolder(folderId, menuEl);
        }
    });

    document.addEventListener('DOMContentLoaded', loadAndRender);
})();
