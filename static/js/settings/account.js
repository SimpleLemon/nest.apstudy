(function registerSettingsAccount(global) {
  function createSettingsAccount({
    elements,
    state,
    endpoints,
    callbacks,
  }) {
    const {
      downloadJson,
      fetchJson,
      showToast,
    } = callbacks;

    async function handlePasswordReset() {
      const email = (state.profile && state.profile.email)
        || (state.account && state.account.email)
        || elements.email?.value
        || '';
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
        showToast(error.message || 'Unable to start password recovery.', 'error');
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

      try {
        await fetchJson(endpoints.deleteAccount, { method: 'POST' });
        showToast('Account deleted.', 'success');
        global.setTimeout(() => {
          global.location.assign('/logout');
        }, 500);
      } catch (error) {
        showToast(error.message || 'Unable to delete account.', 'error');
      }
    }

    async function handleExportData() {
      try {
        const data = await fetchJson(endpoints.exportData);
        downloadJson(`apstudy-export-${Date.now()}.json`, data);
        showToast('Export started.', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to export data.', 'error');
      }
    }

    return {
      handleDeleteAccount,
      handleExportData,
      handlePasswordReset,
    };
  }

  global.APStudySettingsAccount = {
    createSettingsAccount,
  };
})(window);
