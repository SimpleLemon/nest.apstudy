(function registerSettingsPreferences(global) {
  function createSettingsPreferences({
    elements,
    state,
    constants,
    endpoints,
    callbacks,
  }) {
    const {
      pendingThemeStorageKey,
      pendingThemeUpdatedKey,
    } = constants;
    const {
      applySidebarDefault,
      applyThemePreference,
      fetchJson,
      getToggleState,
      normalizeSidebarDefault,
      normalizeThemeValue,
      resolveLocalTimezone,
      setToggleState,
      showToast,
    } = callbacks;

    function warnSettingsStorageFailure(action, error) {
      console.warn(`Unable to ${action}; settings theme preview will continue visually.`, error);
    }

    function clearPendingThemeStorage() {
      try {
        localStorage.removeItem(pendingThemeStorageKey);
        localStorage.removeItem(pendingThemeUpdatedKey);
      } catch (error) {
        warnSettingsStorageFailure('clear pending theme storage', error);
      }
    }

    function bindThemeChoiceButtons() {
      if (!elements.themeChoices || !elements.themeChoices.length) return;
      elements.themeChoices.forEach((btn) => {
        btn.addEventListener('click', () => {
          const themeVal = btn.getAttribute('data-theme');
          if (elements.theme) elements.theme.value = normalizeThemeValue(themeVal);
          state.pendingTheme = normalizeThemeValue(themeVal);
          applyThemePreference(themeVal);
          syncThemeChoices();
        });
      });
    }

    function bindTimezoneHelper() {
      elements.useCurrentTimezone?.addEventListener('click', () => {
        if (!elements.timezone) {
          return;
        }
        elements.timezone.value = resolveLocalTimezone();
        showToast('Timezone updated from your device.', 'success');
      });
    }

    function syncThemeControls() {
      const settings = state.settings || {};
      const themeValue = normalizeThemeValue(settings.interface_theme || settings.theme);
      state.pendingTheme = '';
      const sidebarValue = normalizeSidebarDefault(settings.sidebar_default);
      if (elements.theme) {
        elements.theme.value = themeValue;
      }
      if (elements.sidebarDefault) {
        elements.sidebarDefault.value = sidebarValue;
      }
      syncThemeChoices();
    }

    function syncThemeChoices() {
      if (!elements.themeChoices) return;
      const settings = state.settings || {};
      const current = state.pendingTheme || normalizeThemeValue(settings.interface_theme || settings.theme);
      elements.themeChoices.forEach((btn) => {
        const btnTheme = btn.getAttribute('data-theme') || '';
        const normalized = normalizeThemeValue(btnTheme);
        const active = normalized === current;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function syncToggleControls() {
      const settings = state.settings || {};
      elements.toggleButtons.forEach((button) => {
        const field = button.getAttribute('data-toggle-field');
        const active = field ? Boolean(settings[field]) : false;
        setToggleState(button, active);
      });
    }

    async function savePreferences() {
      const interfaceTheme = normalizeThemeValue(elements.theme?.value);
      const payload = {
        interface_theme: interfaceTheme,
        sidebar_default: normalizeSidebarDefault(elements.sidebarDefault?.value),
        email_notifications: getToggleState('email_notifications'),
        product_updates: getToggleState('product_updates'),
        task_sound_enabled: getToggleState('task_sound_enabled'),
        chat_sound_enabled: getToggleState('chat_sound_enabled'),
        language: elements.language?.value || 'en',
        timezone: elements.timezone?.value.trim() || '',
      };

      try {
        const response = await fetchJson(endpoints.preferences, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        state.settings = {
          ...(state.settings || {}),
          ...response,
        };
        clearPendingThemeStorage();
        syncThemeControls();
        syncToggleControls();
        applyThemePreference(response.interface_theme || payload.interface_theme);
        applySidebarDefault(response.sidebar_default || payload.sidebar_default);
        showToast('Preferences saved.', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to save preferences.', 'error');
      }
    }

    return {
      bindThemeChoiceButtons,
      bindTimezoneHelper,
      savePreferences,
      syncThemeControls,
      syncToggleControls,
    };
  }

  global.APStudySettingsPreferences = {
    createSettingsPreferences,
  };
})(window);
