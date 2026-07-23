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
  removePlaylist: (sessionId, spotifyUrl) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'remove_playlist', spotify_url: spotifyUrl }),
  }),
  restorePlaylist: (sessionId, spotifyUrl, activeSpotifyUrl) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      action: 'restore_playlist',
      spotify_url: spotifyUrl,
      active_spotify_url: activeSpotifyUrl,
    }),
  }),
  previewPlaylist: (spotifyUrl) => request('/api/focus/playlists/preview', {
    method: 'POST',
    body: JSON.stringify({ spotify_url: spotifyUrl }),
  }),
  saveRoutine: (payload, routineId = '') => request(
    routineId ? `/api/focus/routines/${encodeURIComponent(routineId)}` : '/api/focus/routines',
    { method: routineId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
  ),
  deleteRoutine: (routineId) => request(`/api/focus/routines/${encodeURIComponent(routineId)}`, {
    method: 'DELETE',
  }),
  savePlayerPreferences: (preferences) => request('/api/focus/player-preferences', {
    method: 'PATCH',
    body: JSON.stringify(preferences),
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
    spotify_playlists: (() => {
      try {
        const parsed = JSON.parse(String(values.get('spotify_playlists') || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        return [];
      }
    })(),
  };
}

export function playlistProvider(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname === 'open.spotify.com' && /^\/(?:embed\/)?playlist\/[A-Za-z0-9]+\/?$/i.test(parsed.pathname)) {
      return 'spotify';
    }
    const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
    const playlistId = parsed.searchParams.get('list') || '';
    if (youtubeHosts.has(parsed.hostname) && parsed.pathname.replace(/\/$/, '') === '/playlist' && /^[A-Za-z0-9_-]{10,}$/.test(playlistId)) {
      return parsed.hostname === 'music.youtube.com' ? 'youtube_music' : 'youtube';
    }
    return '';
  } catch (_error) {
    return '';
  }
}

export function normalizePlaylist(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const provider = playlistProvider(url);
    if (provider === 'spotify') {
      const match = parsed.pathname.match(/^\/(?:embed\/)?playlist\/([A-Za-z0-9]+)\/?$/i);
      return `https://open.spotify.com/playlist/${match[1]}`;
    }
    if (provider === 'youtube' || provider === 'youtube_music') {
      const host = provider === 'youtube_music' ? 'music.youtube.com' : 'www.youtube.com';
      return `https://${host}/playlist?list=${encodeURIComponent(parsed.searchParams.get('list'))}`;
    }
    return '';
  } catch (_error) {
    return '';
  }
}

export function playlistEmbedUrl(value) {
  const normalized = normalizePlaylist(value);
  const provider = playlistProvider(normalized);
  if (!normalized || !provider) return '';
  const parsed = new URL(normalized);
  if (provider === 'spotify') {
    const id = parsed.pathname.split('/').filter(Boolean).at(-1);
    return `https://open.spotify.com/embed/playlist/${id}?utm_source=generator&theme=0`;
  }
  const id = parsed.searchParams.get('list');
  return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&enablejsapi=1&playsinline=1`;
}

export function spotifyEmbedUrl(value) {
  return playlistEmbedUrl(value);
}

export function normalizeSpotifyPlaylist(value) {
  return normalizePlaylist(value);
}

export function routineFromState(state, routineId) {
  return (state.routines || []).find((routine) => String(routine.id) === String(routineId)) || null;
}
