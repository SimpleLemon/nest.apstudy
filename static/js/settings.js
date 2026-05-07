/* settings.js
 * Single-page settings UI with hash navigation and Appwrite-backed saves.
 */

const SETTINGS_STATE = {
  account: null,
  profile: null,
  settings: null,
  storageUsageBytes: 0,
  connectedServices: [],
  activeSection: 'account',
  pendingTheme: '',
};

const SETTINGS_SECTION_IDS = ['account', 'data', 'preferences'];
const SETTINGS_THEME_TO_INTERFACE_THEME = {
  dark: 'obsidian-dark',
  light: 'parchment-light',
  system: 'system-match',
};
const SETTINGS_INTERFACE_THEME_TO_THEME = {
  'obsidian-dark': 'dark',
  'nest-dark': 'dark',
  'parchment-light': 'light',
  'nest-light': 'light',
  'system-match': 'system',
};

const SETTINGS_ENDPOINTS = {
  bootstrap: '/settings/api/bootstrap',
  profile: '/settings/api/profile',
  preferences: '/settings/api/interface-preferences',
  exportData: '/settings/api/export',
  deleteAccount: '/settings/api/account/delete',
};

const elements = {};

function initializeSettingsPage() {
  cacheElements();
  bindNavigation();
  bindCopyButtons();
  bindToggleButtons();
  bindActionButtons();
  bindAvatarPreview();
  bindTimezoneHelper();
  elements.themeChoices = Array.from(document.querySelectorAll('.settings-theme-choice'));
  bindThemeChoiceButtons();
  void bootstrapSettingsPage();
}

function bindThemeChoiceButtons() {
  if (!elements.themeChoices || !elements.themeChoices.length) return;
  elements.themeChoices.forEach((btn) => {
    btn.addEventListener('click', () => {
      const themeVal = btn.getAttribute('data-theme');
      // Update hidden select (compat) and visual state
      if (elements.theme) elements.theme.value = normalizeThemeValue(themeVal);
      SETTINGS_STATE.pendingTheme = normalizeThemeValue(themeVal);
      // Apply immediately for preview
      applyThemePreference(themeVal);
      // Update active classes
      syncThemeChoices();
    });
  });
}

function cacheElements() {
  elements.tabs = Array.from(document.querySelectorAll('.settings-tab'));
  elements.sections = Array.from(document.querySelectorAll('.settings-section'));
  elements.copyButtons = Array.from(document.querySelectorAll('[data-copy-target]'));
  elements.toggleButtons = Array.from(document.querySelectorAll('[data-toggle-field]'));
  elements.avatarPreview = document.getElementById('settings-avatar-preview');
  elements.avatarUrl = document.getElementById('settings-avatar-url');
  elements.displayName = document.getElementById('settings-display-name');
  elements.email = document.getElementById('settings-email');
  elements.accountCreated = document.getElementById('settings-account-created');
  elements.accountCreatedData = document.getElementById('settings-account-created-data');
  elements.userId = document.getElementById('settings-user-id');
  elements.school = document.getElementById('settings-school');
  elements.major = document.getElementById('settings-major');
  elements.graduationYear = document.getElementById('settings-graduation-year');
  elements.storageUsed = document.getElementById('settings-storage-used');
  elements.connectedServices = document.getElementById('settings-connected-services');
  elements.theme = document.getElementById('settings-theme');
  elements.sidebarDefault = document.getElementById('settings-sidebar-default');
  elements.language = document.getElementById('settings-language');
  elements.timezone = document.getElementById('settings-timezone');
  elements.useCurrentTimezone = document.getElementById('settings-use-current-timezone');
  elements.saveProfile = document.getElementById('settings-save-profile');
  elements.saveAcademic = document.getElementById('settings-save-academic');
  elements.saveAppearance = document.getElementById('settings-save-appearance');
  elements.saveNotifications = document.getElementById('settings-save-notifications');
  elements.saveRegion = document.getElementById('settings-save-region');
  elements.changePassword = document.getElementById('settings-change-password');
  elements.deleteAccount = document.getElementById('settings-delete-account');
  elements.exportData = document.getElementById('settings-export-data');
  elements.toastHost = document.getElementById('settings-notifications');
}

function bindNavigation() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      const targetId = normalizeSectionId(tab.getAttribute('href'));
      if (!targetId) {
        return;
      }
      // Activate the section without scrolling — use show/hide behavior
      activateSection(targetId, { scroll: false, pushState: true });
    });
  });

  window.addEventListener('hashchange', () => {
    const targetId = normalizeSectionId(window.location.hash) || 'account';
    activateSection(targetId, { scroll: false, pushState: false });
  });

  // We intentionally do NOT observe scrolling for section activation.
  // Settings navigation behaves like tabbed panels: clicking a tab
  // shows the corresponding section without scrolling the page.
}

function bindCopyButtons() {
  elements.copyButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.getAttribute('data-copy-target');
      const input = targetId ? document.getElementById(targetId) : null;
      const value = input?.value || '';
      if (!value) {
        showToast('Nothing to copy.', 'error');
        return;
      }
      await copyText(value);
      flashCopyButton(button);
      showToast('Copied to clipboard.', 'success');
    });
  });
}

function bindToggleButtons() {
  elements.toggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.getAttribute('data-toggle-field');
      if (!field) {
        return;
      }
      const nextValue = !button.classList.contains('is-active');
      setToggleState(button, nextValue);
    });
  });
}

function bindActionButtons() {
  elements.saveProfile?.addEventListener('click', () => void saveProfile());
  elements.saveAcademic?.addEventListener('click', () => void saveProfile());
  elements.saveAppearance?.addEventListener('click', () => void savePreferences());
  elements.saveNotifications?.addEventListener('click', () => void savePreferences());
  elements.saveRegion?.addEventListener('click', () => void savePreferences());
  elements.changePassword?.addEventListener('click', () => void handlePasswordReset());
  elements.deleteAccount?.addEventListener('click', () => void handleDeleteAccount());
  elements.exportData?.addEventListener('click', () => void handleExportData());
}

function bindAvatarPreview() {
  elements.avatarUrl?.addEventListener('input', () => {
    updateAvatarPreview(elements.avatarUrl.value);
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

async function bootstrapSettingsPage() {
  try {
    const [accountResponse, bootstrapResponse] = await Promise.all([
      getCurrentAccount(),
      fetchJson(SETTINGS_ENDPOINTS.bootstrap),
    ]);

    SETTINGS_STATE.account = accountResponse;
    SETTINGS_STATE.profile = bootstrapResponse.profile || null;
    SETTINGS_STATE.settings = bootstrapResponse.settings || null;
    SETTINGS_STATE.storageUsageBytes = Number(bootstrapResponse.storage_usage_bytes || 0);
    SETTINGS_STATE.connectedServices = Array.isArray(bootstrapResponse.connected_services)
      ? bootstrapResponse.connected_services
      : [];

    populateFields();
    renderConnectedServices();
    syncThemeControls();
    syncToggleControls();
    syncHashOnLoad();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to load settings right now.', 'error');
    syncHashOnLoad();
  }
}

async function getCurrentAccount() {
  if (!window.account || typeof account.get !== 'function') {
    return null;
  }
  try {
    return await account.get();
  } catch (error) {
    console.error('Failed to load Appwrite account', error);
    return null;
  }
}

function populateFields() {
  const profile = SETTINGS_STATE.profile || {};
  const accountData = SETTINGS_STATE.account || {};
  const settings = SETTINGS_STATE.settings || {};

  const displayName = profile.name || accountData.name || '';
  const email = profile.email || accountData.email || '';
  const accountId = profile.id || accountData.$id || accountData.id || '';
  const createdAt = profile.created_at || formatDate(accountData.registration || accountData.$createdAt);
  const avatarUrl = profile.picture_url || accountData.avatar || accountData.picture_url || '';

  if (elements.displayName) {
    elements.displayName.value = displayName;
  }
  if (elements.avatarUrl) {
    elements.avatarUrl.value = avatarUrl;
  }
  if (elements.email) {
    elements.email.value = email;
  }
  if (elements.accountCreated) {
    elements.accountCreated.value = createdAt || '';
  }
  if (elements.accountCreatedData) {
    elements.accountCreatedData.value = createdAt || '';
  }
  if (elements.userId) {
    elements.userId.value = accountId;
  }
  if (elements.school) {
    elements.school.value = profile.school || '';
  }
  if (elements.major) {
    elements.major.value = profile.major || '';
  }
  if (elements.graduationYear) {
    elements.graduationYear.value = profile.graduation_year || '';
  }
  if (elements.storageUsed) {
    elements.storageUsed.textContent = formatBytes(SETTINGS_STATE.storageUsageBytes);
  }

  updateAvatarPreview(avatarUrl);

  if (elements.language) {
    elements.language.value = settings.language || 'en';
  }
  if (elements.timezone) {
    elements.timezone.value = settings.timezone || '';
  }
}

function syncThemeControls() {
  const settings = SETTINGS_STATE.settings || {};
  const themeValue = normalizeThemeValue(settings.theme || settings.interface_theme);
  SETTINGS_STATE.pendingTheme = '';
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
  const settings = SETTINGS_STATE.settings || {};
  const current = SETTINGS_STATE.pendingTheme || normalizeThemeValue(settings.theme || settings.interface_theme);
  elements.themeChoices.forEach((btn) => {
    const btnTheme = btn.getAttribute('data-theme') || '';
    const normalized = normalizeThemeValue(btnTheme);
    const active = normalized === current;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncToggleControls() {
  const settings = SETTINGS_STATE.settings || {};
  elements.toggleButtons.forEach((button) => {
    const field = button.getAttribute('data-toggle-field');
    const active = field ? Boolean(settings[field]) : false;
    setToggleState(button, active);
  });
}

function renderConnectedServices() {
  if (!elements.connectedServices) {
    return;
  }
  if (!SETTINGS_STATE.connectedServices.length) {
    elements.connectedServices.innerHTML = '<div class="settings-empty-state">No connected services.</div>';
    return;
  }

  elements.connectedServices.innerHTML = SETTINGS_STATE.connectedServices.map((service) => {
    const label = escapeHtml(service.name || 'Connected service');
    const detail = escapeHtml(service.detail || service.description || 'Connected');
    return `<div class="settings-empty-state settings-connected-item"><strong>${label}</strong><p>${detail}</p></div>`;
  }).join('');
}

function syncHashOnLoad() {
  const targetId = normalizeSectionId(window.location.hash) || 'account';
  // Activate the section without scrolling. If a hash is present,
  // show the corresponding panel directly (no scrollIntoView).
  activateSection(targetId, { scroll: false, pushState: false });
}

function activateSection(sectionId, options = {}) {
  const normalized = SETTINGS_SECTION_IDS.includes(sectionId) ? sectionId : 'account';
  SETTINGS_STATE.activeSection = normalized;

  elements.tabs.forEach((tab) => {
    const isActive = tab.getAttribute('data-tab') === normalized;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  if (options.pushState) {
    history.pushState(null, '', `#${normalized}`);
  }

  // Show/hide sections like tab panels instead of scrolling.
  elements.sections.forEach((section) => {
    const isActive = section.id === normalized;
    section.classList.toggle('hidden', !isActive);
    section.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });
}

async function saveProfile() {
  const payload = {
    name: elements.displayName?.value.trim() || '',
    picture_url: elements.avatarUrl?.value.trim() || '',
    school: elements.school?.value.trim() || '',
    major: elements.major?.value.trim() || '',
    graduation_year: elements.graduationYear?.value.trim() || '',
  };

  try {
    const response = await fetchJson(SETTINGS_ENDPOINTS.profile, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    SETTINGS_STATE.profile = {
      ...(SETTINGS_STATE.profile || {}),
      ...response,
    };
    populateFields();
    const navbarAvatar = document.querySelector('#navbar-avatar-btn img');
    const profilePreview = elements.avatarPreview;
    const nextAvatar = response.picture_url || '';
    const fallbackAvatar = 'https://resources.apstudy.org/images/AP-Resources-Logo.png';
    if (navbarAvatar) {
      navbarAvatar.src = nextAvatar || fallbackAvatar;
    }
    if (profilePreview) {
      profilePreview.src = nextAvatar || fallbackAvatar;
    }
    showToast('Profile saved.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to save profile.', 'error');
  }
}

async function savePreferences() {
  const payload = {
    theme: normalizeThemeValue(elements.theme?.value),
    sidebar_default: normalizeSidebarDefault(elements.sidebarDefault?.value),
    email_notifications: getToggleState('email_notifications'),
    product_updates: getToggleState('product_updates'),
    language: elements.language?.value || 'en',
    timezone: elements.timezone?.value.trim() || '',
  };

  try {
    const response = await fetchJson(SETTINGS_ENDPOINTS.preferences, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    SETTINGS_STATE.settings = {
      ...(SETTINGS_STATE.settings || {}),
      ...response,
    };
    syncThemeControls();
    syncToggleControls();
    applyThemePreference(payload.theme);
    showToast('Preferences saved.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to save preferences.', 'error');
  }
}

async function handlePasswordReset() {
  if (!window.account || typeof account.createRecovery !== 'function') {
    showToast('Password recovery is unavailable in this browser.', 'error');
    return;
  }

  const email = (SETTINGS_STATE.account && SETTINGS_STATE.account.email) || elements.email?.value || '';
  if (!email) {
    showToast('Email address is required for password recovery.', 'error');
    return;
  }

  try {
    await account.createRecovery(email, `${window.location.origin}/login`);
    showToast('Password reset email sent.', 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to start password recovery.', 'error');
  }
}

async function handleDeleteAccount() {
  const confirmed = window.confirm('Delete your APStudy account? This removes your profile, settings, and saved data.');
  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(SETTINGS_ENDPOINTS.deleteAccount, { method: 'POST' });
    showToast('Account deleted.', 'success');
    window.setTimeout(() => {
      window.location.assign('/logout');
    }, 500);
  } catch (error) {
    showToast(error.message || 'Unable to delete account.', 'error');
  }
}

async function handleExportData() {
  try {
    const data = await fetchJson(SETTINGS_ENDPOINTS.exportData);
    downloadJson(`apstudy-export-${Date.now()}.json`, data);
    showToast('Export started.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to export data.', 'error');
  }
}

function bindAvatarPreview() {
  if (!elements.avatarUrl || !elements.avatarPreview) {
    return;
  }
  elements.avatarUrl.addEventListener('input', () => {
    updateAvatarPreview(elements.avatarUrl.value);
  });
}

function updateAvatarPreview(value) {
  if (!elements.avatarPreview) {
    return;
  }
  const fallback = 'https://resources.apstudy.org/images/AP-Resources-Logo.png';
  elements.avatarPreview.src = value && value.trim() ? value.trim() : fallback;
  elements.avatarPreview.onerror = () => {
    elements.avatarPreview.onerror = null;
    elements.avatarPreview.src = fallback;
  };
}

function setToggleState(button, active) {
  if (!button) {
    return;
  }
  button.classList.toggle('is-active', Boolean(active));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function getToggleState(fieldName) {
  const button = document.querySelector(`[data-toggle-field="${fieldName}"]`);
  return Boolean(button && button.classList.contains('is-active'));
}

function normalizeThemeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (SETTINGS_THEME_TO_INTERFACE_THEME[normalized]) {
    return normalized;
  }
  if (SETTINGS_INTERFACE_THEME_TO_THEME[normalized]) {
    return SETTINGS_INTERFACE_THEME_TO_THEME[normalized];
  }
  return 'dark';
}

function applyThemePreference(theme) {
  const normalizedTheme = normalizeThemeValue(theme);
  const interfaceTheme = SETTINGS_THEME_TO_INTERFACE_THEME[normalizedTheme] || 'obsidian-dark';
  window.APSTUDY_THEME_PREFERENCE = interfaceTheme;
  localStorage.setItem('apstudy-theme', interfaceTheme);
  document.documentElement.setAttribute('data-theme', interfaceTheme);
  const darkThemes = ['obsidian-dark', 'nest-dark'];
  const isDark = interfaceTheme === 'system-match'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : darkThemes.includes(interfaceTheme);
  document.documentElement.classList.toggle('dark', isDark);
}

function normalizeSidebarDefault(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'collapsed') {
    return 'collapsed';
  }
  return 'expanded';
}

function normalizeSectionId(hashValue) {
  if (!hashValue) {
    return '';
  }
  const normalized = String(hashValue).replace(/^#/, '').trim().toLowerCase();
  return SETTINGS_SECTION_IDS.includes(normalized) ? normalized : '';
}

function resolveLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (error) {
    return '';
  }
}

function formatBytes(bytes) {
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

function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error((data && data.error) || 'Request failed.');
  }
  return data;
}

async function copyText(text) {
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
  temporaryInput.select();
  document.execCommand('copy');
  temporaryInput.remove();
}

function flashCopyButton(button) {
  const previousHtml = button.innerHTML;
  button.classList.add('is-copied');
  button.innerHTML = '<span class="material-symbols-outlined">check</span>';
  window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.innerHTML = previousHtml;
  }, 1200);
}

function showToast(message, type) {
  if (!elements.toastHost) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `settings-toast ${type === 'error' ? 'is-error' : 'is-success'}`;
  toast.innerHTML = `
    <div class="settings-toast-message">${escapeHtml(message)}</div>
    <button type="button" class="settings-toast-close" aria-label="Dismiss">&times;</button>
  `;

  const closeButton = toast.querySelector('button');
  const dismiss = () => {
    toast.remove();
  };
  closeButton?.addEventListener('click', dismiss);

  elements.toastHost.prepend(toast);
  window.setTimeout(dismiss, 3000);
}

function downloadJson(filename, data) {
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function throttleSectionDetection() {
  let bestSection = 'account';
  let bestDistance = Number.POSITIVE_INFINITY;

  elements.sections.forEach((section) => {
    const distance = Math.abs(section.getBoundingClientRect().top);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSection = section.id;
    }
  });

  activateSection(bestSection, { scroll: false, pushState: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSettingsPage);
} else {
  initializeSettingsPage();
}
