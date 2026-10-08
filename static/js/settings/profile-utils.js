export function normalizeHexColor(value) {
  let normalized = String(value || '').trim();
  if (!normalized) {
    return '#fecae1';
  }
  if (!normalized.startsWith('#')) {
    normalized = `#${normalized}`;
  }
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '#fecae1';
}

export function profileHandle(name, username, userId) {
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

export function isEmorySchool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'emory' || normalized === 'emory university';
}

export function isEarlyMember(value) {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getTime() < Date.UTC(2026, 7, 20);
}
