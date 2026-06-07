(function registerSettingsProfile(global) {
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

  function createSettingsProfile({
    elements,
    state,
    endpoints,
    callbacks,
  }) {
    const {
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
    } = callbacks;
    let schoolSuggestionTimer = null;

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
      elements.school?.addEventListener('input', debounceSchoolSuggestions);
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
        state.profileSaving = true;
        const response = await fetchJson(endpoints.profile, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        state.profile = {
          ...(state.profile || {}),
          ...response,
        };
        populateFields();
        updateNavbarAvatar(response.picture_url || '');
        captureProfileBaseline();
        showToast('Profile saved.', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to save profile.', 'error');
      } finally {
        state.profileSaving = false;
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
        const response = await fetchFormData(endpoints.avatarUpload, formData);
        state.profile = {
          ...(state.profile || {}),
          ...response,
        };
        updateAvatarPreview(response.picture_url || '');
        updateNavbarAvatar(response.picture_url || '');
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

    function updateNavbarAvatar(pictureUrl) {
      const navbarAvatar = document.querySelector('#navbar-avatar-btn img');
      if (!navbarAvatar || !pictureUrl) {
        return;
      }
      navbarAvatar.src = settingsAvatarUrlForSize(pictureUrl, 48);
      navbarAvatar.srcset = `${settingsAvatarUrlForSize(pictureUrl, 48)} 1x, ${settingsAvatarUrlForSize(pictureUrl, 96)} 2x`;
      navbarAvatar.sizes = '48px';
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

    function updateAvatarPreview(value) {
      if (!elements.avatarPreview) {
        return;
      }
      const avatarValue = value && value.trim() ? value.trim() : '';
      elements.avatarPreview.src = settingsAvatarUrlForSize(avatarValue, 150);
      elements.avatarPreview.srcset = `${settingsAvatarUrlForSize(avatarValue, 150)} 1x, ${settingsAvatarUrlForSize(avatarValue, 300)} 2x`;
      elements.avatarPreview.sizes = '(max-width: 640px) 96px, 150px';
      elements.avatarPreview.onerror = () => {
        elements.avatarPreview.onerror = null;
        elements.avatarPreview.src = settingsAvatarUrlForSize('', 150);
        elements.avatarPreview.srcset = `${settingsAvatarUrlForSize('', 150)} 1x, ${settingsAvatarUrlForSize('', 300)} 2x`;
      };
      renderProfilePreview();
    }

    function settingsAvatarUrlForSize(url, size = 32) {
      if (typeof global.APSTUDY_AVATAR_URL_FOR_SIZE === 'function') {
        return global.APSTUDY_AVATAR_URL_FOR_SIZE(url, size);
      }
      return String(url || '').trim();
    }

    function renderProfilePreview() {
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

    return {
      bindProfilePreviewControls,
      captureProfileBaseline,
      hasUnsavedProfileChanges,
      openProfileLink,
      paintBannerColor,
      renderProfilePreview,
      saveProfile,
      shareProfileLink,
      updateAvatarPreview,
    };
  }

  global.APStudySettingsProfile = {
    createSettingsProfile,
  };
})(window);
