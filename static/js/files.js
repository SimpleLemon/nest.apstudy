/**
 * files.js
 * Handles file upload, preview, and deletion for the Files page.
 */

(function() {
    'use strict';

    // DOM Elements
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const uploadProgress = document.getElementById('upload-progress');
    const filesGrid = document.getElementById('files-grid');
    const filesEmpty = document.getElementById('files-empty');
    const filesSearch = document.getElementById('files-search');
    const uploadFilesBtn = document.getElementById('upload-files-btn');
    const browseFilesBtn = document.getElementById('browse-files-btn');
    const emptyUploadBtn = document.getElementById('empty-upload-btn');
    const uploadZoneBtn = document.getElementById('upload-files-btn');

    // Preview Modal
    const previewModal = document.getElementById('file-preview-modal');
    const previewBackdrop = document.getElementById('file-preview-backdrop');
    const previewFileName = document.getElementById('preview-file-name');
    const previewFileIcon = document.getElementById('preview-file-icon');
    const previewContent = document.getElementById('preview-content');
    const previewDownloadBtn = document.getElementById('preview-download-btn');
    const previewCloseBtn = document.getElementById('preview-close-btn');

    // Delete Modal
    const deleteModal = document.getElementById('delete-confirm-modal');
    const deleteBackdrop = document.getElementById('delete-backdrop');
    const deleteFileName = document.getElementById('delete-file-name');
    const deleteCancelBtn = document.getElementById('delete-cancel-btn');
    const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

    let currentFileId = null;
    let allFiles = [];

    // File type icons
    const FILE_ICONS = {
        pdf: 'picture_as_pdf',
        doc: 'description',
        docx: 'description',
        ppt: 'slideshow',
        pptx: 'slideshow',
        xls: 'table_chart',
        xlsx: 'table_chart',
        jpg: 'image',
        jpeg: 'image',
        png: 'image',
        mp4: 'play_circle',
        default: 'insert_drive_file'
    };

    // File type categories
    const FILE_CATEGORIES = {
        document: ['pdf', 'doc', 'docx'],
        presentation: ['ppt', 'pptx'],
        spreadsheet: ['xls', 'xlsx'],
        image: ['jpg', 'jpeg', 'png'],
        video: ['mp4']
    };

    function getFileExtension(filename) {
        return filename.split('.').pop().toLowerCase();
    }

    function getFileIcon(filename) {
        const ext = getFileExtension(filename);
        return FILE_ICONS[ext] || FILE_ICONS.default;
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    // Fetch files from API
    async function fetchFiles() {
        try {
            const response = await fetch('/api/files');
            if (!response.ok) throw new Error('Failed to fetch files');
            const data = await response.json();
            allFiles = data.files || [];
            renderFiles();
        } catch (error) {
            console.error('Error fetching files:', error);
            filesGrid.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center py-20">
                    <span class="material-symbols-outlined text-[48px] text-red-400 mb-4">error</span>
                    <p class="text-on-surface-variant text-sm">Failed to load files. Please try again.</p>
                </div>
            `;
        }
    }

    // Render files grid
    function renderFiles(filter = '') {
        const filteredFiles = filter
            ? allFiles.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()))
            : allFiles;

        if (filteredFiles.length === 0) {
            filesGrid.classList.add('hidden');
            filesEmpty.classList.remove('hidden');
            if (filter && allFiles.length > 0) {
                filesEmpty.querySelector('h3').textContent = 'No matching files';
                filesEmpty.querySelector('p').textContent = `No files match "${filter}".`;
                filesEmpty.querySelector('button').classList.add('hidden');
            } else {
                filesEmpty.querySelector('h3').textContent = 'No files yet';
                filesEmpty.querySelector('p').textContent = 'Upload your first file to get started.';
                filesEmpty.querySelector('button').classList.remove('hidden');
            }
        } else {
            filesGrid.classList.remove('hidden');
            filesEmpty.classList.add('hidden');
            filesGrid.innerHTML = filteredFiles.map(file => `
                <div class="file-card group bg-surface-container-low rounded-xl border border-outline-variant/10 hover:border-primary/30 transition-all duration-200 cursor-pointer overflow-hidden" data-file-id="${file.id}">
                    <div class="p-4 flex items-start gap-3">
                        <span class="material-symbols-outlined text-primary text-[32px] shrink-0">${getFileIcon(file.name)}</span>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-medium text-on-surface truncate" title="${file.name}">${file.name}</h3>
                            <p class="text-xs text-on-surface-variant mt-1">${formatFileSize(file.size)} • ${formatDate(file.created_at)}</p>
                        </div>
                    </div>
                    <div class="px-4 py-3 border-t border-outline-variant/10 flex items-center justify-between bg-surface-container/50">
                        <button class="preview-btn inline-flex items-center gap-1 text-xs text-primary hover:text-primary-container transition-colors" data-file-id="${file.id}">
                            <span class="material-symbols-outlined text-[16px]">visibility</span>
                            Preview
                        </button>
                        <button class="delete-btn inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors" data-file-id="${file.id}">
                            <span class="material-symbols-outlined text-[16px]">delete</span>
                            Delete
                        </button>
                    </div>
                </div>
            `).join('');
        }
    }

    // Preview file
    function previewFile(fileId) {
        const file = allFiles.find(f => f.id === fileId);
        if (!file) return;

        currentFileId = fileId;
        previewFileName.textContent = file.name;
        previewFileIcon.textContent = getFileIcon(file.name);

        const ext = getFileExtension(file.name);
        if (['jpg', 'jpeg', 'png'].includes(ext)) {
            previewContent.innerHTML = `
                <img src="/api/files/${fileId}/download" alt="${file.name}" class="max-w-full h-auto rounded-lg" />
            `;
        } else if (ext === 'pdf') {
            previewContent.innerHTML = `
                <iframe src="/api/files/${fileId}/download" class="w-full h-[600px] rounded-lg" title="${file.name}"></iframe>
            `;
        } else {
            previewContent.innerHTML = `
                <div class="flex flex-col items-center justify-center py-20">
                    <span class="material-symbols-outlined text-[64px] text-on-surface-variant mb-4">description</span>
                    <h3 class="text-lg font-headline font-medium text-on-surface mb-2">${file.name}</h3>
                    <p class="text-sm text-on-surface-variant mb-6">Preview not available for this file type.</p>
                    <button class="preview-download-btn inline-flex items-center gap-2 rounded-lg bg-primary text-on-primary px-5 py-2.5 text-sm font-medium hover:scale-[1.02] transition-transform shadow-lg shadow-primary/20" data-file-id="${file.id}">
                        <span class="material-symbols-outlined text-[20px]">download</span>
                        Download to view
                    </button>
                </div>
            `;
            previewContent.querySelector('.preview-download-btn').addEventListener('click', () => downloadFile(fileId));
        }

        // Setup download button
        previewDownloadBtn.onclick = () => downloadFile(fileId);

        previewModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    // Download file
    function downloadFile(fileId) {
        window.open(`/api/files/${fileId}/download`, '_blank');
    }

    // Delete file
    function deleteFile(fileId) {
        const file = allFiles.find(f => f.id === fileId);
        if (!file) return;

        deleteFileName.textContent = `"${file.name}" will be permanently deleted.`;
        deleteModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    async function confirmDelete() {
        if (!currentFileId) return;

        try {
            const response = await fetch(`/api/files/${currentFileId}`, {
                method: 'DELETE'
            });

            if (!response.ok) throw new Error('Failed to delete file');

            deleteModal.classList.add('hidden');
            previewModal.classList.add('hidden');
            document.body.style.overflow = '';
            currentFileId = null;

            // Refresh files
            await fetchFiles();
        } catch (error) {
            console.error('Error deleting file:', error);
            alert('Failed to delete file. Please try again.');
        }
    }

    // Upload files
    async function uploadFiles(files) {
        if (!files || files.length === 0) return;

        uploadProgress.classList.remove('hidden');
        uploadZone.classList.remove('hidden');

        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);

            const uploadItem = document.createElement('div');
            uploadItem.className = 'flex items-center gap-3 p-3 rounded-lg bg-surface-container-low';
            uploadItem.innerHTML = `
                <span class="material-symbols-outlined text-primary">upload_file</span>
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-on-surface truncate">${file.name}</p>
                    <div class="w-full bg-surface-container-high rounded-full h-2 mt-1">
                        <div class="upload-progress-bar bg-primary h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                </div>
                <span class="upload-status text-xs text-on-surface-variant">Uploading...</span>
            `;
            uploadProgress.appendChild(uploadItem);

            try {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/files/upload', true);

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        uploadItem.querySelector('.upload-progress-bar').style.width = `${percent}%`;
                        uploadItem.querySelector('.upload-status').textContent = `${percent}%`;
                    }
                });

                xhr.addEventListener('load', () => {
                    if (xhr.status === 200 || xhr.status === 201) {
                        uploadItem.querySelector('.upload-status').textContent = '✓';
                        uploadItem.querySelector('.upload-status').className = 'upload-status text-xs text-emerald-400';
                        uploadItem.querySelector('.material-symbols-outlined').textContent = 'check_circle';
                        uploadItem.querySelector('.material-symbols-outlined').className = 'text-emerald-400';
                        setTimeout(() => {
                            uploadItem.remove();
                            if (uploadProgress.children.length === 0) {
                                uploadProgress.classList.add('hidden');
                                uploadZone.classList.add('hidden');
                            }
                        }, 2000);
                        fetchFiles();
                    } else {
                        throw new Error('Upload failed');
                    }
                });

                xhr.addEventListener('error', () => {
                    uploadItem.querySelector('.upload-status').textContent = '✗';
                    uploadItem.querySelector('.upload-status').className = 'upload-status text-xs text-red-400';
                    uploadItem.querySelector('.material-symbols-outlined').textContent = 'error';
                    uploadItem.querySelector('.material-symbols-outlined').className = 'text-red-400';
                });

                xhr.send(formData);
            } catch (error) {
                console.error('Upload error:', error);
            }
        }
    }

    // Setup event listeners
    function setupEventListeners() {
        // Upload button
        uploadFilesBtn?.addEventListener('click', () => {
            uploadZone.classList.toggle('hidden');
            fileInput.click();
        });

        // Browse files button
        browseFilesBtn?.addEventListener('click', () => fileInput.click());

        // Empty state upload button
        emptyUploadBtn?.addEventListener('click', () => {
            uploadZone.classList.remove('hidden');
            fileInput.click();
        });

        // File input change
        fileInput?.addEventListener('change', (e) => {
            uploadFiles(e.target.files);
            fileInput.value = '';
        });

        // Drag and drop
        uploadZone?.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('border-primary/40', 'bg-surface-container-high');
        });

        uploadZone?.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('border-primary/40', 'bg-surface-container-high');
        });

        uploadZone?.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('border-primary/40', 'bg-surface-container-high');
            uploadFiles(e.dataTransfer.files);
        });

        // Search
        filesSearch?.addEventListener('input', (e) => {
            renderFiles(e.target.value);
        });

        // File grid delegation
        filesGrid?.addEventListener('click', (e) => {
            const previewBtn = e.target.closest('.preview-btn');
            const deleteBtn = e.target.closest('.delete-btn');
            const fileCard = e.target.closest('.file-card');

            if (previewBtn) {
                e.stopPropagation();
                previewFile(previewBtn.dataset.fileId);
            } else if (deleteBtn) {
                e.stopPropagation();
                deleteFile(deleteBtn.dataset.fileId);
            } else if (fileCard) {
                previewFile(fileCard.dataset.fileId);
            }
        });

        // Preview modal close
        previewCloseBtn?.addEventListener('click', () => {
            previewModal.classList.add('hidden');
            document.body.style.overflow = '';
        });

        previewBackdrop?.addEventListener('click', () => {
            previewModal.classList.add('hidden');
            document.body.style.overflow = '';
        });

        // Delete modal
        deleteCancelBtn?.addEventListener('click', () => {
            deleteModal.classList.add('hidden');
            document.body.style.overflow = '';
        });

        deleteBackdrop?.addEventListener('click', () => {
            deleteModal.classList.add('hidden');
            document.body.style.overflow = '';
        });

        deleteConfirmBtn?.addEventListener('click', confirmDelete);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!previewModal.classList.contains('hidden')) {
                    previewModal.classList.add('hidden');
                    document.body.style.overflow = '';
                } else if (!deleteModal.classList.contains('hidden')) {
                    deleteModal.classList.add('hidden');
                    document.body.style.overflow = '';
                }
            }
        });
    }

    // Initialize
    function init() {
        fetchFiles();
        setupEventListeners();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
