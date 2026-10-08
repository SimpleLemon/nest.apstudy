export function request(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  return window.APStudyHttp.fetchJson(url, {
    credentials: 'same-origin',
    ...options,
    jsonMode: 'required',
    pendingLabel: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? null : 'focus-save',
    errorFactory: (payload) => new Error(payload?.error || 'Focus Mode could not save that change.'),
  });
}

export const focusApi = {
  state: (options = {}) => request('/api/focus', options),
  start: (payload, options = {}) => request('/api/focus/sessions', {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  updateSession: (sessionId, action, options = {}) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({ action }),
  }),
  setPlaylist: (sessionId, playlistUrl, options = {}) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({ action: 'set_playlist', spotify_url: playlistUrl }),
  }),
  removeSessionPlaylist: (sessionId, playlistUrl, options = {}) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({ action: 'remove_playlist', spotify_url: playlistUrl }),
  }),
  addPlaylist: (playlistUrl, options = {}) => request('/api/focus/playlists', {
    ...options,
    method: 'POST',
    body: JSON.stringify({ spotify_url: playlistUrl }),
  }),
  removePlaylist: (playlistUrl, options = {}) => request('/api/focus/playlists', {
    ...options,
    method: 'DELETE',
    body: JSON.stringify({ spotify_url: playlistUrl }),
  }),
  setActivePlaylist: (playlistUrl, options = {}) => request('/api/focus/playlists/active', {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({ spotify_url: playlistUrl }),
  }),
  restorePlaylist: (sessionId, playlistUrl, activePlaylistUrl, options = {}) => request(`/api/focus/sessions/${encodeURIComponent(sessionId)}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify({
      action: 'restore_playlist',
      spotify_url: playlistUrl,
      active_spotify_url: activePlaylistUrl,
    }),
  }),
  previewPlaylist: (playlistUrl, options = {}) => request('/api/focus/playlists/preview', {
    ...options,
    method: 'POST',
    body: JSON.stringify({ spotify_url: playlistUrl }),
  }),
  saveRoutine: (payload, routineId = '', options = {}) => request(
    routineId ? `/api/focus/routines/${encodeURIComponent(routineId)}` : '/api/focus/routines',
    { ...options, method: routineId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
  ),
  deleteRoutine: (routineId, options = {}) => request(`/api/focus/routines/${encodeURIComponent(routineId)}`, {
    ...options,
    method: 'DELETE',
    keepalive: options.keepalive === true,
  }),
  savePlayerPreferences: (preferences, options = {}) => request('/api/focus/player-preferences', {
    ...options,
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

export const DEFAULT_FOCUS_TIME_SUGGESTIONS = [
  { focus_minutes: 25, break_minutes: 5, cycles: 1 },
  { focus_minutes: 50, break_minutes: 10, cycles: 1 },
  { focus_minutes: 90, break_minutes: 15, cycles: 1 },
];

export function focusTimeSelectionKey(selection = {}) {
  return [
    Number(selection.focus_minutes) || 0,
    Number(selection.break_minutes) || 0,
    Number(selection.cycles) || 1,
  ].join(':');
}

export function buildFocusTimeSuggestions(selections = [], defaults = DEFAULT_FOCUS_TIME_SUGGESTIONS) {
  const recent = [];
  const seen = new Set();
  for (const selection of selections) {
    if (recent.length >= 2) break;
    const normalized = {
      focus_minutes: Number(selection.focus_minutes) || 0,
      break_minutes: Number(selection.break_minutes) || 0,
      long_break_minutes: Number(selection.long_break_minutes) || Number(selection.break_minutes) || 0,
      cycles: Number(selection.cycles) || 1,
      spotify_url: selection.spotify_url,
      fromRecent: true,
    };
    const key = focusTimeSelectionKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(normalized);
  }
  if (!recent.length) {
    return defaults.map((item) => ({ ...item, fromRecent: false }));
  }
  return [
    ...recent,
    ...defaults
      .filter((item) => !seen.has(focusTimeSelectionKey(item)))
      .map((item) => ({ ...item, fromRecent: false })),
  ];
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
      } catch {
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
  } catch {
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
  } catch {
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

export function routineFromState(state, routineId) {
  return (state.routines || []).find((routine) => String(routine.id) === String(routineId)) || null;
}
