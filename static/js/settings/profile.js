import { createSettingsAvatar } from './avatar.js';
import { copyText, escapeHtml, fetchJson, formatDate, showToast } from './utils.js';
import { isEarlyMember, isEmorySchool, normalizeHexColor, profileHandle } from './profile-utils.js';
import { validateProfileText, validateUsername } from '../core/profile-policy.js';
const global = window;
const endpoints = { profile: '/settings/api/profile', universities: '/api/universities' };
const PROFILE_TEXT_FIELDS = [
  { element: 'displayName', counter: 'settings-display-name-counter', error: 'settings-display-name-error' },
  { element: 'school', counter: 'settings-school-counter', error: 'settings-school-error' },
  { element: 'major', counter: 'settings-major-counter', error: 'settings-major-error' },
];

export function createSettingsProfile(state, onSaved) {
  const elements = {
    accountCreated: document.getElementById('settings-account-created'),
    accountCreatedData: document.getElementById('settings-account-created-data'),
    accountUsername: document.getElementById('settings-username'),
    bannerColorPicker: document.getElementById('settings-banner-color-picker'),
    bannerSwatch: document.getElementById('settings-banner-swatch'),
    displayName: document.getElementById('settings-display-name'),
    email: document.getElementById('settings-email'),
    graduationYear: document.getElementById('settings-graduation-year'),
    major: document.getElementById('settings-major'),
    openProfile: document.getElementById('settings-open-profile'),
    previewCreated: document.getElementById('settings-preview-created'),
    previewEducation: document.getElementById('settings-preview-education'),
    previewGraduation: document.getElementById('settings-preview-graduation'),
    previewHandle: document.getElementById('settings-preview-handle'),
    previewMajor: document.getElementById('settings-preview-major'),
    previewMemberCard: document.getElementById('settings-preview-member-card'),
    previewName: document.getElementById('settings-preview-name'),
    previewSchool: document.getElementById('settings-preview-school'),
    previewSchoolCard: document.getElementById('settings-preview-school-card'),
    profileTile: document.getElementById('settings-profile-tile'),
    saveProfile: document.getElementById('settings-save-profile'),
    school: document.getElementById('settings-school'),
    shareProfile: document.getElementById('settings-share-profile'),
    universityOptions: document.getElementById('settings-university-options'),
    userId: document.getElementById('settings-user-id'),
    username: document.getElementById('settings-username-input'),
  };

  let schoolSuggestionTimer = null;
  const avatar = createSettingsAvatar(state, renderProfilePreview, captureProfileBaseline);

  function validateProfileTextField(field, { announce = true } = {}) {
    const input = elements[field.element];
    const counter = document.getElementById(field.counter);
    const error = document.getElementById(field.error);
    if (!input) return true;
    const { error: message, length, maximum } = validateProfileText(field.element, input.value);
    if (counter) counter.textContent = `${length} / ${maximum} characters`;
    if (error) {
      error.textContent = announce ? message : '';
      error.hidden = !message;
    }
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    if (message) global.APStudyFormField?.markInvalid?.(input);
    else global.APStudyFormField?.clearInvalid?.(input);
    return !message;
  }

  function validateProfileTextFields(options) {
    return PROFILE_TEXT_FIELDS.every((field) => validateProfileTextField(field, options));
  }

  function bindProfilePreviewControls() {
    avatar.bind();
    elements.displayName?.addEventListener('input', () => {
      validateProfileTextField(PROFILE_TEXT_FIELDS[0]);
      renderProfilePreview();
      updateProfileDirtyState();
    });
    elements.username?.addEventListener('input', renderProfilePreview);
    elements.username?.addEventListener('input', updateProfileDirtyState);
    global.APStudyFormField?.bindAutoClear?.(elements.username);
    elements.school?.addEventListener('input', () => {
      validateProfileTextField(PROFILE_TEXT_FIELDS[1]);
      renderProfilePreview();
      updateProfileDirtyState();
    });
    elements.school?.addEventListener('input', debounceSchoolSuggestions);
    elements.major?.addEventListener('input', () => {
      validateProfileTextField(PROFILE_TEXT_FIELDS[2]);
      renderProfilePreview();
      updateProfileDirtyState();
    });
    elements.graduationYear?.addEventListener('input', renderProfilePreview);
    elements.graduationYear?.addEventListener('input', updateProfileDirtyState);
    elements.bannerColorPicker?.addEventListener('input', () => {
      const nextColor = normalizeHexColor(elements.bannerColorPicker.value);
      paintBannerColor(nextColor);
      updateProfileDirtyState();
    });
    validateProfileTextFields();
  }

  function getProfileUrl() {
    const profile = state.profile || {};
    const accountData = state.account || {};
    const username = elements.username?.value.trim() || profile.username || '';
    if (username) {
      return `${global.location.origin}/u/${encodeURIComponent(username)}`;
    }
    const userId = profile.id
      || elements.userId?.value
      || accountData.$id
      || accountData.id
      || '';
    if (!userId) {
      return '';
    }
    return `${global.location.origin}/user/${encodeURIComponent(userId)}`;
  }

  function openProfileLink() {
    const profileUrl = getProfileUrl();
    if (!profileUrl) {
      showToast('Profile link is unavailable right now.', 'error');
      return;
    }
    global.open(profileUrl, '_blank', 'noopener');
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

  async function saveProfile() {
    const currentProfile = state.profile || {};
    if (!validateProfileTextFields()) {
      return;
    }
    const { value: normalizedUsername, error: usernameError } = validateUsername(elements.username?.value);
    if (usernameError) {
      global.APStudyFormField?.markInvalid?.(elements.username);
      showToast(usernameError, 'error');
      return;
    }
    global.APStudyFormField?.clearInvalid?.(elements.username);
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
      state.profileSaving = true;
      const response = await fetchJson(endpoints.profile, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      state.profile = {
        ...(state.profile || {}),
        ...response,
      };
      onSaved();
      avatar.updateNavbarAvatar(response.picture_url || '');
      captureProfileBaseline();
      showToast('Profile saved.', 'success');
    } catch (error) {
      showToast(error.message || 'Try again in a moment.', 'error', { title: 'Couldn’t save profile' });
    } finally {
      state.profileSaving = false;
    }
  }

  function debounceSchoolSuggestions() {
    if (!elements.school || !elements.universityOptions) {
      return;
    }
    global.clearTimeout(schoolSuggestionTimer);
    schoolSuggestionTimer = global.setTimeout(() => {
      void loadSchoolSuggestions(elements.school.value);
    }, 180);
  }

  async function loadSchoolSuggestions(query) {
    const term = String(query || '').trim();
    if (term.length < 2 || !elements.universityOptions) {
      return;
    }
    try {
      const data = await fetchJson(`${endpoints.universities}?q=${encodeURIComponent(term)}`);
      const results = Array.isArray(data.results) ? data.results : [];
      elements.universityOptions.innerHTML = results.map((school) => {
        const label = [school.name, school.city, school.state].filter(Boolean).join(' - ');
        return `<option value="${escapeHtml(school.name)}" label="${escapeHtml(label)}"></option>`;
      }).join('');
    } catch (error) {
      console.warn('Unable to load school suggestions', error);
    }
  }

  function renderProfilePreview() {
    validateProfileTextFields();
    const profile = state.profile || {};
    const accountData = state.account || {};
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
    state.profileBaseline = getProfileFormValues();
    state.profileDirty = false;
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
    if (!state.profileBaseline) {
      return false;
    }
    const currentValues = getProfileFormValues();
    const baseline = state.profileBaseline;
    return Object.keys(baseline).some((key) => currentValues[key] !== baseline[key]);
  }

  function updateProfileDirtyState() {
    state.profileDirty = hasUnsavedProfileChanges();
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

  function hydrate() {
    const profile = state.profile || {};
    const accountData = state.account || {};

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
    avatar.updateAvatarPreview(avatarUrl);
    paintBannerColor(bannerColor);
    renderProfilePreview();
    captureProfileBaseline();
  }
  function mount() {
    bindProfilePreviewControls();
    elements.saveProfile?.addEventListener('click', () => void saveProfile());
    elements.openProfile?.addEventListener('click', openProfileLink);
    elements.shareProfile?.addEventListener('click', () => void shareProfileLink());
    window.addEventListener('beforeunload', (event) => {
      if (state.profileSaving || !hasUnsavedProfileChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  return { mount, hydrate };
}
