(function registerNotesListCards(global) {
    const EXPANDED_FOLDERS_KEY = 'apstudy.notes.expandedFolders';

    function readExpandedFolderIds() {
        try {
            const raw = global.sessionStorage?.getItem(EXPANDED_FOLDERS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
        } catch {
            return new Set();
        }
    }

    function writeExpandedFolderIds(ids) {
        try {
            global.sessionStorage?.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...ids]));
        } catch {
            // ignore storage errors
        }
    }

    function createNotesListCards({ callbacks }) {
        const {
            apiJson,
            closeAllMenus,
            escapeHtml,
            formatCount,
            formatDate,
            notePreview,
            onFolderExpandChange,
            openFolderModal,
            openMoveModal,
            preloadEditorBundle,
            toggleCardMenu,
        } = callbacks;

        const expandedFolderIds = readExpandedFolderIds();

        async function fetchNoteContent(noteId) {
            const note = await apiJson(`/api/notes/${encodeURIComponent(noteId)}`);
            return typeof note?.content === 'string' ? note.content : '';
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
                global.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
            });
            menu.querySelector('[data-action="move"]').addEventListener('click', (event) => {
                event.stopPropagation();
                closeAllMenus();
                openMoveModal(note);
            });
            menu.querySelector('[data-action="export-txt"]').addEventListener('click', async (event) => {
                event.stopPropagation();
                closeAllMenus();
                try {
                    const content = await fetchNoteContent(noteId);
                    global.NotesExport?.exportNoteJsonToTxt(content, title);
                } catch (error) {
                    global.APStudyToast?.show?.({
                        message: error.message || 'Unable to export note.',
                        type: 'error',
                    });
                }
            });
            menu.querySelector('[data-action="export-pdf"]').addEventListener('click', async (event) => {
                event.stopPropagation();
                closeAllMenus();
                try {
                    const content = await fetchNoteContent(noteId);
                    await global.NotesExport?.exportNoteJsonToPdf(content, title);
                } catch (error) {
                    global.APStudyToast?.show?.({
                        message: error.message || 'Unable to export note.',
                        type: 'error',
                    });
                }
            });

            const openNote = () => {
                global.location.href = `/notes/editor/${encodeURIComponent(noteId)}`;
            };
            card.addEventListener('click', (event) => {
                if (event.target.closest('.note-card-menu') || event.target.closest('.note-card-menu-btn')) return;
                openNote();
            });
            card.addEventListener('mouseenter', () => preloadEditorBundle?.(), { once: true });
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.target.closest('button')) {
                    event.preventDefault();
                    openNote();
                }
            });

            return card;
        }

        function renderFolderNotes(inner, notes, { emptyMessage = 'No notes in this folder yet.' } = {}) {
            inner.innerHTML = '';
            if (!notes.length) {
                inner.innerHTML = `<p class="folder-empty-note">${escapeHtml(emptyMessage)}</p>`;
                return;
            }
            notes.forEach((note) => inner.appendChild(createNoteCard(note)));
        }

        function setFolderExpanded(el, notesSection, folderButton, expanded, notes, inner) {
            notesSection.classList.toggle('folder-collapsed', !expanded);
            notesSection.classList.toggle('folder-expanded', expanded);
            folderButton.setAttribute('aria-expanded', String(expanded));
            el.classList.toggle('is-expanded', expanded);
            const folderId = el.dataset.folderId || '';
            if (expanded) {
                expandedFolderIds.add(folderId);
                renderFolderNotes(inner, notes);
                onFolderExpandChange?.();
            } else {
                expandedFolderIds.delete(folderId);
                inner.innerHTML = '';
                onFolderExpandChange?.();
            }
            writeExpandedFolderIds(expandedFolderIds);
        }

        function createFolderCard(folder, notes) {
            const folderId = folder.$id || folder.id || '';
            const folderName = folder.name || 'Untitled Folder';
            const el = document.createElement('article');
            el.className = 'folder-card';
            el.dataset.folderId = folderId;
            const initiallyExpanded = expandedFolderIds.has(folderId);

            el.innerHTML = `
                <button type="button" class="folder-card-inner" aria-expanded="${initiallyExpanded ? 'true' : 'false'}">
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
                <div class="folder-card-notes ${initiallyExpanded ? 'folder-expanded' : 'folder-collapsed'}" data-folder-notes="${escapeHtml(folderId)}">
                    <div class="folder-card-notes-inner"></div>
                </div>
            `;

            const notesSection = el.querySelector('.folder-card-notes');
            const inner = el.querySelector('.folder-card-notes-inner');
            const folderButton = el.querySelector('.folder-card-inner');

            if (initiallyExpanded) {
                el.classList.add('is-expanded');
                renderFolderNotes(inner, notes);
            }

            folderButton.addEventListener('click', () => {
                const isCollapsed = notesSection.classList.contains('folder-collapsed');
                setFolderExpanded(el, notesSection, folderButton, isCollapsed, notes, inner);
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

        return {
            createFolderCard,
            createNoteCard,
            expandFolderById(folderId, notesByFolder) {
                const folderCard = document.querySelector(`.folder-card[data-folder-id="${CSS.escape(folderId)}"]`);
                if (!folderCard) return;
                const notesSection = folderCard.querySelector('.folder-card-notes');
                const inner = folderCard.querySelector('.folder-card-notes-inner');
                const folderButton = folderCard.querySelector('.folder-card-inner');
                if (!notesSection || !inner || !folderButton) return;
                setFolderExpanded(
                    folderCard,
                    notesSection,
                    folderButton,
                    true,
                    notesByFolder[folderId] || [],
                    inner,
                );
            },
        };
    }

    global.APStudyNotesListCards = {
        createNotesListCards,
    };
})(window);
