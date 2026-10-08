export { escapeHtml } from '../core/ui-primitives-module.js';

export function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatCount(value, singularLabel) {
  const count = Number(value || 0);
  const normalizedCount = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  const pluralLabel = `${singularLabel}s`;
  return `${normalizedCount} ${normalizedCount === 1 ? singularLabel : pluralLabel}`;
}

export function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function fetchJson(url, options = {}) {
  return window.APStudyHttp.fetchJson(url, {
    ...options,
    jsonMode: 'required',
    pendingLabel: options.pendingLabel || 'settings-save',
  });
}

export async function fetchFormData(url, formData) {
  return fetchJson(url, {
    method: 'POST',
    body: formData,
  });
}

export async function copyText(text) {
  if (!text) {
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temporaryInput = document.createElement('input');
  temporaryInput.value = text;
  document.body.appendChild(temporaryInput);
  try {
    temporaryInput.select();
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard access failed. Try copying the text manually.');
    }
  } finally {
    temporaryInput.remove();
  }
}

export function flashCopyButton(button) {
  const previousHtml = button.innerHTML;
  button.classList.add('is-copied');
  button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">check</span>';
  window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.innerHTML = previousHtml;
  }, 1200);
}

export function showToast(message, type, options = {}) {
  if (window.APStudyToast) {
    window.APStudyToast.show({
      message,
      title: options.title,
      type: type === 'warning' ? 'warning' : type === 'error' ? 'error' : type === 'info' ? 'info' : 'success',
      action: options.action,
      duration: options.duration,
    });
  }
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
