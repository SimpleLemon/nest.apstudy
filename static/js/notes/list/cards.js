(function registerNotesListCards(global) {
    function createNotesListCards({ callbacks }) {
        const {
            closeAllMenus,
            escapeHtml,
            formatCount,
            formatDate,
            notePreview,
            openFolder,
            openSharedFolder,
            openFolderModal,
            openMoveModal,
            preloadEditorBundle,
            toggleCardMenu,
        } = callbacks;

        function createNoteCard(note, { readOnly = false } = {}) {
            const noteId = note.$id || note.id || '';
            const title = note.title || 'Untitled';
            const card = document.createElement('article');
            card.className = 'note-card';
            card.tabIndex = 0;
            card.dataset.noteId = noteId;
            card.dataset.folderId = note.folder_id || '';
            card.setAttribute('aria-label', `Open note ${title}`);

            const ownerLabel = readOnly && note.owner
                ? `<span class="note-card-owner">Shared by ${escapeHtml(note.owner.name || note.owner.username || 'Nest user')}</span>`
                : '';
            const menuMarkup = readOnly ? '' : `
                <button type="button" class="note-card-menu-btn" aria-label="Note options for ${escapeHtml(title)}" aria-haspopup="menu" aria-expanded="false" aria-controls="note-menu-${escapeHtml(noteId)}">
                    <span class="material-symbols-outlined" aria-hidden="true">more_vert</span>
                </button>`;
            const menuPanelMarkup = readOnly ? '' : `
                <div id="note-menu-${escapeHtml(noteId)}" class="note-card-menu note-menu-hidden" role="menu" aria-label="Actions for ${escapeHtml(title)}">
                    <button type="button" class="note-menu-item" role="menuitem" data-action="open">
                        <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
                        <span>Open</span>
                    </button>
                    <button type="button" class="note-menu-item" role="menuitem" data-action="share">
                        <span class="material-symbols-outlined" aria-hidden="true">person_add</span>
                        <span>Share</span>
                    </button>
                    <button type="button" class="note-menu-item" role="menuitem" data-action="move">
                        <span class="material-symbols-outlined" aria-hidden="true">drive_file_move</span>
                        <span>Move to folder</span>
                    </button>
                    <hr class="note-menu-divider"/>
                    <button type="button" class="note-menu-item note-menu-item-danger" role="menuitem" data-action="delete">
                        <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                        <span>Delete</span>
                    </button>
                </div>`;

            card.classList.toggle('notes-shared-note-card', readOnly);
            card.innerHTML = `
                <div class="note-card-header">
                    <span class="note-card-title">${escapeHtml(title)}</span>
                    ${menuMarkup}
                </div>
                <p class="note-card-preview">${escapeHtml(notePreview(note))}</p>
                <div class="note-card-date">
                    <span>${escapeHtml(formatDate(note.updated_at || note.created_at))}</span>
                    ${ownerLabel}
                </div>
                ${menuPanelMarkup}
            `;

            if (!readOnly) {
                const menuBtn = card.querySelector('.note-card-menu-btn');
                const menu = card.querySelector('.note-card-menu');
                menuBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    toggleCardMenu(menuBtn, menu);
                });

                menu.querySelector('[data-action="open"]').addEventListener('click', (event) => {
                    event.stopPropagation();
                    global.location.href = `/notes/${encodeURIComponent(noteId)}`;
                });
                menu.querySelector('[data-action="move"]').addEventListener('click', (event) => {
                    event.stopPropagation();
                    closeAllMenus();
                    openMoveModal(note);
                });
                menu.querySelector('[data-action="share"]').addEventListener('click', (event) => {
                    event.stopPropagation();
                    closeAllMenus();
                    menuBtn.focus({ preventScroll: true });
                    void global.APStudyNotesSharing?.open({
                        resourceType: 'note',
                        resourceId: noteId,
                        resourceTitle: title,
                    });
                });
            }

            const openNote = () => {
                global.location.href = `/notes/${encodeURIComponent(noteId)}`;
            };
            card.addEventListener('click', (event) => {
                if (event.target.closest('.note-card-menu') || event.target.closest('.note-card-menu-btn')) return;
                if (card.classList.contains('note-card-was-dragged')) {
                    card.classList.remove('note-card-was-dragged');
                    return;
                }
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

        function createFolderCard(folder, notes, { readOnly = false } = {}) {
            const folderId = folder.$id || folder.id || '';
            const folderName = folder.name || 'Untitled Folder';
            const el = document.createElement('article');
            el.className = 'folder-card';
            el.dataset.folderId = folderId;

            const icon = folder.is_shared || readOnly ? 'folder_shared' : 'folder';
            const menuMarkup = readOnly ? '' : `
                <button type="button" class="folder-card-menu-btn" aria-label="Folder options for ${escapeHtml(folderName)}" aria-haspopup="menu" aria-expanded="false" aria-controls="folder-menu-${escapeHtml(folderId)}">
                    <span class="material-symbols-outlined" aria-hidden="true">more_vert</span>
                </button>
                <div id="folder-menu-${escapeHtml(folderId)}" class="folder-card-menu note-menu-hidden" role="menu" aria-label="Actions for ${escapeHtml(folderName)}">
                    <button type="button" class="note-menu-item" role="menuitem" data-action="rename">
                        <span class="material-symbols-outlined" aria-hidden="true">edit</span>
                        <span>Rename</span>
                    </button>
                    <button type="button" class="note-menu-item note-menu-item-danger" role="menuitem" data-action="delete-folder">
                        <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                        <span>Delete</span>
                    </button>
                </div>`;
            el.classList.toggle('notes-shared-folder-card', readOnly);
            el.innerHTML = `
                <button type="button" class="folder-card-inner" aria-label="Open folder ${escapeHtml(folderName)}">
                    <span class="folder-card-icon">
                        <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
                    </span>
                    <span class="folder-card-info">
                        <span class="folder-card-name">${escapeHtml(folderName)}</span>
                        <span class="folder-card-count">${formatCount(notes.length, 'note')}</span>
                    </span>
                </button>
                ${menuMarkup}
            `;

            const folderButton = el.querySelector('.folder-card-inner');
            folderButton.addEventListener('click', () => {
                if (readOnly) openSharedFolder(folderId);
                else openFolder(folderId);
            });

            if (!readOnly) {
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
            }

            return el;
        }

        return {
            createFolderCard,
            createNoteCard,
        };
    }

    global.APStudyNotesListCards = {
        createNotesListCards,
    };
})(window);
