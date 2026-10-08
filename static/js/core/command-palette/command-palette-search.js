export const COMMAND_SEARCH_MIN_LENGTH = 2;
export const COMMAND_SEARCH_DEBOUNCE_MS = 180;

export const WORKSPACE_SEARCH_GROUPS = [
  { key: 'files', label: 'Files', icon: 'description' },
  { key: 'notes', label: 'Notes', icon: 'article' },
  { key: 'events', label: 'Events', icon: 'calendar_today' },
  { key: 'messages', label: 'Messages', icon: 'chat_bubble' },
  { key: 'courses', label: 'Courses', icon: 'school' },
];

export function emptyWorkspaceGroups() {
  return Object.fromEntries(WORKSPACE_SEARCH_GROUPS.map(({ key }) => [key, []]));
}

export function normalizeWorkspaceSearch(payload) {
  const groups = emptyWorkspaceGroups();
  for (const { key } of WORKSPACE_SEARCH_GROUPS) {
    groups[key] = Array.isArray(payload?.groups?.[key]) ? payload.groups[key] : [];
  }
  return {
    query: String(payload?.query || ''),
    total: Number(payload?.total || 0),
    coursesEnabled: Boolean(payload?.courses_enabled),
    unavailableCategories: Array.isArray(payload?.unavailable_categories)
      ? payload.unavailable_categories
      : [],
    groups,
  };
}

export async function fetchWorkspaceSearch(query, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/search?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error('Workspace search is temporarily unavailable.');
  }
  return normalizeWorkspaceSearch(await response.json());
}

function parseTimestamp(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

export function formatSearchTimestamp(result, now = new Date()) {
  const date = parseTimestamp(result?.timestamp);
  if (!date) return '';

  if (result?.category === 'events') {
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }).format(date);
    if (result.is_all_day) return dateLabel;
    const timeLabel = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
    return `${dateLabel}, ${timeLabel}`;
  }

  const elapsed = now.getTime() - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (elapsed >= 0 && elapsed < day && date.getDate() === now.getDate()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (elapsed >= 0 && elapsed < 7 * day) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }).format(date);
}
