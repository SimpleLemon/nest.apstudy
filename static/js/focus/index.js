import {
  focusApi,
  formPayload,
  playlistEmbedUrl,
  routineFromState,
  suggestedBreaks,
} from './data.js';
import { clockedSession, remainingSeconds } from './timer.js';
import { createFocusView } from './view.js';

const view = createFocusView({
  savePlayerPreferences: (preferences) => focusApi.savePlayerPreferences(preferences),
});
const { elements } = view;
let completionEffects = null;
let completionEffectsPromise = null;
let completionPreparePromise = null;
let disposePlaylistGestures = null;
let playlistGesturesPromise = null;

async function ensureCompletionEffects() {
  if (state.disposed) return null;
  if (completionEffects) return completionEffects;
  completionEffectsPromise ||= import('./completion.js');
  const { createCompletionEffects } = await completionEffectsPromise;
  if (state.disposed) return null;
  completionEffects ||= createCompletionEffects();
  return completionEffects;
}

async function prepareCompletionEffects() {
  completionPreparePromise ||= ensureCompletionEffects().then((effects) => effects?.prepare());
  return completionPreparePromise;
}

async function playCompletionEffects(phase) {
  const effects = await ensureCompletionEffects();
  effects?.complete(phase);
}

async function ensurePlaylistGestures() {
  if (state.disposed || disposePlaylistGestures || !elements.playlistList?.children.length) return;
  playlistGesturesPromise ||= import('./playlist-gestures.js');
  const { bindPlaylistGestures } = await playlistGesturesPromise;
  if (state.disposed || !elements.playlistList?.children.length || disposePlaylistGestures) return;
  disposePlaylistGestures = bindPlaylistGestures(elements.playlistList, {
    onRemove: (url) => { void removePlaylist(url); },
    onSelect: (url) => { void selectPlaylist(url); },
  });
}
const state = {
  routines: [],
  history: [],
  recentSelections: [],
  playerPreferences: null,
  session: null,
  completedSession: null,
  spotifySource: null,
  timerId: null,
  advanceInFlight: false,
  sessionActionInFlight: false,
  shellActive: false,
  disposed: false,
};

function toast(message, type = 'success', title = '', duration = 3500, action = null) {
  window.APStudyToast?.show?.({
    message,
    type,
    duration,
    ...(title ? { title } : {}),
    ...(action ? { action } : {}),
  });
}

function playlistToast(message, action = null) {
  toast(message, 'success', '', action ? 10_000 : 1000, action);
}

function announceSessionChange(message, title, type = 'info') {
  view.announce(message);
  toast(message, type, title);
}

function announcePhaseTransition(previousPhase, nextSession) {
  if (!nextSession) {
    announceSessionChange('Focus routine complete.', 'Routine complete', 'success');
    return;
  }
  const focusEnded = previousPhase === 'focus';
  const phaseName = focusEnded ? 'Focus' : 'Break';
  const message = focusEnded
    ? (nextSession.state === 'paused' ? 'Focus complete. Your break is ready.' : 'Focus complete. Break started.')
    : (nextSession.state === 'paused' ? 'Break complete. Your next focus is ready.' : 'Break complete. Focus started.');
  announceSessionChange(message, `${phaseName} complete`, nextSession.state === 'paused' ? 'info' : 'success');
}

function selectedRoutine() {
  return routineFromState(state, elements.routineSelect?.value);
}

function hideSidebarForFocus() {
  window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN?.(false);
  window.APSTUDY_SET_SIDEBAR_COLLAPSED?.(true, { persist: false });
  const sidebar = document.querySelector('.sidebar-container');
  if (sidebar) {
    sidebar.setAttribute('aria-hidden', 'true');
    sidebar.inert = true;
  }
}

function focusSidebar(active) {
  if (active) {
    if (!state.shellActive) {
      state.shellActive = true;
      window.APStudyProfileStatus?.setFocusMode?.(true);
    }
    hideSidebarForFocus();
    return;
  }
  const sidebar = document.querySelector('.sidebar-container');
  if (sidebar) {
    sidebar.inert = false;
    sidebar.removeAttribute('aria-hidden');
  }
  state.shellActive = false;
  window.APStudyProfileStatus?.setFocusMode?.(false);
  window.APSTUDY_SET_MOBILE_SIDEBAR_OPEN?.(false);
}

function stopTimer() {
  window.clearTimeout(state.timerId);
  state.timerId = null;
}

function renderSuggestions() {
  view.renderSuggestions(suggestedBreaks(elements.focusMinutes.value, state.recentSelections));
  const duration = Number(elements.focusMinutes.value);
  document.querySelectorAll('[data-focus-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.focus) === duration));
  });
}

function renderSetup() {
  view.renderRoutines(state.routines);
  view.renderRecent(state.recentSelections);
  renderSuggestions();
  view.syncRhythmVisibility();
}

function renderActiveSession() {
  if (!state.session) return;
  if (state.session.spotify_url) state.spotifySource = state.session;
  view.renderSession(state.session);
  view.renderSpotify(state.spotifySource || state.session);
  tick();
}

function renderCompletedSession() {
  if (!state.completedSession) return;
  stopTimer();
  view.renderSession(state.completedSession);
  view.renderTick(state.completedSession, 0);
  view.renderSpotify(state.spotifySource || state.completedSession);
  document.title = 'Focus complete - Nest';
}

function renderCurrentMode() {
  const activeSession = state.session || state.completedSession;
  const active = Boolean(activeSession);
  view.showMode(active, activeSession);
  view.renderHistory(state.history);
  if (state.session) {
    focusSidebar(true);
    renderActiveSession();
  } else if (state.completedSession) {
    focusSidebar(true);
    renderCompletedSession();
  } else {
    stopTimer();
    document.title = 'Focus Mode - APStudy Nest';
    focusSidebar(false);
    renderSetup();
    view.renderSpotify(state.spotifySource || selectedRoutine());
  }
}

async function loadState({ preserveStatus = false } = {}) {
  try {
    const payload = await focusApi.state();
    state.routines = payload.routines || [];
    state.history = payload.history || [];
    state.recentSelections = payload.recent_selections || [];
    state.playerPreferences = payload.player_preferences || state.playerPreferences;
    if (state.playerPreferences) view.applyPlayerPreferences(state.playerPreferences);
    state.session = clockedSession(payload.active_session);
    if (state.session) state.completedSession = null;
    if (!preserveStatus) view.setFormStatus();
    renderCurrentMode();
  } catch (error) {
    elements.loading.hidden = true;
    elements.setup.hidden = false;
    view.setFormStatus(error.message, 'error');
    toast(error.message, 'error', 'Couldn’t load Focus Mode');
  }
}

function scheduleTick() {
  stopTimer();
  if (!state.session || state.session.state !== 'running' || state.disposed) return;
  const delay = 1000 - (Date.now() % 1000) + 20;
  state.timerId = window.setTimeout(tick, delay);
}

async function advancePhase() {
  if (!state.session || state.advanceInFlight || state.sessionActionInFlight) return;
  state.advanceInFlight = true;
  view.setSessionBusy(true);
  stopTimer();
  try {
    const previousPhase = state.session.phase;
    const previousSession = state.session;
    const payload = await focusApi.updateSession(state.session.id, 'advance');
    const next = clockedSession(payload.session);
    view.pauseSpotify();
    void playCompletionEffects(previousPhase);
    if (!payload.active) {
      view.renderTick(state.session, 0);
      await view.playEggOpening(previousPhase);
      state.session = null;
      view.clearSpotify();
      state.completedSession = { ...previousSession, state: 'completed', remaining_seconds: 0, _clockRemaining: 0 };
      announcePhaseTransition(previousPhase, null);
      renderCurrentMode();
      await refreshHistory();
      return;
    }
    state.session = next;
    view.renderSession(next);
    view.renderTick(next, remainingSeconds(next));
    await view.playEggOpening(previousPhase);
    view.resetEgg();
    view.renderTick(next, remainingSeconds(next));
    announcePhaseTransition(previousPhase, next);
    if (next.phase === 'focus' && next.state === 'running') view.resumeSpotify();
    await refreshHistory();
    scheduleTick();
  } catch (error) {
    toast('The timer will retry when Nest reconnects.', 'error', 'Couldn’t sync this phase');
    state.timerId = window.setTimeout(advancePhase, 15000);
  } finally {
    state.advanceInFlight = false;
    view.setSessionBusy(false);
  }
}

function tick() {
  if (!state.session) return;
  const remaining = remainingSeconds(state.session);
  view.renderTick(state.session, remaining);
  if (state.session.state === 'running' && remaining <= 0) {
    void advancePhase();
    return;
  }
  scheduleTick();
}

async function refreshHistory() {
  try {
    const payload = await focusApi.state();
    state.history = payload.history || [];
    state.recentSelections = payload.recent_selections || [];
    view.renderHistory(state.history);
    view.renderRecent(state.recentSelections);
  } catch (_error) {
    // The next meaningful session action will refresh history again.
  }
}

async function updateSession(action) {
  if (!state.session || state.sessionActionInFlight) return;
  const previousPhase = state.session.phase;
  state.sessionActionInFlight = true;
  const button = action === 'pause' || action === 'resume' ? elements.toggle : elements.completePhase;
  view.setSessionBusy(true, button);
  if (action === 'pause') view.pauseSpotify();
  if (action === 'resume') view.resumeSpotify();
  try {
    const payload = await focusApi.updateSession(state.session.id, action);
    const previousSession = state.session;
    state.session = payload.active ? clockedSession(payload.session) : null;
    if (!state.session) {
      if (action === 'complete_phase') {
        view.renderTick(previousSession, 0);
        view.pauseSpotify();
        void playCompletionEffects(previousPhase);
        await view.playEggOpening(previousPhase);
        state.completedSession = { ...previousSession, state: 'completed', remaining_seconds: 0, _clockRemaining: 0 };
        view.clearSpotify();
        renderCurrentMode();
        await refreshHistory();
      }
      if (action === 'complete_phase') announcePhaseTransition(previousPhase, null);
      return;
    }
    renderActiveSession();
    if (action === 'complete_phase') {
      view.pauseSpotify();
      void playCompletionEffects(previousPhase);
      await view.playEggOpening(previousPhase);
      view.resetEgg();
      renderActiveSession();
      announcePhaseTransition(previousPhase, state.session);
      if (state.session.phase === 'focus' && state.session.state === 'running') view.resumeSpotify();
      await refreshHistory();
    } else {
      const message = action === 'pause' ? 'Timer paused.' : 'Timer resumed.';
      announceSessionChange(message, action === 'pause' ? 'Timer paused' : 'Timer resumed');
    }
  } catch (error) {
    if (action === 'resume') view.pauseSpotify();
    toast(error.message, 'error', 'Couldn’t update the timer');
  } finally {
    state.sessionActionInFlight = false;
    view.setSessionBusy(false);
  }
}

async function confirmEndSession() {
  if (!state.session) return false;
  if (!window.APStudyConfirm?.request) return window.confirm('End this Focus Mode session?');
  return window.APStudyConfirm.request({
    title: 'End this Focus Mode session?',
    message: 'The unfinished phase will not be added to completion history.',
    acceptLabel: 'End session',
    danger: true,
  });
}

async function endSession() {
  if (!state.session || state.sessionActionInFlight) return;
  state.sessionActionInFlight = true;
  view.setSessionBusy(true, elements.end);
  try {
    if (!(await confirmEndSession())) return;
    view.pauseSpotify();
    await focusApi.updateSession(state.session.id, 'exit');
    state.session = null;
    view.clearSpotify();
    focusSidebar(false);
    await loadState({ preserveStatus: true });
    view.setFormStatus('Session ended. Completed phases remain in your history.');
    announceSessionChange('Session ended. Completed phases remain in your history.', 'Focus session ended');
  } catch (error) {
    toast(error.message, 'error', 'Couldn’t end Focus Mode');
  } finally {
    state.sessionActionInFlight = false;
    view.setSessionBusy(false);
  }
}

function exitCompletedSession() {
  state.completedSession = null;
  renderCurrentMode();
}

function applySelection(selection) {
  elements.focusMinutes.value = selection.focus_minutes;
  elements.breakMinutes.value = selection.break_minutes || 0;
  elements.longBreakMinutes.value = selection.long_break_minutes || selection.break_minutes || 0;
  elements.cycles.value = selection.cycles || 1;
  renderSuggestions();
  if (Object.prototype.hasOwnProperty.call(selection, 'spotify_url')) {
    const spotifySelection = {
      ...selection,
      spotify_url: selection.spotify_url || '',
      spotify_embed_url: playlistEmbedUrl(selection.spotify_url || ''),
    };
    state.spotifySource = spotifySelection.spotify_url ? spotifySelection : null;
    view.renderSpotify(spotifySelection);
  }
}

async function startSession(event) {
  event.preventDefault();
  void prepareCompletionEffects();
  const payload = formPayload(elements.form);
  view.setBusy(true);
  view.setFormStatus('Starting your focus session…');
  try {
    const response = await focusApi.start(payload);
    state.session = clockedSession(response.session);
    state.completedSession = null;
    if (state.session.spotify_url) state.spotifySource = state.session;
    view.setFormStatus();
    renderCurrentMode();
    void view.activateSpotify({ autoplay: true });
    void view.startCountdown();
    announceSessionChange('Focus Mode started. Nonurgent Nest notifications are muted.', 'Focus Mode started');
  } catch (error) {
    view.pauseSpotify();
    view.setFormStatus(error.message, 'error');
  } finally {
    view.setBusy(false);
  }
}

async function applyPlaylist() {
  const normalized = view.syncPlaylistControls({ clearStatus: true });
  if (!normalized) {
    elements.spotifyUrl?.focus();
    return;
  }
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.setPlaylist(state.session.id, normalized);
      state.session = clockedSession(response.session);
      state.spotifySource = state.session;
      view.renderSpotify(state.session);
      void view.activateSpotify({ autoplay: state.session.phase === 'focus' && state.session.state === 'running' });
      playlistToast('Playlist added to this session.');
      return;
    }
    const current = state.spotifySource || selectedRoutine() || {};
    const existing = Array.isArray(current.playlists) ? current.playlists : [];
    const duplicate = existing.find((playlist) => playlist.spotify_url === normalized);
    const playlist = duplicate || (await focusApi.previewPlaylist(normalized)).playlist;
    const nextPlaylist = {
      ...current,
      spotify_url: normalized,
      spotify_embed_url: playlistEmbedUrl(normalized),
      playlists: duplicate ? existing : [...existing, playlist],
    };
    state.spotifySource = nextPlaylist;
    view.renderSpotify(nextPlaylist);
    playlistToast(duplicate ? 'Playlist selected.' : 'Playlist added.');
  } catch (error) {
    view.setPlaylistStatus(error.message, 'error');
  } finally {
    view.setPlaylistBusy(false);
  }
}

function playlistByUrl(source, url) {
  return (source?.playlists || []).find((playlist) => playlist.spotify_url === url) || null;
}

function localPlaylistSource(source, playlists, activeUrl) {
  if (!playlists.length) return null;
  const active = playlistByUrl({ playlists }, activeUrl) || playlists[0];
  return {
    ...source,
    spotify_url: active.spotify_url,
    spotify_embed_url: active.embed_url || active.spotify_embed_url || playlistEmbedUrl(active.spotify_url),
    embed_url: active.embed_url || active.spotify_embed_url || playlistEmbedUrl(active.spotify_url),
    playlist_provider: active.provider,
    playlists,
  };
}

async function restorePlaylist(record) {
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.restorePlaylist(state.session.id, record.playlist.spotify_url, record.activeUrl);
      state.session = clockedSession(response.session);
      state.spotifySource = state.session;
      view.renderSpotify(state.session);
      void view.activateSpotify({ autoplay: state.session.phase === 'focus' && state.session.state === 'running' });
    } else {
      const source = state.spotifySource || record.source;
      const playlists = [...(source?.playlists || [])];
      if (!playlistByUrl({ playlists }, record.playlist.spotify_url)) {
        playlists.splice(Math.min(record.index, playlists.length), 0, record.playlist);
      }
      state.spotifySource = localPlaylistSource(source, playlists, record.activeUrl);
      view.renderSpotify(state.spotifySource);
    }
    playlistToast('Playlist restored.');
  } catch (error) {
    view.setPlaylistStatus(error.message, 'error');
  } finally {
    view.setPlaylistBusy(false);
  }
}

async function removePlaylist(playlistUrl = '') {
  const source = state.session || state.spotifySource || selectedRoutine() || {};
  const targetUrl = playlistUrl || source.spotify_url;
  const playlists = Array.isArray(source.playlists) ? source.playlists : [];
  const index = playlists.findIndex((playlist) => playlist.spotify_url === targetUrl);
  const playlist = index >= 0 ? playlists[index] : {
    spotify_url: targetUrl,
    title: 'Playlist',
    creator: 'Music',
  };
  if (!targetUrl) return;
  const record = { playlist, index: Math.max(0, index), activeUrl: source.spotify_url, source };
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.removePlaylist(state.session.id, targetUrl);
      state.session = clockedSession(response.session);
      state.spotifySource = state.session.spotify_url ? state.session : null;
      view.renderSpotify(state.session);
    } else {
      const remaining = playlists.filter((item) => item.spotify_url !== targetUrl);
      state.spotifySource = localPlaylistSource(source, remaining, source.spotify_url);
      view.renderSpotify(state.spotifySource);
    }
    playlistToast(`${playlist.title || 'Playlist'} removed.`, {
      label: 'Undo',
      onClick: () => { void restorePlaylist(record); },
    });
  } catch (error) {
    view.setPlaylistStatus(error.message, 'error');
  } finally {
    view.setPlaylistBusy(false);
  }
}

async function selectPlaylist(spotifyUrl) {
  const current = state.session || state.spotifySource || selectedRoutine();
  if (!current || current.spotify_url === spotifyUrl) return;
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.setPlaylist(state.session.id, spotifyUrl);
      state.session = clockedSession(response.session);
      state.spotifySource = state.session;
      view.renderSpotify(state.session);
      void view.activateSpotify({ autoplay: state.session.phase === 'focus' && state.session.state === 'running' });
    } else {
      const playlist = (current.playlists || []).find((item) => item.spotify_url === spotifyUrl);
      if (!playlist) return;
      state.spotifySource = {
        ...current,
        spotify_url: spotifyUrl,
        spotify_embed_url: playlist.embed_url || playlist.spotify_embed_url || playlistEmbedUrl(spotifyUrl),
        embed_url: playlist.embed_url || playlist.spotify_embed_url || playlistEmbedUrl(spotifyUrl),
      };
      view.renderSpotify(state.spotifySource);
    }
    playlistToast('Playlist selected.');
  } catch (error) {
    view.setPlaylistStatus(error.message, 'error');
  } finally {
    view.setPlaylistBusy(false);
  }
}

function payloadFromRoutine(routine) {
  return {
    routine_id: routine.id,
    name: routine.name,
    focus_minutes: routine.focus_minutes,
    break_minutes: routine.break_minutes || 0,
    long_break_minutes: routine.long_break_minutes || routine.break_minutes || 0,
    cycles: routine.cycles || 1,
    spotify_url: routine.spotify_url || '',
    spotify_playlists: (routine.playlists || []).map((playlist) => playlist.spotify_url),
  };
}

async function undoRoutineSave(record) {
  try {
    if (record.previous) {
      const response = await focusApi.saveRoutine(payloadFromRoutine(record.previous), record.saved.id);
      const index = state.routines.findIndex((routine) => routine.id === record.saved.id);
      if (index >= 0) state.routines[index] = response.routine;
      view.renderRoutines(state.routines, response.routine.id);
      view.fillRoutine(response.routine);
      state.spotifySource = response.routine.spotify_url ? response.routine : null;
      view.renderSpotify(response.routine);
    } else {
      await focusApi.deleteRoutine(record.saved.id);
      state.routines = state.routines.filter((routine) => routine.id !== record.saved.id);
      view.renderRoutines(state.routines);
      view.fillRoutine(null);
      state.spotifySource = null;
      view.renderSpotify(null);
      renderSuggestions();
    }
    view.setSettingsStatus('Saved setup restored.', 'success');
    playlistToast('Focus setup restored.');
  } catch (error) {
    view.setSettingsStatus(error.message, 'error');
    toast(error.message, 'error', 'Couldn’t undo the save');
  }
}

async function saveRoutine() {
  const payload = formPayload(elements.form);
  if (!elements.routineName.value.trim()) {
    view.setSettingsStatus('Enter a routine name before saving.', 'error');
    elements.routineName.focus();
    return;
  }
  elements.saveRoutines.forEach((button) => { button.disabled = true; });
  try {
    const selectedId = elements.routineSelect.value;
    const previous = selectedId ? selectedRoutine() : null;
    const previousSnapshot = previous ? {
      ...previous,
      playlists: (previous.playlists || []).map((playlist) => ({ ...playlist })),
    } : null;
    const response = await focusApi.saveRoutine(payload, selectedId);
    const index = state.routines.findIndex((routine) => routine.id === response.routine.id);
    if (index >= 0) state.routines[index] = response.routine;
    else state.routines.unshift(response.routine);
    view.renderRoutines(state.routines, response.routine.id);
    state.spotifySource = response.routine.spotify_url ? response.routine : null;
    view.renderSpotify(response.routine);
    const setupName = response.routine.name;
    view.setSettingsStatus(
      previousSnapshot ? `Changes saved to “${setupName}”.` : `“${setupName}” saved as a new setup.`,
      'success',
    );
    toast(
      previousSnapshot ? 'This focus setup was updated.' : 'A new focus setup was created.',
      'success',
      previousSnapshot ? `Changes saved to “${setupName}”` : `“${setupName}” saved`,
      10_000,
      { label: 'Undo', onClick: () => { void undoRoutineSave({ previous: previousSnapshot, saved: response.routine }); } },
    );
  } catch (error) {
    view.setSettingsStatus(error.message, 'error');
  } finally {
    elements.saveRoutines.forEach((button) => { button.disabled = false; });
  }
}

async function deleteRoutine() {
  const routine = selectedRoutine();
  if (!routine) return;
  const accepted = window.APStudyConfirm?.request
    ? await window.APStudyConfirm.request({
      title: `Delete “${routine.name}”?`,
      message: 'Completion history will stay intact.',
      acceptLabel: 'Delete routine',
      danger: true,
    })
    : window.confirm(`Delete “${routine.name}”?`);
  if (!accepted) return;
  try {
    await focusApi.deleteRoutine(routine.id);
    state.routines = state.routines.filter((item) => item.id !== routine.id);
    view.renderRoutines(state.routines);
    view.fillRoutine(null);
    view.renderSpotify(null);
    state.spotifySource = null;
    renderSuggestions();
    view.setSettingsStatus('Routine deleted.');
  } catch (error) {
    view.setSettingsStatus(error.message, 'error');
  }
}

function bindEvents() {
  const eventController = new AbortController();
  const listenerOptions = { signal: eventController.signal };
  elements.form.addEventListener('submit', startSession, listenerOptions);
  elements.form.querySelector('button[type="submit"]')?.addEventListener('pointerdown', () => {
    void prepareCompletionEffects();
  }, listenerOptions);
  elements.optionsOpen.forEach((button) => button.addEventListener('click', () => view.openOptions(button), listenerOptions));
  elements.focusMinutes.addEventListener('input', renderSuggestions, listenerOptions);
  elements.cycles.addEventListener('input', () => {
    renderSuggestions();
    view.syncRhythmVisibility();
  }, listenerOptions);
  elements.routineSelect.addEventListener('change', () => {
    const routine = selectedRoutine();
    state.spotifySource = routine?.spotify_url ? routine : null;
    view.fillRoutine(routine);
    view.renderSpotify(routine);
    view.setSettingsStatus();
    view.setPlaylistStatus();
    renderSuggestions();
  }, listenerOptions);
  elements.form.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-focus-preset]');
    if (preset) {
      applySelection({
        focus_minutes: Number(preset.dataset.focus),
        break_minutes: Number(preset.dataset.break),
        long_break_minutes: Number(preset.dataset.break),
        cycles: Number(preset.dataset.cycles),
      });
      return;
    }
    const recent = event.target.closest('[data-recent-selection]');
    if (recent) applySelection(state.recentSelections[Number(recent.dataset.recentSelection)]);
  }, listenerOptions);
  elements.suggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-break-suggestion]');
    if (!button) return;
    elements.breakMinutes.value = button.dataset.breakSuggestion;
    if (!Number(elements.longBreakMinutes.value)) elements.longBreakMinutes.value = button.dataset.breakSuggestion;
  }, listenerOptions);
  elements.layoutInputs.forEach((input) => input.addEventListener('change', () => {
    if (input.checked) view.setSpotifyLayout(input.value);
  }, listenerOptions));
  elements.spotifyUrl?.addEventListener('input', () => view.syncPlaylistControls({ clearStatus: true }), listenerOptions);
  elements.playlistToggle?.addEventListener('click', () => {
    const open = elements.playlistToggle.getAttribute('aria-expanded') !== 'true';
    view.setPlaylistEditor(open);
    if (!open) view.setPlaylistStatus();
  }, listenerOptions);
  elements.playlistApply?.addEventListener('click', () => { void applyPlaylist(); }, listenerOptions);
  elements.playlistRemove?.addEventListener('click', (event) => {
    const coarsePointer = window.matchMedia?.('(hover: none), (pointer: coarse)').matches;
    if (event.detail > 0 && coarsePointer && !elements.playerFrame?.classList.contains('is-actions-visible')) {
      elements.playerFrame?.classList.add('is-actions-visible');
      return;
    }
    void removePlaylist();
  }, listenerOptions);
  elements.spotifyEmbed?.addEventListener('click', (event) => {
    if (!event.target.closest('[data-focus-player-load]')) return;
    void view.activateSpotify({ autoplay: false });
  }, listenerOptions);
  elements.spotifyUrl?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      view.setPlaylistEditor(false);
      if (elements.playlistToggle?.getAttribute('aria-expanded') !== 'true') {
        elements.playlistToggle.focus();
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!elements.playlistApply.disabled) void applyPlaylist();
  }, listenerOptions);
  document.addEventListener('pointerdown', (event) => {
    if (elements.playlistToggle?.getAttribute('aria-expanded') === 'true'
        && !elements.playlistComposer?.contains(event.target)) {
      view.setPlaylistEditor(false);
    }
    if (!elements.playerFrame?.contains(event.target)) {
      elements.playerFrame?.classList.remove('is-actions-visible');
    }
  }, listenerOptions);
  elements.historyRegion?.addEventListener('toggle', () => {
    if (elements.historyRegion.open) void view.mountHistory();
  }, listenerOptions);
  elements.saveRoutines.forEach((button) => button.addEventListener('click', saveRoutine, listenerOptions));
  elements.deleteRoutine.addEventListener('click', deleteRoutine, listenerOptions);
  elements.toggle.addEventListener('click', () => updateSession(state.session?.state === 'paused' ? 'resume' : 'pause'), listenerOptions);
  elements.completePhase.addEventListener('click', () => updateSession('complete_phase'), listenerOptions);
  elements.end.addEventListener('click', () => {
    if (state.completedSession) exitCompletedSession();
    else void endSession();
  }, listenerOptions);
  document.addEventListener('focus:playlist-list-rendered', (event) => {
    if (event.detail?.hasItems) void ensurePlaylistGestures();
  }, listenerOptions);
  document.addEventListener('apstudy-sidebar-state-change', (event) => {
    if (state.session && event.detail?.collapsed === false) queueMicrotask(hideSidebarForFocus);
  }, listenerOptions);
  document.addEventListener('apstudy-mobile-sidebar-toggle', () => {
    if (state.session) queueMicrotask(hideSidebarForFocus);
  }, listenerOptions);
  document.addEventListener('visibilitychange', () => {
    if (state.completedSession) return;
    if (document.hidden) tick();
    else void loadState({ preserveStatus: true });
  }, listenerOptions);
  window.addEventListener('online', () => {
    if (state.session && remainingSeconds(state.session) <= 0) void advancePhase();
  }, listenerOptions);
  window.APStudyPageLifecycle?.register?.({
    pause: stopTimer,
    resume: tick,
    dispose: () => {
      state.disposed = true;
      stopTimer();
      eventController.abort();
      disposePlaylistGestures?.();
      disposePlaylistGestures = null;
      completionEffects?.dispose?.();
      view.dispose();
    },
  });
}

bindEvents();
void loadState();
