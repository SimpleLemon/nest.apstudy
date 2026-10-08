export const USERNAME_MAX_LENGTH = 20;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const USERNAME_RESERVED = new Set([
  'account', 'admin', 'api', 'auth', 'calendar', 'dashboard', 'data',
  'files', 'login', 'logout', 'notes', 'onboarding', 'preferences',
  'profile', 'settings', 'signup', 'u', 'user', 'users',
]);
const PROFILE_TEXT_FIELDS = {
  displayName: { label: 'Display name', minimum: 1, maximum: 80 },
  school: { label: 'School', minimum: 0, maximum: 160 },
  major: { label: 'Major', minimum: 0, maximum: 120 },
};

export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateUsername(value) {
  const normalized = normalizeUsername(value);
  let error = '';
  if (!normalized) error = 'Username is required.';
  else if (!USERNAME_PATTERN.test(normalized)) error = 'Please only use numbers, letters, dashes -, or underscores _.';
  else if (normalized.length < USERNAME_MIN_LENGTH || normalized.length > USERNAME_MAX_LENGTH) error = `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`;
  else if (USERNAME_RESERVED.has(normalized)) error = 'That username is reserved.';
  return { value: normalized, error };
}

export function validateProfileText(field, value) {
  const { label, minimum, maximum } = PROFILE_TEXT_FIELDS[field];
  const normalized = String(value || '').trim();
  const length = Array.from(normalized).length;
  let error = '';
  if (length < minimum) error = `${label} is required.`;
  else if (length > maximum) error = `${label} must be ${maximum} characters or fewer.`;
  return { value: normalized, error, length, maximum };
}
