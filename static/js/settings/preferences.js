import { fetchJson, showToast } from './utils.js';
import { applySidebarDefault, applyThemePreference, getToggleState, normalizeSidebarDefault, normalizeThemeValue, setToggleState } from './preference-utils.js';
import { mountRegionComboboxes } from './region.js';
const pendingThemeStorageKey = 'apstudy-theme-pending';
const pendingThemeUpdatedKey = 'apstudy-theme-updated-at';
const endpoints = { preferences: '/settings/api/interface-preferences' };
export function createSettingsPreferences(state) {
  const elements = {
    languageComboboxRoot: document.querySelector('[data-settings-combobox="language"]'),
    timezoneComboboxRoot: document.querySelector('[data-settings-combobox="timezone"]'),
    language: document.getElementById('settings-language'),
    sidebarDefault: document.getElementById('settings-sidebar-default'),
    theme: document.getElementById('settings-theme'),
    themeChoices: Array.from(document.querySelectorAll('.settings-theme-choice')),
    timezone: document.getElementById('settings-timezone'),
    toggleButtons: Array.from(document.querySelectorAll('[data-toggle-field]')),
  };

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
      showToast(error.message || 'Try again in a moment.', 'error', { title: 'Couldn’t save preferences' });
    }
  }

  function mount() {
    bindThemeChoiceButtons();
    mountRegionComboboxes(elements);
    elements.toggleButtons.forEach((button) => button.addEventListener('click', () => {
      if (button.getAttribute('data-toggle-field')) setToggleState(button, !button.classList.contains('is-active'));
    }));
    ['settings-save-appearance', 'settings-save-notifications', 'settings-save-region'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => void savePreferences());
    });
  }
  function hydrate() {
    const settings = state.settings || {};
    if (elements.languageCombobox) elements.languageCombobox.setValue(settings.language || 'en');
    else if (elements.language) elements.language.value = settings.language || 'en';
    if (elements.timezoneCombobox) elements.timezoneCombobox.setValue(settings.timezone || '');
    else if (elements.timezone) elements.timezone.value = settings.timezone || '';
  }
  function syncSavedPreferences() {
    syncThemeControls();
    syncToggleControls();
  }
  return { mount, hydrate, syncSavedPreferences };
}
