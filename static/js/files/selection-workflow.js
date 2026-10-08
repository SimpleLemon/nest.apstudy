// Owns the selection sets and their row/action-bar projection.
export function createSelectionWorkflow({ state, els, cssEscape, formatCount }) {
    function setSelection(type, id, selected) {
        if (!id) return;
        const target = type === "file" ? state.selectedFileIds : state.selectedFolderIds;
        if (selected) target.add(id);
        else target.delete(id);
        updateRowSelection(type, id, selected);
        updateSelectionBar();
    }

    function updateRowSelection(type, id, selected) {
        const selector = type === "file" ? `[data-file-id="${cssEscape(id)}"]` : `[data-folder-id="${cssEscape(id)}"]`;
        document.querySelector(selector)?.classList.toggle("is-selected", selected);
    }

    function clearSelection() {
        state.selectedFileIds.clear();
        state.selectedFolderIds.clear();
        document.querySelectorAll("[data-select-file], [data-select-folder]").forEach((checkbox) => {
            checkbox.checked = false;
        });
        document.querySelectorAll(".files-row.is-selected").forEach((row) => row.classList.remove("is-selected"));
        updateSelectionBar();
    }

    function updateSelectionBar() {
        const total = selectedTotal();
        if (els.selectionBar) els.selectionBar.hidden = total === 0;
        if (els.selectionCount) els.selectionCount.textContent = `${formatCount(total, "item")} selected`;
        if (els.bulkMove) els.bulkMove.disabled = total === 0;
        if (els.bulkDelete) els.bulkDelete.disabled = total === 0;
        if (els.bulkDownload) {
            els.bulkDownload.disabled = state.selectedFileIds.size === 0;
            els.bulkDownload.title = state.selectedFileIds.size === 0 ? "Select at least one file to download" : "";
        }
    }

    function selectedTotal() {
        return state.selectedFileIds.size + state.selectedFolderIds.size;
    }

    return { clearSelection, selectedTotal, setSelection, updateSelectionBar };
}
