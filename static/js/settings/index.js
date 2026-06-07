/* settings.js
 * Single-page settings UI with hash navigation and Appwrite-backed saves.
 */

const SETTINGS_STATE = {
  account: null,
  profile: null,
  settings: null,
  storageUsageBytes: 0,
  notesCount: 0,
  filesCount: 0,
  connectedServices: [],
  otherCalendarUrls: [],
  activeSection: 'account',
  pendingTheme: '',
  profileBaseline: null,
  profileDirty: false,
  profileSaving: false,
};

const SETTINGS_SECTION_IDS = ['account', 'data', 'preferences'];
const SETTINGS_INTERFACE_THEMES = [
  'obsidian-dark',
  'parchment-light',
  'system-match',
  'nest-light',
  'nest-dark',
];
const SETTINGS_THEME_TO_INTERFACE_THEME = {
  dark: 'obsidian-dark',
  light: 'parchment-light',
  system: 'system-match',
};
const SETTINGS_PENDING_THEME_STORAGE_KEY = 'apstudy-theme-pending';
const SETTINGS_PENDING_THEME_UPDATED_KEY = 'apstudy-theme-updated-at';
const SETTINGS_MAX_OTHER_CALENDARS = 10;

const SETTINGS_ENDPOINTS = {
  bootstrap: '/settings/api/bootstrap',
  profile: '/settings/api/profile',
  avatarUpload: '/settings/api/avatar-upload',
  feedUrl: '/settings/api/feed-url',
  preferences: '/settings/api/interface-preferences',
  exportData: '/settings/api/export',
  deleteAccount: '/settings/api/account/delete',
  universities: '/api/universities',
};

const elements = {};
const settingsUtils = window.APStudySettingsUtils.createSettingsUtils({
  elements,
  constants: {
    interfaceThemes: SETTINGS_INTERFACE_THEMES,
    sectionIds: SETTINGS_SECTION_IDS,
    themeToInterfaceTheme: SETTINGS_THEME_TO_INTERFACE_THEME,
  },
});
const {
  applySidebarDefault,
  applyThemePreference,
  copyText,
  downloadJson,
  escapeHtml,
  fetchFormData,
  fetchJson,
  flashCopyButton,
  formatBytes,
  formatCount,
  formatDate,
  getToggleState,
  isEarlyMember,
  isEmorySchool,
  normalizeHexColor,
  normalizeSectionId,
  normalizeSidebarDefault,
  normalizeThemeValue,
  normalizeUsername,
  profileHandle,
  resolveLocalTimezone,
  setToggleState,
  showToast,
} = settingsUtils;
const settingsCalendar = window.APStudySettingsCalendar.createSettingsCalendar({
  elements,
  state: SETTINGS_STATE,
  constants: {
    maxOtherCalendars: SETTINGS_MAX_OTHER_CALENDARS,
  },
  endpoints: SETTINGS_ENDPOINTS,
  callbacks: {
    fetchJson,
    showToast,
  },
});
const {
  bindCalendarControls,
  renderOtherCalendarRows,
  saveCalendarLinks,
} = settingsCalendar;
const settingsProfile = window.APStudySettingsProfile.createSettingsProfile({
  elements,
  state: SETTINGS_STATE,
  endpoints: SETTINGS_ENDPOINTS,
  callbacks: {
    copyText,
    escapeHtml,
    fetchFormData,
    fetchJson,
    formatDate,
    isEarlyMember,
    isEmorySchool,
    normalizeHexColor,
    normalizeUsername,
    populateFields,
    profileHandle,
    showToast,
  },
});
const {
  bindProfilePreviewControls,
  captureProfileBaseline,
  hasUnsavedProfileChanges,
  openProfileLink,
  paintBannerColor,
  renderProfilePreview,
  saveProfile,
  shareProfileLink,
  updateAvatarPreview,
} = settingsProfile;
const settingsPreferences = window.APStudySettingsPreferences.createSettingsPreferences({
  elements,
  state: SETTINGS_STATE,
  constants: {
    pendingThemeStorageKey: SETTINGS_PENDING_THEME_STORAGE_KEY,
    pendingThemeUpdatedKey: SETTINGS_PENDING_THEME_UPDATED_KEY,
  },
  endpoints: SETTINGS_ENDPOINTS,
  callbacks: {
    applySidebarDefault,
    applyThemePreference,
    fetchJson,
    getToggleState,
    normalizeSidebarDefault,
    normalizeThemeValue,
    resolveLocalTimezone,
    setToggleState,
    showToast,
  },
});
const {
  bindThemeChoiceButtons,
  bindTimezoneHelper,
  savePreferences,
  syncThemeControls,
  syncToggleControls,
} = settingsPreferences;
const settingsAccount = window.APStudySettingsAccount.createSettingsAccount({
  elements,
  state: SETTINGS_STATE,
  endpoints: SETTINGS_ENDPOINTS,
  callbacks: {
    downloadJson,
    fetchJson,
    showToast,
  },
});
const {
  handleDeleteAccount,
  handleExportData,
  handlePasswordReset,
} = settingsAccount;

function initializeSettingsPage() {
  cacheElements();
  bindNavigation();
  bindCopyButtons();
  bindToggleButtons();
  bindActionButtons();
  bindProfilePreviewControls();
  bindCalendarControls();
  bindTimezoneHelper();
  bindUnsavedChangesWarning();
  elements.themeChoices = Array.from(document.querySelectorAll('.settings-theme-choice'));
  bindThemeChoiceButtons();
  void bootstrapSettingsPage();
}

function cacheElements() {
  elements.tabs = Array.from(document.querySelectorAll('.settings-tab'));
  elements.sections = Array.from(document.querySelectorAll('.settings-section'));
  elements.copyButtons = Array.from(document.querySelectorAll('[data-copy-target]'));
  elements.toggleButtons = Array.from(document.querySelectorAll('[data-toggle-field]'));
  elements.avatarPreview = document.getElementById('settings-avatar-preview');
  elements.profileTile = document.getElementById('settings-profile-tile');
  elements.previewName = document.getElementById('settings-preview-name');
  elements.previewHandle = document.getElementById('settings-preview-handle');
  elements.previewSchool = document.getElementById('settings-preview-school');
  elements.previewSchoolCard = document.getElementById('settings-preview-school-card');
  elements.previewMajor = document.getElementById('settings-preview-major');
  elements.previewGraduation = document.getElementById('settings-preview-graduation');
  elements.previewEducation = document.getElementById('settings-preview-education');
  elements.previewCreated = document.getElementById('settings-preview-created');
  elements.previewMemberCard = document.getElementById('settings-preview-member-card');
  elements.openProfile = document.getElementById('settings-open-profile');
  elements.shareProfile = document.getElementById('settings-share-profile');
  elements.avatarUpload = document.getElementById('settings-avatar-upload');
  elements.avatarUploadButton = document.getElementById('settings-avatar-upload-button');
  elements.avatarUploadStatus = document.getElementById('settings-avatar-upload-status');
  elements.bannerColorPicker = document.getElementById('settings-banner-color-picker');
  elements.bannerSwatch = document.getElementById('settings-banner-swatch');
  elements.displayName = document.getElementById('settings-display-name');
  elements.username = document.getElementById('settings-username-input');
  elements.email = document.getElementById('settings-email');
  elements.accountCreated = document.getElementById('settings-account-created');
  elements.accountCreatedData = document.getElementById('settings-account-created-data');
  elements.userId = document.getElementById('settings-user-id');
  elements.accountUsername = document.getElementById('settings-username');
  elements.school = document.getElementById('settings-school');
  elements.universityOptions = document.getElementById('settings-university-options');
  elements.major = document.getElementById('settings-major');
  elements.graduationYear = document.getElementById('settings-graduation-year');
  elements.storageUsed = Array.from(document.querySelectorAll('[data-storage-used]'));
  elements.storageDetails = Array.from(document.querySelectorAll('[data-storage-details]'));
  elements.connectedServices = document.getElementById('settings-connected-services');
  elements.canvasFeedUrl = document.getElementById('settings-canvas-feed-url');
  elements.otherCalendarLinks = document.getElementById('settings-other-calendar-links');
  elements.otherCalendarCount = document.getElementById('settings-other-calendar-count');
  elements.addOtherCalendar = document.getElementById('settings-add-other-calendar');
  elements.saveCalendarLinks = document.getElementById('settings-save-calendar-links');
  elements.theme = document.getElementById('settings-theme');
  elements.sidebarDefault = document.getElementById('settings-sidebar-default');
  elements.language = document.getElementById('settings-language');
  elements.timezone = document.getElementById('settings-timezone');
  elements.useCurrentTimezone = document.getElementById('settings-use-current-timezone');
  elements.saveProfile = document.getElementById('settings-save-profile');
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
  elements.saveAppearance?.addEventListener('click', () => void savePreferences());
  elements.saveNotifications?.addEventListener('click', () => void savePreferences());
  elements.saveRegion?.addEventListener('click', () => void savePreferences());
  elements.saveCalendarLinks?.addEventListener('click', () => void saveCalendarLinks());
  elements.openProfile?.addEventListener('click', () => openProfileLink());
  elements.shareProfile?.addEventListener('click', () => void shareProfileLink());
  elements.changePassword?.addEventListener('click', () => void handlePasswordReset());
  elements.deleteAccount?.addEventListener('click', () => void handleDeleteAccount());
  elements.exportData?.addEventListener('click', () => void handleExportData());
}

function bindUnsavedChangesWarning() {
  window.addEventListener('beforeunload', (event) => {
    if (SETTINGS_STATE.profileSaving || !hasUnsavedProfileChanges()) {
      return;
    }
    event.preventDefault();
    event.returnValue = '';
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
    SETTINGS_STATE.notesCount = Number(bootstrapResponse.notes_count || 0);
    SETTINGS_STATE.filesCount = Number(bootstrapResponse.files_count || 0);
    SETTINGS_STATE.connectedServices = Array.isArray(bootstrapResponse.connected_services)
      ? bootstrapResponse.connected_services
      : [];
    SETTINGS_STATE.otherCalendarUrls = Array.isArray(bootstrapResponse.other_calendar_urls)
      ? bootstrapResponse.other_calendar_urls
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
  const username = profile.username || '';
  const email = profile.email || accountData.email || '';
  const accountId = profile.id || accountData.$id || accountData.id || '';
  const createdAt = profile.member_since || formatDate(profile.created_at || accountData.registration || accountData.$createdAt);
  const avatarUrl = profile.picture_url || accountData.avatar || accountData.picture_url || '';
  const bannerColor = normalizeHexColor(profile.banner_color || '#fecae1');

  if (elements.displayName) {
    elements.displayName.value = displayName;
  }
  if (elements.username) {
    elements.username.value = username;
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
  if (elements.accountUsername) {
    elements.accountUsername.value = username;
  }
  if (elements.school) {
    elements.school.value = profile.school || '';
  }
  if (elements.major) {
    elements.major.value = profile.major || '';
  }
  if (elements.graduationYear) {
    elements.graduationYear.value = profile.graduation_year || profile.class_year || '';
  }
  if (elements.bannerColorPicker) {
    elements.bannerColorPicker.value = bannerColor;
  }
  if (elements.storageUsed?.length) {
    const storageText = formatBytes(SETTINGS_STATE.storageUsageBytes);
    elements.storageUsed.forEach((node) => {
      node.textContent = storageText;
    });
  }
  if (elements.storageDetails?.length) {
    const detailsText = `${formatCount(SETTINGS_STATE.notesCount, 'note')}, ${formatCount(SETTINGS_STATE.filesCount, 'file')}`;
    elements.storageDetails.forEach((node) => {
      node.textContent = detailsText;
    });
  }

  updateAvatarPreview(avatarUrl);
  paintBannerColor(bannerColor);
  renderProfilePreview();
  captureProfileBaseline();

  if (elements.language) {
    elements.language.value = settings.language || 'en';
  }
  if (elements.timezone) {
    elements.timezone.value = settings.timezone || '';
  }
  if (elements.canvasFeedUrl) {
    elements.canvasFeedUrl.value = settings.canvas_ical_url || '';
  }
  renderOtherCalendarRows(SETTINGS_STATE.otherCalendarUrls);
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSettingsPage);
} else {
  initializeSettingsPage();
}
