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
const SETTINGS_PENDING_THEME_STORAGE_KEY = 'apstudy-theme-pending';
const SETTINGS_PENDING_THEME_UPDATED_KEY = 'apstudy-theme-updated-at';
const SETTINGS_MAX_OTHER_CALENDARS = 10;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 20;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const USERNAME_RESERVED = new Set([
  'account',
  'admin',
  'api',
  'auth',
  'calendar',
  'dashboard',
  'data',
  'files',
  'login',
  'logout',
  'notes',
  'onboarding',
  'preferences',
  'profile',
  'settings',
  'signup',
  'u',
  'user',
  'users',
]);

const SETTINGS_ENDPOINTS = {
  bootstrap: '/settings/api/bootstrap',
  profile: '/settings/api/profile',
  avatarUpload: '/settings/api/avatar-upload',
  feedUrl: '/settings/api/feed-url',
  preferences: '/settings/api/interface-preferences',
  exportData: '/settings/api/export',
  deleteAccount: '/settings/api/account/delete',
};

function warnSettingsStorageFailure(action, error) {
  console.warn(`Unable to ${action}; settings theme preview will continue visually.`, error);
}

function clearPendingThemeStorage() {
  try {
    localStorage.removeItem(SETTINGS_PENDING_THEME_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_PENDING_THEME_UPDATED_KEY);
  } catch (error) {
    warnSettingsStorageFailure('clear pending theme storage', error);
  }
}

const elements = {};

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

function bindProfilePreviewControls() {
  elements.avatarUploadButton?.addEventListener('click', () => {
    elements.avatarUpload?.click();
  });
  elements.avatarUpload?.addEventListener('change', () => {
    const file = elements.avatarUpload.files && elements.avatarUpload.files[0];
    if (file) {
      void uploadAvatar(file);
    }
  });
  elements.displayName?.addEventListener('input', renderProfilePreview);
  elements.displayName?.addEventListener('input', updateProfileDirtyState);
  elements.username?.addEventListener('input', renderProfilePreview);
  elements.username?.addEventListener('input', updateProfileDirtyState);
  elements.school?.addEventListener('input', renderProfilePreview);
  elements.school?.addEventListener('input', updateProfileDirtyState);
  elements.major?.addEventListener('input', renderProfilePreview);
  elements.major?.addEventListener('input', updateProfileDirtyState);
  elements.graduationYear?.addEventListener('input', renderProfilePreview);
  elements.graduationYear?.addEventListener('input', updateProfileDirtyState);
  elements.bannerColorPicker?.addEventListener('input', () => {
    const nextColor = normalizeHexColor(elements.bannerColorPicker.value);
    paintBannerColor(nextColor);
    updateProfileDirtyState();
  });
}

function getProfileUrl() {
  const profile = SETTINGS_STATE.profile || {};
  const accountData = SETTINGS_STATE.account || {};
  const username = elements.username?.value.trim() || profile.username || '';
  if (username) {
    return `${window.location.origin}/u/${encodeURIComponent(username)}`;
  }
  const userId = profile.id
    || elements.userId?.value
    || accountData.$id
    || accountData.id
    || '';
  if (!userId) {
    return '';
  }
  return `${window.location.origin}/user/${encodeURIComponent(userId)}`;
}

function openProfileLink() {
  const profileUrl = getProfileUrl();
  if (!profileUrl) {
    showToast('Profile link is unavailable right now.', 'error');
    return;
  }
  window.open(profileUrl, '_blank', 'noopener');
}

async function shareProfileLink() {
  const profileUrl = getProfileUrl();
  if (!profileUrl) {
    showToast('Profile link is unavailable right now.', 'error');
    return;
  }
  await copyText(profileUrl);
  showToast('Copied profile link.', 'success');
}

function bindCalendarControls() {
  elements.addOtherCalendar?.addEventListener('click', () => {
    const currentRows = getOtherCalendarInputValues({ includeBlank: true });
    if (currentRows.length >= SETTINGS_MAX_OTHER_CALENDARS) {
      showToast(`You can add up to ${SETTINGS_MAX_OTHER_CALENDARS} calendar links.`, 'error');
      return;
    }
    addOtherCalendarRow('');
    updateOtherCalendarCount();
  });
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

function renderOtherCalendarRows(urls) {
  if (!elements.otherCalendarLinks) {
    return;
  }
  elements.otherCalendarLinks.innerHTML = '';
  const safeUrls = Array.isArray(urls) ? urls.slice(0, SETTINGS_MAX_OTHER_CALENDARS) : [];
  safeUrls.forEach((url) => addOtherCalendarRow(url));
  updateOtherCalendarCount();
}

function addOtherCalendarRow(value) {
  if (!elements.otherCalendarLinks) {
    return;
  }

  const row = document.createElement('div');
  row.className = 'settings-calendar-row';
  row.innerHTML = `
    <label class="settings-field settings-calendar-row-field">
      <span class="sr-only">Other calendar link</span>
      <span class="settings-icon-input">
        <span class="material-symbols-outlined" aria-hidden="true">event</span>
        <input data-other-calendar-url type="url" inputmode="url" autocomplete="off" placeholder="https://calendar.google.com/..." />
      </span>
    </label>
    <button type="button" class="settings-calendar-remove" aria-label="Remove calendar link">
      <span class="material-symbols-outlined" aria-hidden="true">close</span>
    </button>
  `;

  const input = row.querySelector('[data-other-calendar-url]');
  if (input) {
    input.value = value || '';
    input.addEventListener('input', updateOtherCalendarCount);
  }
  row.querySelector('.settings-calendar-remove')?.addEventListener('click', () => {
    row.remove();
    updateOtherCalendarCount();
  });
  elements.otherCalendarLinks.appendChild(row);
}

function updateOtherCalendarCount() {
  if (!elements.otherCalendarCount) {
    return;
  }
  const rowCount = getOtherCalendarInputValues({ includeBlank: true }).length;
  elements.otherCalendarCount.textContent = `${rowCount} / ${SETTINGS_MAX_OTHER_CALENDARS} added`;
}

function getOtherCalendarInputValues(options = {}) {
  const includeBlank = Boolean(options.includeBlank);
  if (!elements.otherCalendarLinks) {
    return [];
  }
  return Array.from(elements.otherCalendarLinks.querySelectorAll('[data-other-calendar-url]'))
    .map((input) => input.value.trim())
    .filter((value) => includeBlank || value);
}

function collectCalendarPayload() {
  const canvasUrl = elements.canvasFeedUrl?.value.trim() || '';
  const otherUrls = getOtherCalendarInputValues();
  if (otherUrls.length > SETTINGS_MAX_OTHER_CALENDARS) {
    throw new Error(`You can add up to ${SETTINGS_MAX_OTHER_CALENDARS} calendar links.`);
  }

  const normalizedCanvasUrl = normalizeCalendarLinkForComparison(canvasUrl);
  const seen = new Set();
  const cleanedOtherUrls = [];

  otherUrls.forEach((url) => {
    const normalized = normalizeCalendarLinkForComparison(url);
    if (!normalized) {
      throw new Error('Each optional calendar link must be a valid http(s) or webcal URL.');
    }
    if (normalizedCanvasUrl && normalized === normalizedCanvasUrl) {
      throw new Error('Optional calendar links cannot duplicate the Canvas calendar.');
    }
    if (seen.has(normalized)) {
      throw new Error('Duplicate optional calendar links are not allowed.');
    }
    seen.add(normalized);
    cleanedOtherUrls.push(url);
  });

  return {
    canvas_ical_url: canvasUrl,
    other_ical_urls: cleanedOtherUrls,
  };
}

function normalizeCalendarLinkForComparison(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return '';
  }

  let protocol = parsed.protocol.toLowerCase();
  if (protocol === 'webcal:') {
    protocol = 'https:';
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return '';
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}${parsed.search}`;
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
  const currentProfile = SETTINGS_STATE.profile || {};
  const rawUsername = elements.username?.value.trim() || '';
  if (!rawUsername) {
    showToast('Username is required.', 'error');
    return;
  }
  const normalizedUsername = normalizeUsername(rawUsername);
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    showToast('Please only use numbers, letters, dashes -, or underscores _.', 'error');
    return;
  }
  if (normalizedUsername.length < USERNAME_MIN_LENGTH || normalizedUsername.length > USERNAME_MAX_LENGTH) {
    showToast('Username must be between 3 and 20 characters.', 'error');
    return;
  }
  if (USERNAME_RESERVED.has(normalizedUsername)) {
    showToast('That username is reserved.', 'error');
    return;
  }
  if (elements.username) {
    elements.username.value = normalizedUsername;
  }
  const payload = {
    name: elements.displayName?.value.trim() || '',
    username: normalizedUsername,
    picture_url: currentProfile.picture_url || '',
    avatar_source: currentProfile.avatar_source || (currentProfile.picture_url ? 'provider' : ''),
    banner_color: normalizeHexColor(elements.bannerColorPicker?.value || currentProfile.banner_color || '#fecae1'),
    school: elements.school?.value.trim() || '',
    major: elements.major?.value.trim() || '',
    graduation_year: elements.graduationYear?.value.trim() || '',
  };

  try {
    SETTINGS_STATE.profileSaving = true;
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
    const nextAvatar = response.picture_url || '';
    const fallbackAvatar = 'https://resources.apstudy.org/images/AP-Resources-Logo.png';
    if (navbarAvatar) {
      navbarAvatar.src = settingsAvatarUrlForSize(nextAvatar || fallbackAvatar, 32);
    }
    captureProfileBaseline();
    showToast('Profile saved.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to save profile.', 'error');
  } finally {
    SETTINGS_STATE.profileSaving = false;
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
  if (elements.avatarUpload) elements.avatarUpload.disabled = true;
  if (elements.avatarUploadStatus) elements.avatarUploadStatus.textContent = 'Uploading...';

  try {
    const response = await fetchFormData(SETTINGS_ENDPOINTS.avatarUpload, formData);
    SETTINGS_STATE.profile = {
      ...(SETTINGS_STATE.profile || {}),
      ...response,
    };
    updateAvatarPreview(response.picture_url || '');
    const navbarAvatar = document.querySelector('#navbar-avatar-btn img');
    if (navbarAvatar && response.picture_url) {
      navbarAvatar.src = settingsAvatarUrlForSize(response.picture_url, 32);
    }
    if (elements.avatarUploadStatus) elements.avatarUploadStatus.textContent = 'Avatar uploaded.';
    captureProfileBaseline();
    showToast('Avatar uploaded.', 'success');
  } catch (error) {
    if (elements.avatarUploadStatus) elements.avatarUploadStatus.textContent = 'JPG, PNG, GIF, or WebP. Max 10 MB.';
    showToast(error.message || 'Unable to upload avatar.', 'error');
  } finally {
    if (elements.avatarUpload) {
      elements.avatarUpload.disabled = false;
      elements.avatarUpload.value = '';
    }
  }
}

async function saveCalendarLinks() {
  let payload;
  try {
    payload = collectCalendarPayload();
  } catch (error) {
    showToast(error.message || 'Check your calendar links.', 'error');
    return;
  }

  const previousLabel = elements.saveCalendarLinks?.textContent || 'Save';
  if (elements.saveCalendarLinks) {
    elements.saveCalendarLinks.disabled = true;
    elements.saveCalendarLinks.textContent = 'Saving...';
  }

  try {
    const response = await fetchJson(SETTINGS_ENDPOINTS.feedUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const savedCanvasUrl = response.canvas_ical_url ?? payload.canvas_ical_url;
    const savedOtherUrls = Array.isArray(response.other_ical_urls)
      ? response.other_ical_urls
      : payload.other_ical_urls;
    SETTINGS_STATE.settings = {
      ...(SETTINGS_STATE.settings || {}),
      canvas_ical_url: savedCanvasUrl,
      other_calendar_urls: savedOtherUrls,
    };
    SETTINGS_STATE.otherCalendarUrls = savedOtherUrls;
    if (elements.canvasFeedUrl) {
      elements.canvasFeedUrl.value = savedCanvasUrl || '';
    }
    renderOtherCalendarRows(savedOtherUrls);
    showToast('Calendar links saved.', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to save calendar links.', 'error');
  } finally {
    if (elements.saveCalendarLinks) {
      elements.saveCalendarLinks.disabled = false;
      elements.saveCalendarLinks.textContent = previousLabel;
    }
  }
}

async function savePreferences() {
  const payload = {
    theme: normalizeThemeValue(elements.theme?.value),
    sidebar_default: normalizeSidebarDefault(elements.sidebarDefault?.value),
    email_notifications: getToggleState('email_notifications'),
    product_updates: getToggleState('product_updates'),
    task_sound_enabled: getToggleState('task_sound_enabled'),
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
    clearPendingThemeStorage();
    syncThemeControls();
    syncToggleControls();
    applyThemePreference(payload.theme);
    applySidebarDefault(response.sidebar_default || payload.sidebar_default);
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
  const confirmed = await (window.APStudyConfirm?.request?.({
    title: 'Delete account?',
    message: 'This removes your profile, settings, and saved data.',
    acceptLabel: 'Delete account',
    danger: true,
  }) ?? Promise.resolve(false));
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

function updateAvatarPreview(value) {
  if (!elements.avatarPreview) {
    return;
  }
  const fallback = 'https://resources.apstudy.org/images/AP-Resources-Logo.png';
  elements.avatarPreview.src = settingsAvatarUrlForSize(value && value.trim() ? value.trim() : fallback, 150);
  elements.avatarPreview.onerror = () => {
    elements.avatarPreview.onerror = null;
    elements.avatarPreview.src = settingsAvatarUrlForSize(fallback, 150);
  };
  renderProfilePreview();
}

function settingsAvatarUrlForSize(url, size = 32) {
  if (typeof window.APSTUDY_AVATAR_URL_FOR_SIZE === 'function') {
    return window.APSTUDY_AVATAR_URL_FOR_SIZE(url, size);
  }
  return String(url || '').trim();
}

function renderProfilePreview() {
  const profile = SETTINGS_STATE.profile || {};
  const accountData = SETTINGS_STATE.account || {};
  const displayName = elements.displayName?.value.trim() || profile.name || accountData.name || 'APStudy User';
  const username = elements.username?.value.trim() || profile.username || '';
  const school = elements.school?.value.trim() || profile.school || 'Not set';
  const major = elements.major?.value.trim() || profile.major || 'Not set';
  const graduation = elements.graduationYear?.value.trim()
    || profile.graduation_year
    || profile.class_year
    || 'Not set';
  const education = profile.education_level || 'Not set';
  const createdAt = elements.accountCreated?.value
    || profile.member_since
    || formatDate(profile.created_at || accountData.registration || accountData.$createdAt)
    || 'Not set';

  if (elements.previewName) elements.previewName.textContent = displayName;
  if (elements.previewHandle) {
    elements.previewHandle.textContent = profileHandle(
      displayName,
      username,
      profile.id || accountData.$id || accountData.id,
    );
  }
  if (elements.previewSchool) elements.previewSchool.textContent = school;
  if (elements.previewMajor) elements.previewMajor.textContent = major;
  if (elements.previewGraduation) elements.previewGraduation.textContent = graduation;
  if (elements.previewEducation) elements.previewEducation.textContent = education;
  if (elements.previewCreated) elements.previewCreated.textContent = createdAt;
  elements.previewSchoolCard?.classList.toggle('profile-tile-detail-emory', isEmorySchool(school));
  elements.previewMemberCard?.classList.toggle(
    'profile-tile-detail-early-member',
    isEarlyMember(profile.created_at || accountData.registration || accountData.$createdAt),
  );
}

function captureProfileBaseline() {
  SETTINGS_STATE.profileBaseline = getProfileFormValues();
  SETTINGS_STATE.profileDirty = false;
}

function getProfileFormValues() {
  return {
    name: elements.displayName?.value.trim() || '',
    username: elements.username?.value.trim() || '',
    school: elements.school?.value.trim() || '',
    major: elements.major?.value.trim() || '',
    graduation_year: elements.graduationYear?.value.trim() || '',
    banner_color: normalizeHexColor(elements.bannerColorPicker?.value || ''),
  };
}

function hasUnsavedProfileChanges() {
  if (!SETTINGS_STATE.profileBaseline) {
    return false;
  }
  const currentValues = getProfileFormValues();
  const baseline = SETTINGS_STATE.profileBaseline;
  return Object.keys(baseline).some((key) => currentValues[key] !== baseline[key]);
}

function updateProfileDirtyState() {
  SETTINGS_STATE.profileDirty = hasUnsavedProfileChanges();
}

function paintBannerColor(value) {
  const color = normalizeHexColor(value);
  if (elements.profileTile) {
    elements.profileTile.style.setProperty('--profile-banner-color', color);
  }
  if (elements.bannerSwatch) {
    elements.bannerSwatch.style.setProperty('--settings-banner-tile-color', color);
  }
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

function applySidebarDefault(value) {
  const shouldCollapse = normalizeSidebarDefault(value) === 'collapsed';
  localStorage.setItem('sidebar-collapsed', String(shouldCollapse));
  if (typeof window.APSTUDY_SET_SIDEBAR_COLLAPSED === 'function') {
    window.APSTUDY_SET_SIDEBAR_COLLAPSED(shouldCollapse);
    return;
  }
  document.dispatchEvent(new CustomEvent('apstudy-sidebar-default-change', {
    detail: { collapsed: shouldCollapse },
  }));
}

function normalizeHexColor(value) {
  let normalized = String(value || '').trim();
  if (!normalized) {
    return '#fecae1';
  }
  if (!normalized.startsWith('#')) {
    normalized = `#${normalized}`;
  }
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '#fecae1';
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function profileHandle(name, username, userId) {
  const normalizedUsername = String(username || '').trim();
  if (normalizedUsername) {
    return `@${normalizedUsername}`;
  }
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `@${slug || userId || 'apstudy-user'}`;
}

function isEmorySchool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'emory' || normalized === 'emory university';
}

function isEarlyMember(value) {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getTime() < Date.UTC(2026, 7, 20);
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

function formatCount(value, singularLabel) {
  const count = Number(value || 0);
  const normalizedCount = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  const pluralLabel = `${singularLabel}s`;
  return `${normalizedCount} ${normalizedCount === 1 ? singularLabel : pluralLabel}`;
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
  const method = String(options.method || 'GET').toUpperCase();
  const request = fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const response = await (method === 'GET'
    ? request
    : window.APStudyPendingMutations?.track(request, 'settings-save') || request);

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error((data && data.error) || 'Request failed.');
  }
  return data;
}

async function fetchFormData(url, formData) {
  const request = fetch(url, {
    method: 'POST',
    body: formData,
  });
  const response = await (window.APStudyPendingMutations?.track(request, 'settings-save') || request);
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
