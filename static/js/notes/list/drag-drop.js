(function registerNotesListDragDrop(global) {
    const DRAG_DEVICE_QUERY = '(min-width: 600px), (pointer: fine)';
    const PHONE_USER_AGENT = /Mobi|Android.*Mobile|iPhone|iPod/i;

    function canUseNoteDrag(scope = global) {
        const userAgent = scope.navigator?.userAgent || '';
        if (PHONE_USER_AGENT.test(userAgent)) return false;
        return Boolean(scope.matchMedia?.(DRAG_DEVICE_QUERY)?.matches);
    }

    function createNotesListDragDrop({ notesGrid, foldersGrid, page, onStart, onEnd }) {
        let sortable = null;
        let pendingFolderId;
        let isDragging = false;
        const mediaQuery = global.matchMedia?.(DRAG_DEVICE_QUERY);

        function clearFolderTargets() {
            foldersGrid?.querySelectorAll('.folder-card.is-drop-target').forEach((folderCard) => {
                folderCard.classList.remove('is-drop-target');
            });
        }

        function handleFolderDragOver(event) {
            if (!isDragging) return;
            const folderCard = event.target.closest?.('.folder-card');
            if (!folderCard || !foldersGrid?.contains(folderCard)) return;
            event.preventDefault();
            foldersGrid.querySelectorAll('.folder-card.is-drop-target').forEach((candidate) => {
                candidate.classList.toggle('is-drop-target', candidate === folderCard);
            });
        }

        function handleFolderDragLeave(event) {
            if (!isDragging) return;
            const folderCard = event.target.closest?.('.folder-card');
            if (!folderCard || folderCard.contains(event.relatedTarget)) return;
            folderCard.classList.remove('is-drop-target');
        }

        function handleFolderDrop(event) {
            if (!isDragging) return;
            const folderCard = event.target.closest?.('.folder-card');
            if (!folderCard || !foldersGrid?.contains(folderCard)) return;
            event.preventDefault();
            pendingFolderId = folderCard.dataset.folderId || null;
            folderCard.classList.remove('is-drop-target');
        }

        function bindFolderEvents() {
            foldersGrid?.addEventListener('dragover', handleFolderDragOver);
            foldersGrid?.addEventListener('dragleave', handleFolderDragLeave);
            foldersGrid?.addEventListener('drop', handleFolderDrop);
        }

        function destroy() {
            sortable?.destroy?.();
            sortable = null;
            pendingFolderId = undefined;
            isDragging = false;
            clearFolderTargets();
            page?.classList.remove('notes-drag-enabled', 'is-dragging-note');
        }

        function mount() {
            destroy();
            if (!canUseNoteDrag(global) || !notesGrid || !global.Sortable) return;

            page?.classList.add('notes-drag-enabled');
            sortable = global.Sortable.create(notesGrid, {
                group: { name: 'notes', pull: true, put: true },
                animation: global.APStudyAccessibility?.prefersReducedMotion?.() ? 0 : 150,
                draggable: '.note-card',
                delay: 260,
                delayOnTouchOnly: true,
                touchStartThreshold: 8,
                fallbackTolerance: 6,
                ghostClass: 'note-card-ghost',
                chosenClass: 'note-card-chosen',
                dragClass: 'note-card-drag',
                onStart(event) {
                    pendingFolderId = undefined;
                    isDragging = true;
                    page?.classList.add('is-dragging-note');
                    onStart?.(event);
                },
                onEnd(event) {
                    const droppedOnFolder = pendingFolderId !== undefined;
                    const droppedFolderId = pendingFolderId;
                    const item = event.item;
                    isDragging = false;
                    page?.classList.remove('is-dragging-note');
                    clearFolderTargets();
                    if (item) {
                        item.classList.add('note-card-was-dragged');
                        global.setTimeout(() => item.classList.remove('note-card-was-dragged'), 250);
                    }
                    pendingFolderId = undefined;
                    onEnd?.(event, { droppedOnFolder, droppedFolderId });
                },
            });
        }

        function sync() {
            const enabled = canUseNoteDrag(global);
            if (!enabled && sortable) destroy();
            if (enabled && !sortable && notesGrid?.querySelector('.note-card')) mount();
            page?.classList.toggle('notes-drag-enabled', enabled && Boolean(sortable));
        }

        bindFolderEvents();
        if (mediaQuery?.addEventListener) mediaQuery.addEventListener('change', sync);
        else mediaQuery?.addListener?.(sync);

        return {
            destroy,
            mount,
            sync,
        };
    }

    global.APStudyNotesListDragDrop = {
        canUseNoteDrag,
        createNotesListDragDrop,
    };
})(window);
