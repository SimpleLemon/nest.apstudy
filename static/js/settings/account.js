import { downloadJson, fetchJson, showToast } from './utils.js';
const global = window;
const endpoints = { passwordRecovery: '/settings/api/account/recovery', deleteAccount: '/settings/api/account/delete', exportData: '/settings/api/export' };
export function createSettingsAccount(getEmail) {
  const elements = {
    email: document.getElementById('settings-email'),
  };

  async function handlePasswordReset() {
    const email = getEmail() || elements.email?.value || '';
    if (!email) {
      global.APStudyFormField?.markInvalid?.(elements.email);
      showToast('Email address is required for password recovery.', 'error');
      return;
    }
    global.APStudyFormField?.clearInvalid?.(elements.email);

    try {
      await fetchJson(endpoints.passwordRecovery, { method: 'POST' });
      showToast('Password reset email sent.', 'success');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Try again in a moment.', 'error', { title: 'Couldn’t send reset email' });
    }
  }

  async function handleDeleteAccount() {
    const confirmed = await (global.APStudyConfirm?.request?.({
      title: 'Delete account?',
      message: 'This removes your profile, settings, and saved data.',
      acceptLabel: 'Delete account',
      danger: true,
    }) ?? Promise.resolve(false));
    if (!confirmed) {
      return;
    }

    if (global.APStudyUndo?.stage) {
      global.APStudyUndo.stage({
        title: 'Account deletion scheduled',
        message: 'Your account will be deleted when this notice closes.',
        type: 'warning',
        commit: ({ reason }) => fetchJson(endpoints.deleteAccount, {
          method: 'POST',
          keepalive: reason === 'pagehide',
        }),
        restore: () => {},
        onUndo: () => showToast('Your account was kept.', 'success'),
        onCommit: () => global.APStudyAuth?.logout?.(),
        errorTitle: 'Couldn’t delete account',
      });
      return;
    }

    try {
      await fetchJson(endpoints.deleteAccount, { method: 'POST' });
      if (typeof global.APStudyAuth?.logout !== 'function') {
        throw new Error('Logout service is unavailable. Refresh the page and sign out.');
      }
      await global.APStudyAuth.logout();
    } catch (error) {
      showToast(error.message || 'Try again in a moment.', 'error', { title: 'Couldn’t delete account' });
    }
  }

  async function handleExportData() {
    try {
      const data = await fetchJson(endpoints.exportData);
      downloadJson(`apstudy-export-${Date.now()}.json`, data);
      showToast('Export started.', 'success');
    } catch (error) {
      showToast(error.message || 'Try again in a moment.', 'error', { title: 'Couldn’t export your data' });
    }
  }

  function mount() {
    document.getElementById('settings-change-password')?.addEventListener('click', () => void handlePasswordReset());
    document.getElementById('settings-delete-account')?.addEventListener('click', () => void handleDeleteAccount());
    document.getElementById('settings-export-data')?.addEventListener('click', () => void handleExportData());
  }
  return { mount };
}
