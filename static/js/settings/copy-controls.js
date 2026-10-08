import { copyText, flashCopyButton, showToast } from './utils.js';
export function bindSettingsCopyButtons() {
  Array.from(document.querySelectorAll('[data-copy-target]')).forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.getAttribute('data-copy-target');
      const input = targetId ? document.getElementById(targetId) : null;
      const value = input?.value || '';
      if (!value) {
        showToast('Nothing to copy.', 'error');
        return;
      }
      try {
        await copyText(value);
        flashCopyButton(button);
        showToast('Copied to clipboard.', 'success');
      } catch (error) {
        showToast(error.message || 'Clipboard access failed. Try copying the text manually.', 'error');
      }
    });
  });
}
