const csrf = () => document.cookie.match(/(?:^|; )csrf_token=([^;]*)/)?.[1] || '';

export async function request(url, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (options.method && options.method !== 'GET') {
    headers['X-CSRFToken'] = decodeURIComponent(csrf());
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Focus Mode could not save that change.');
  return payload;
}

export const focusApi = {
  state: () => request('/api/focus'),
  start: (payload) => request('/api/focus/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateSession: (sessionId, action) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  }),
  setPlaylist: (sessionId, spotifyUrl) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'set_playlist', spotify_url: spotifyUrl }),
  }),
  saveRoutine: (payload, routineId = '') => request(
    routineId ? `/api/focus/routines/${encodeURIComponent(routineId)}` : '/api/focus/routines',
    { method: routineId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
  ),
  deleteRoutine: (routineId) => request(`/api/focus/routines/${encodeURIComponent(routineId)}`, {
    method: 'DELETE',
  }),
};

function uniqueMinutes(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= 90))];
}

export function suggestedBreaks(focusMinutes, recentSelections = []) {
  const focus = Number(focusMinutes);
  if (!Number.isFinite(focus) || focus < 10) return [];

  const recentMatches = recentSelections
    .filter((selection) => Number(selection.focus_minutes) === focus)
    .map((selection) => Number(selection.break_minutes));

  const evidenceBased = [];
  if (focus === 12) evidenceBased.push(3);
  if (focus === 24) evidenceBased.push(6);
  if (focus === 25) evidenceBased.push(5);

  const proportional = Math.min(10, Math.max(3, Math.round(focus / 5)));
  const familiar = focus <= 30 ? 5 : focus <= 60 ? 10 : 15;
  return uniqueMinutes([...recentMatches, ...evidenceBased, proportional, familiar]).slice(0, 4);
}

export function formPayload(form) {
  const values = new FormData(form);
  return {
    routine_id: String(values.get('routine_id') || ''),
    name: String(values.get('name') || '').trim() || 'Custom focus',
    focus_minutes: Number(values.get('focus_minutes')),
    break_minutes: Number(values.get('break_minutes') || 0),
    long_break_minutes: Number(values.get('long_break_minutes') || 0),
    cycles: Number(values.get('cycles') || 1),
    spotify_url: String(values.get('spotify_url') || '').trim(),
    auto_start_next: values.get('auto_start_next') === 'on',
  };
}

export function spotifyEmbedUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'open.spotify.com') return '';
    const match = parsed.pathname.match(/^\/(?:embed\/)?playlist\/([A-Za-z0-9]+)\/?$/i);
    return match ? `https://open.spotify.com/embed/playlist/${match[1]}?utm_source=generator&theme=0` : '';
  } catch (_error) {
    return '';
  }
}

export function normalizeSpotifyPlaylist(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'open.spotify.com') return '';
    const match = parsed.pathname.match(/^\/(?:embed\/)?playlist\/([A-Za-z0-9]+)\/?$/i);
    return match ? `https://open.spotify.com/playlist/${match[1]}` : '';
  } catch (_error) {
    return '';
  }
}

export function routineFromState(state, routineId) {
  return (state.routines || []).find((routine) => String(routine.id) === String(routineId)) || null;
}
