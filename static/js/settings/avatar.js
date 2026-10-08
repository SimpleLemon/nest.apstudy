import { fetchFormData, showToast } from './utils.js';
const global = window;
const endpoints = { avatarUpload: '/settings/api/avatar-upload' };
export function createSettingsAvatar(state, onPreviewChanged, onUploaded) {
  const elements = {
    avatarDropzonePlaceholder: document.getElementById('settings-avatar-dropzone-placeholder'),
    avatarDropzonePreview: document.getElementById('settings-avatar-dropzone-preview'),
    avatarFileButton: document.getElementById('settings-avatar-file-button'),
    avatarModal: document.getElementById('settings-avatar-modal'),
    avatarModalClosers: Array.from(document.querySelectorAll('[data-avatar-modal-close]')),
    avatarModalStatus: document.getElementById('settings-avatar-modal-status'),
    avatarPreview: document.getElementById('settings-avatar-preview'),
    avatarUpload: document.getElementById('settings-avatar-upload'),
    avatarUploadButton: document.getElementById('settings-avatar-upload-button'),
    avatarUploadDropzone: document.getElementById('settings-avatar-dropzone'),
    avatarUploadStatus: document.getElementById('settings-avatar-upload-status'),
  };
  const defaultAvatarUrl = elements.avatarPreview?.dataset.defaultAvatarUrl || '';
  let avatarModalCloseTimer = null;
  function hasImageFiles(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes('Files');
  }

  function setAvatarUploadBusy(isBusy) {
    if (elements.avatarUpload) elements.avatarUpload.disabled = isBusy;
    if (elements.avatarUploadButton) elements.avatarUploadButton.disabled = isBusy;
    if (elements.avatarFileButton) elements.avatarFileButton.disabled = isBusy;
    elements.avatarUploadDropzone?.classList.toggle('is-uploading', isBusy);
    if (elements.avatarUploadDropzone) {
      elements.avatarUploadDropzone.tabIndex = isBusy ? -1 : 0;
    }
  }

  function setAvatarUploadStatus(message) {
    if (elements.avatarUploadStatus) elements.avatarUploadStatus.textContent = message;
    if (elements.avatarModalStatus) elements.avatarModalStatus.textContent = message;
  }

  function syncAvatarDropzonePreview(value) {
    const avatarValue = value && String(value).trim() ? String(value).trim() : '';
    const hasAvatar = Boolean(avatarValue);

    if (elements.avatarDropzonePreview) {
      if (hasAvatar) {
        elements.avatarDropzonePreview.src = settingsAvatarUrlForSize(avatarValue, 176);
        elements.avatarDropzonePreview.removeAttribute('hidden');
      } else {
        elements.avatarDropzonePreview.setAttribute('hidden', '');
      }
      elements.avatarDropzonePreview.onerror = () => {
        elements.avatarDropzonePreview.onerror = null;
        elements.avatarDropzonePreview.setAttribute('hidden', '');
        elements.avatarDropzonePlaceholder?.removeAttribute('hidden');
      };
    }

    if (elements.avatarDropzonePlaceholder) {
      if (hasAvatar) {
        elements.avatarDropzonePlaceholder.setAttribute('hidden', '');
      } else {
        elements.avatarDropzonePlaceholder.removeAttribute('hidden');
      }
    }
  }

  function handleAvatarFile(file) {
    if (!file) {
      return;
    }
    void uploadAvatar(file);
  }

  function openAvatarModal() {
    if (!elements.avatarModal) {
      elements.avatarUpload?.click();
      return;
    }
    global.clearTimeout(avatarModalCloseTimer);
    elements.avatarModal.hidden = false;
    elements.avatarModal.classList.add('is-open');
    document.body.classList.add('settings-avatar-modal-open');
    requestAnimationFrame(() => {
      elements.avatarUploadDropzone?.focus({ preventScroll: true });
    });
  }

  function closeAvatarModal({ returnFocus = true } = {}) {
    if (!elements.avatarModal) {
      return;
    }
    global.clearTimeout(avatarModalCloseTimer);
    elements.avatarModal.hidden = true;
    elements.avatarModal.classList.remove('is-open');
    document.body.classList.remove('settings-avatar-modal-open');
    elements.avatarUploadDropzone?.classList.remove('is-active');
    if (returnFocus) {
      elements.avatarUploadButton?.focus({ preventScroll: true });
    }
  }

  async function uploadAvatar(file) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      showToast('Avatar must be a JPG, PNG, GIF, or WebP image.', 'error');
      if (elements.avatarUpload) elements.avatarUpload.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('Avatar must be 10 MB or smaller.', 'error');
      if (elements.avatarUpload) elements.avatarUpload.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('avatar', file);
    setAvatarUploadBusy(true);
    setAvatarUploadStatus('Uploading...');

    try {
      const response = await fetchFormData(endpoints.avatarUpload, formData);
      state.profile = {
        ...(state.profile || {}),
        ...response,
      };
      updateAvatarPreview(response.picture_url || '');
      updateNavbarAvatar(response.picture_url || '');
      setAvatarUploadStatus('Avatar uploaded.');
      onUploaded();
      showToast('Avatar uploaded.', 'success');
      avatarModalCloseTimer = global.setTimeout(() => closeAvatarModal(), 450);
    } catch (error) {
      setAvatarUploadStatus('JPG, PNG, GIF, or WebP. Max 10 MB.');
      showToast(error.message || 'Check the image and try again.', 'error', { title: 'Couldn’t upload avatar' });
    } finally {
      setAvatarUploadBusy(false);
      if (elements.avatarUpload) {
        elements.avatarUpload.value = '';
      }
    }
  }

  function updateNavbarAvatar(pictureUrl) {
    const navbarAvatar = document.querySelector('#navbar-avatar-btn img');
    if (!navbarAvatar || !pictureUrl) {
      return;
    }
    setAvatarImageSource(navbarAvatar, pictureUrl, 48, 96);
    navbarAvatar.sizes = '48px';
  }

  function updateAvatarPreview(value) {
    const avatarValue = value && value.trim() ? value.trim() : '';
    syncAvatarDropzonePreview(avatarValue);
    if (!elements.avatarPreview) {
      return;
    }
    setAvatarImageSource(elements.avatarPreview, avatarValue, 150, 300);
    elements.avatarPreview.sizes = '(max-width: 640px) 96px, 150px';
    elements.avatarPreview.onerror = () => {
      elements.avatarPreview.onerror = null;
      setAvatarImageSource(elements.avatarPreview, '', 150, 300);
    };
    onPreviewChanged();
  }

  function setAvatarImageSource(image, value, size, doubleSize) {
    const src = settingsAvatarUrlForSize(value, size) || defaultAvatarUrl;
    image.src = src;
    if (src && !src.startsWith('data:')) {
      const doubleSrc = settingsAvatarUrlForSize(value, doubleSize) || defaultAvatarUrl;
      image.srcset = `${src} 1x, ${doubleSrc} 2x`;
    } else {
      image.removeAttribute('srcset');
    }
  }

  function settingsAvatarUrlForSize(url, size = 32) {
    if (typeof global.APSTUDY_AVATAR_URL_FOR_SIZE === 'function') {
      return global.APSTUDY_AVATAR_URL_FOR_SIZE(url, size);
    }
    return String(url || '').trim();
  }

  function bind() {
    elements.avatarUploadButton?.addEventListener('click', () => {
      openAvatarModal();
    });
    elements.avatarFileButton?.addEventListener('click', () => {
      elements.avatarUpload?.click();
    });
    elements.avatarUpload?.addEventListener('change', () => {
      const file = elements.avatarUpload.files && elements.avatarUpload.files[0];
      handleAvatarFile(file);
    });
    elements.avatarUploadDropzone?.addEventListener('click', () => {
      elements.avatarUpload?.click();
    });
    elements.avatarUploadDropzone?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        elements.avatarUpload?.click();
      }
    });
    elements.avatarUploadDropzone?.addEventListener('dragover', (event) => {
      if (!hasImageFiles(event)) {
        return;
      }
      event.preventDefault();
      elements.avatarUploadDropzone.classList.add('is-active');
    });
    elements.avatarUploadDropzone?.addEventListener('dragleave', () => {
      elements.avatarUploadDropzone.classList.remove('is-active');
    });
    elements.avatarUploadDropzone?.addEventListener('drop', (event) => {
      if (!hasImageFiles(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      elements.avatarUploadDropzone.classList.remove('is-active');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0];
      handleAvatarFile(file);
    });
    elements.avatarModalClosers?.forEach((node) => {
      node.addEventListener('click', () => closeAvatarModal());
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && elements.avatarModal && !elements.avatarModal.hidden) {
        closeAvatarModal();
      }
    });
  }
  return { bind, updateAvatarPreview, updateNavbarAvatar };
}
