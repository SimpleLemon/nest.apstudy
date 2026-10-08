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
  savePlayerPreferences,
  notify: ({ message, type = 'error', title = '' } = {}) => toast(message, type, title),
  onRoutineSelect: (routineId) => {
    if (!isCurrentOperation(currentOperation())) return;
    const routine = routineFromState(state, routineId);
    view.fillRoutine(routine, { updatePicker: false });
    if (routine?.spotify_url && state.playlistSource?.playlists?.some((playlist) => playlist.spotify_url === routine.spotify_url)) {
      state.playlistSource = localPlaylistSource(state.playlistSource, state.playlistSource.playlists, routine.spotify_url);
    }
    view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
    view.setSettingsStatus();
    view.setPlaylistStatus();
    renderSuggestions();
  },
  onRoutineCreate: () => {
    if (!isCurrentOperation(currentOperation())) return;
    view.fillRoutine(null, { updatePicker: false });
    view.setSettingsStatus();
  },
});
const { elements } = view;
let completionEffects = null;
let completionEffectsPromise = null;
let completionPreparePromise = null;
let disposePlaylistGestures = null;
let playlistGesturesPromise = null;

async function ensureCompletionEffects(operation = currentOperation()) {
  if (!isCurrentOperation(operation)) return null;
  if (completionEffects) return completionEffects;
  completionEffectsPromise ||= import('./completion.js');
  const { createCompletionEffects } = await completionEffectsPromise;
  if (!isCurrentOperation(operation)) return null;
  completionEffects ||= createCompletionEffects();
  return completionEffects;
}

async function prepareCompletionEffects() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  completionPreparePromise ||= ensureCompletionEffects(operation)
    .then((effects) => effects?.prepare({ signal: operation.signal }))
    .catch(() => {});
  return completionPreparePromise;
}

async function playCompletionEffects(phase, operation) {
  try {
    const effects = await ensureCompletionEffects(operation);
    if (isCurrentOperation(operation)) effects?.complete(phase, { signal: operation.signal });
  } catch { /* Optional completion effects must not interrupt the timer. */ }
}

async function ensurePlaylistGestures() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation) || disposePlaylistGestures || !elements.playlistList?.children.length) return;
  playlistGesturesPromise ||= import('./playlist-gestures.js');
  const { bindPlaylistGestures } = await playlistGesturesPromise;
  if (!isCurrentOperation(operation) || !elements.playlistList?.children.length || disposePlaylistGestures) return;
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
  playlistSource: null,
  playlistEntitlements: null,
  timerId: null,
  advanceInFlight: false,
  sessionActionInFlight: false,
  shellActive: false,
  disposed: false,
  paused: false,
  generation: 0,
  requestController: new AbortController(),
};

function currentOperation() {
  return { generation: state.generation, signal: state.requestController.signal };
}

function isCurrentOperation(operation) {
  return !state.disposed && !state.paused && !operation.signal.aborted
    && operation.generation === state.generation;
}

async function savePlayerPreferences(preferences) {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  try {
    const response = await focusApi.savePlayerPreferences(preferences, { signal: operation.signal });
    if (isCurrentOperation(operation)) return response;
  } catch (error) {
    if (isCurrentOperation(operation)) showError(error, 'Couldn’t save player preferences');
  }
}

function pauseRuntime() {
  state.paused = true;
  state.generation += 1;
  state.requestController.abort();
  completionPreparePromise = null;
  stopTimer();
  state.advanceInFlight = false;
  state.sessionActionInFlight = false;
  view.setSessionBusy(false);
  view.setBusy(false);
  view.setPlaylistBusy(false);
  elements.saveRoutines.forEach((button) => { button.disabled = false; });
  view.pauseMusic();
}

function resumeRuntime() {
  if (state.disposed || !state.paused) return;
  state.paused = false;
  state.requestController = new AbortController();
  // Reconcile server mutations that may have completed while the page was cached.
  void loadState({ restored: true });
}

function toast(message, type = 'success', title = '', duration = 3500, action = null) {
  window.APStudyToast?.show?.({
    message,
    type,
    duration,
    ...(title ? { title } : {}),
    ...(action ? { action } : {}),
  });
}

function showError(error, title, fallback = 'Try again in a moment.') {
  toast(error?.message || fallback, 'error', title);
}

function showPlaylistError(error, title, fallback = 'Try again in a moment.') {
  if (error?.code === 'tier_limit') {
    toast(error.message || fallback, 'error', title || 'Playlist limit reached');
    return;
  }
  showError(error, title, fallback);
}

function playlistSourceFromLibrary(playlists = [], activeUrl = '') {
  const list = Array.isArray(playlists) ? playlists : [];
  const url = String(activeUrl || '').trim() || list[0]?.spotify_url || '';
  if (!url && !list.length) return null;
  const active = list.find((playlist) => playlist.spotify_url === url) || list[0] || {};
  const embedUrl = active.embed_url || active.spotify_embed_url || playlistEmbedUrl(url);
  return {
    spotify_url: url,
    spotify_embed_url: embedUrl,
    embed_url: embedUrl,
    playlist_provider: active.provider,
    playlists: list,
  };
}

function applyLibraryResponse(payload) {
  state.playlistEntitlements = payload.playlist_entitlements || state.playlistEntitlements;
  state.playlistSource = playlistSourceFromLibrary(
    payload.playlists,
    payload.spotify_url || payload.active_playlist_url,
  );
  view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
  return state.playlistSource;
}

function syncSessionPlaylistSource(session) {
  if (!session) return state.playlistSource;
  state.playlistSource = playlistSourceFromLibrary(session.playlists, session.spotify_url);
  if (state.playlistEntitlements) {
    state.playlistEntitlements = {
      ...state.playlistEntitlements,
      usage: Array.isArray(session.playlists) ? session.playlists.length : state.playlistEntitlements.usage,
    };
  }
  return state.playlistSource;
}

function playlistToast(message, action = null) {
  toast(message, 'success', '', action ? 10_000 : 1000, action);
}

function announceSessionChange(message, title, type = 'info') {
  view.announce(message, { signal: state.requestController.signal });
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
  view.syncTimeSuggestionPressed();
}

function renderSetup() {
  view.renderRoutines(state.routines);
  view.renderRecent(state.recentSelections);
  renderSuggestions();
  view.syncRhythmVisibility();
}

function renderActiveSession() {
  if (!state.session) return;
  syncSessionPlaylistSource(state.session);
  view.renderSession(state.session);
  view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
  tick();
}

function renderCompletedSession() {
  if (!state.completedSession) return;
  stopTimer();
  view.renderSession(state.completedSession);
  view.renderTick(state.completedSession, 0);
  view.renderPlaylists(state.playlistSource || playlistSourceFromLibrary([], state.completedSession.spotify_url), state.playlistEntitlements);
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
    view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
  }
}

async function loadState({ restored = false } = {}) {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  try {
    const payload = await focusApi.state({ signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    state.routines = payload.routines || [];
    state.history = payload.history || [];
    state.recentSelections = payload.recent_selections || [];
    state.playerPreferences = payload.player_preferences || state.playerPreferences;
    if (state.playerPreferences) view.applyPlayerPreferences(state.playerPreferences);
    state.playlistEntitlements = payload.playlist_entitlements || state.playlistEntitlements;
    state.playlistSource = playlistSourceFromLibrary(payload.playlists, payload.active_playlist_url);
    state.session = clockedSession(payload.active_session);
    if (state.session) state.completedSession = null;
    if (restored && !state.completedSession) view.resetEgg();
    renderCurrentMode();
    if (restored && state.session?.phase === 'focus' && state.session.state === 'running') view.resumeMusic();
  } catch (error) {
    if (!isCurrentOperation(operation)) return;
    elements.loading.hidden = true;
    elements.setup.hidden = false;
    showError(error, 'Couldn’t load Focus Mode');
  }
}

function scheduleTick() {
  stopTimer();
  if (!state.session || state.session.state !== 'running' || state.disposed || state.paused) return;
  const delay = 1000 - (Date.now() % 1000) + 20;
  const operation = currentOperation();
  state.timerId = window.setTimeout(() => {
    if (isCurrentOperation(operation)) tick();
  }, delay);
}

async function applyPhaseCompletion(previousSession, payload, operation) {
  if (!isCurrentOperation(operation)) return;
  const previousPhase = previousSession.phase;
  const next = payload.active ? clockedSession(payload.session) : null;
  view.pauseMusic();
  void playCompletionEffects(previousPhase, operation);
  if (next) {
    view.renderSession(next);
    view.renderTick(next, remainingSeconds(next));
  } else {
    view.renderTick(previousSession, 0);
  }
  await view.playEggOpening(previousPhase, { signal: operation.signal });
  if (!isCurrentOperation(operation)) return;
  state.session = next;
  state.completedSession = next ? null : {
    ...previousSession, state: 'completed', remaining_seconds: 0, _clockRemaining: 0,
  };
  if (next) view.resetEgg();
  renderCurrentMode();
  announcePhaseTransition(previousPhase, next);
  if (next?.phase === 'focus' && next.state === 'running') view.resumeMusic();
  await refreshHistory(operation);
  if (isCurrentOperation(operation)) scheduleTick();
}

async function advancePhase() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation) || !state.session || state.advanceInFlight || state.sessionActionInFlight) return;
  const previousSession = state.session;
  state.advanceInFlight = true;
  view.setSessionBusy(true);
  stopTimer();
  try {
    const payload = await focusApi.updateSession(previousSession.id, 'advance', { signal: operation.signal });
    await applyPhaseCompletion(previousSession, payload, operation);
  } catch {
    if (!isCurrentOperation(operation)) return;
    toast('The timer will retry when Nest reconnects.', 'error', 'Couldn’t sync this phase');
    state.timerId = window.setTimeout(() => {
      if (isCurrentOperation(operation)) void advancePhase();
    }, 15000);
  } finally {
    if (isCurrentOperation(operation)) {
      state.advanceInFlight = false;
      view.setSessionBusy(false);
    }
  }
}

function tick() {
  if (state.disposed || state.paused || !state.session || state.advanceInFlight || state.sessionActionInFlight) return;
  const remaining = remainingSeconds(state.session);
  view.renderTick(state.session, remaining);
  if (state.session.state === 'running' && remaining <= 0) {
    void advancePhase();
    return;
  }
  scheduleTick();
}

async function refreshHistory(operation = currentOperation()) {
  if (!isCurrentOperation(operation)) return;
  try {
    const payload = await focusApi.state({ signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    state.history = payload.history || [];
    state.recentSelections = payload.recent_selections || [];
    view.renderHistory(state.history);
    view.renderRecent(state.recentSelections);
  } catch {
    // The next meaningful session action will refresh history again.
  }
}

async function updateSession(action) {
  const operation = currentOperation();
  if (!isCurrentOperation(operation) || !state.session || state.sessionActionInFlight || state.advanceInFlight) return;
  const previousSession = state.session;
  state.sessionActionInFlight = true;
  const button = action === 'pause' || action === 'resume' ? elements.toggle : elements.completePhase;
  view.setSessionBusy(true, button);
  stopTimer();
  if (action === 'pause') view.pauseMusic();
  if (action === 'resume') view.resumeMusic();
  try {
    const payload = await focusApi.updateSession(previousSession.id, action, { signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    if (action === 'complete_phase') {
      await applyPhaseCompletion(previousSession, payload, operation);
    } else {
      state.session = payload.active ? clockedSession(payload.session) : null;
      renderActiveSession();
      const message = action === 'pause' ? 'Timer paused.' : 'Timer resumed.';
      announceSessionChange(message, action === 'pause' ? 'Timer paused' : 'Timer resumed');
    }
  } catch (error) {
    if (!isCurrentOperation(operation)) return;
    if (action === 'resume') view.pauseMusic();
    showError(error, 'Couldn’t update the timer');
    if (action === 'complete_phase') scheduleTick();
  } finally {
    if (isCurrentOperation(operation)) {
      state.sessionActionInFlight = false;
      view.setSessionBusy(false);
      // Ordinary actions also stop the old timer while their request is pending.
      if (action !== 'complete_phase') scheduleTick();
    }
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
  const operation = currentOperation();
  if (!isCurrentOperation(operation) || !state.session || state.sessionActionInFlight || state.advanceInFlight) return;
  state.sessionActionInFlight = true;
  view.setSessionBusy(true, elements.end);
  try {
    if (!(await confirmEndSession()) || !isCurrentOperation(operation)) return;
    view.pauseMusic();
    await focusApi.updateSession(state.session.id, 'exit', { signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    state.session = null;
    focusSidebar(false);
    await loadState();
    if (!isCurrentOperation(operation)) return;
    announceSessionChange('Session ended. Completed phases remain in your history.', 'Focus session ended');
  } catch (error) {
    if (isCurrentOperation(operation)) showError(error, 'Couldn’t end Focus Mode');
  } finally {
    if (isCurrentOperation(operation)) {
      state.sessionActionInFlight = false;
      view.setSessionBusy(false);
    }
  }
}

function exitCompletedSession() {
  state.completedSession = null;
  renderCurrentMode();
}

function applySelection(selection) {
  if (!selection) return;
  elements.focusMinutes.value = selection.focus_minutes;
  elements.breakMinutes.value = selection.break_minutes || 0;
  elements.longBreakMinutes.value = selection.long_break_minutes || selection.break_minutes || 0;
  elements.cycles.value = selection.cycles || 1;
  view.syncRhythmVisibility();
  renderSuggestions();
  if (Object.prototype.hasOwnProperty.call(selection, 'spotify_url')) {
    const url = selection.spotify_url || '';
    if (url && state.playlistSource?.playlists?.some((playlist) => playlist.spotify_url === url)) {
      state.playlistSource = localPlaylistSource(state.playlistSource, state.playlistSource.playlists, url);
    }
    view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
  }
}

async function startSession(event) {
  event.preventDefault();
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  void prepareCompletionEffects();
  const payload = formPayload(elements.form);
  delete payload.routine_id;
  delete payload.spotify_playlists;
  view.setBusy(true);
  try {
    const response = await focusApi.start(payload, { signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    state.session = clockedSession(response.session);
    state.completedSession = null;
    syncSessionPlaylistSource(state.session);
    view.setBusy(false);
    renderCurrentMode();
    void view.activateMusic({ autoplay: true, signal: operation.signal });
    void view.startCountdown({ signal: operation.signal });
    announceSessionChange('Focus Mode started. Nonurgent Nest notifications are muted.', 'Focus Mode started');
  } catch (error) {
    if (!isCurrentOperation(operation)) return;
    view.pauseMusic();
    view.setBusy(false);
    showError(error, 'Couldn’t start Focus Mode');
  }
}

async function applyPlaylist() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  const normalized = view.syncPlaylistControls({ clearStatus: true });
  if (!normalized) {
    showError(null, 'Couldn’t add playlist', 'Use a Spotify, YouTube, or YouTube Music playlist URL.');
    elements.playlistUrlInput?.focus();
    return;
  }
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.setPlaylist(state.session.id, normalized, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      state.session = clockedSession(response.session);
      syncSessionPlaylistSource(state.session);
      view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
      void view.activateMusic({ autoplay: state.session.phase === 'focus' && state.session.state === 'running', signal: operation.signal });
      playlistToast('Playlist added to this session.');
      return;
    }
    const existing = (state.playlistSource?.playlists || []).find((playlist) => playlist.spotify_url === normalized);
    let response = existing
      ? await focusApi.setActivePlaylist(normalized, { signal: operation.signal })
      : await focusApi.addPlaylist(normalized, { signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    if (!existing && response.spotify_url !== normalized) {
      response = await focusApi.setActivePlaylist(normalized, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
    }
    applyLibraryResponse(response);
    void view.activateMusic({ autoplay: false, signal: operation.signal });
    playlistToast(existing ? 'Playlist selected.' : 'Playlist added.');
  } catch (error) {
    if (isCurrentOperation(operation)) showPlaylistError(error, 'Couldn’t add playlist');
  } finally {
    if (isCurrentOperation(operation)) view.setPlaylistBusy(false);
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
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.restorePlaylist(state.session.id, record.playlist.spotify_url, record.activeUrl, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      state.session = clockedSession(response.session);
      syncSessionPlaylistSource(state.session);
      view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
      void view.activateMusic({ autoplay: state.session.phase === 'focus' && state.session.state === 'running', signal: operation.signal });
    } else {
      let response = await focusApi.addPlaylist(record.playlist.spotify_url, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      if (record.activeUrl && response.spotify_url !== record.activeUrl) {
        response = await focusApi.setActivePlaylist(record.activeUrl, { signal: operation.signal });
        if (!isCurrentOperation(operation)) return;
      }
      applyLibraryResponse(response);
    }
    playlistToast('Playlist restored.');
  } catch (error) {
    if (isCurrentOperation(operation)) showPlaylistError(error, 'Couldn’t restore playlist');
  } finally {
    if (isCurrentOperation(operation)) view.setPlaylistBusy(false);
  }
}

async function removePlaylist(playlistUrl = '') {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  const source = state.playlistSource || state.session || {};
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
      const response = await focusApi.removeSessionPlaylist(state.session.id, targetUrl, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      state.session = clockedSession(response.session);
      syncSessionPlaylistSource(state.session);
      view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
    } else {
      const response = await focusApi.removePlaylist(targetUrl, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      applyLibraryResponse(response);
    }
    playlistToast(`${playlist.title || 'Playlist'} removed.`, {
      label: 'Undo',
      onClick: () => { if (isCurrentOperation(operation)) void restorePlaylist(record); },
    });
  } catch (error) {
    if (isCurrentOperation(operation)) showPlaylistError(error, 'Couldn’t remove playlist');
  } finally {
    if (isCurrentOperation(operation)) view.setPlaylistBusy(false);
  }
}

async function selectPlaylist(playlistUrl) {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  const current = state.session || state.playlistSource;
  if (!current || current.spotify_url === playlistUrl) return;
  view.setPlaylistBusy(true);
  try {
    if (state.session) {
      const response = await focusApi.setPlaylist(state.session.id, playlistUrl, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      state.session = clockedSession(response.session);
      syncSessionPlaylistSource(state.session);
      view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
      void view.activateMusic({ autoplay: state.session.phase === 'focus' && state.session.state === 'running', signal: operation.signal });
    } else {
      const response = await focusApi.setActivePlaylist(playlistUrl, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      applyLibraryResponse(response);
    }
    playlistToast('Playlist selected.');
  } catch (error) {
    if (isCurrentOperation(operation)) showPlaylistError(error, 'Couldn’t select playlist');
  } finally {
    if (isCurrentOperation(operation)) view.setPlaylistBusy(false);
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
  };
}

async function undoRoutineSave(record) {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  try {
    if (record.previous) {
      const response = await focusApi.saveRoutine(payloadFromRoutine(record.previous), record.saved.id, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      const index = state.routines.findIndex((routine) => routine.id === record.saved.id);
      if (index >= 0) state.routines[index] = response.routine;
      view.renderRoutines(state.routines, response.routine.id);
      view.fillRoutine(response.routine);
      if (response.routine.spotify_url && state.playlistSource?.playlists?.some((playlist) => playlist.spotify_url === response.routine.spotify_url)) {
        state.playlistSource = localPlaylistSource(state.playlistSource, state.playlistSource.playlists, response.routine.spotify_url);
      }
      view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
    } else {
      await focusApi.deleteRoutine(record.saved.id, { signal: operation.signal });
      if (!isCurrentOperation(operation)) return;
      state.routines = state.routines.filter((routine) => routine.id !== record.saved.id);
      view.renderRoutines(state.routines);
      view.fillRoutine(null);
      state.playlistSource = null;
      view.renderPlaylists(null, state.playlistEntitlements);
      renderSuggestions();
    }
    view.setSettingsStatus('Saved setup restored.', 'success');
    playlistToast('Focus setup restored.');
  } catch (error) {
    if (isCurrentOperation(operation)) showError(error, 'Couldn’t undo the save');
  }
}

async function saveRoutine() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
  const payload = formPayload(elements.form);
  delete payload.routine_id;
  delete payload.spotify_playlists;
  const selectedId = elements.routineSelect.value;
  const creating = !selectedId;
  if (creating && !elements.routineName.value.trim()) {
    showError(null, 'Couldn’t save focus setup', 'Enter a setup name before saving.');
    elements.routineName.focus();
    return;
  }
  if (!creating) {
    const routine = selectedRoutine();
    if (routine) elements.routineName.value = routine.name;
  }
  elements.saveRoutines.forEach((button) => { button.disabled = true; });
  try {
    const previous = selectedId ? selectedRoutine() : null;
    const previousSnapshot = previous ? {
      ...previous,
      playlists: (previous.playlists || []).map((playlist) => ({ ...playlist })),
    } : null;
    const response = await focusApi.saveRoutine(payload, selectedId, { signal: operation.signal });
    if (!isCurrentOperation(operation)) return;
    const index = state.routines.findIndex((routine) => routine.id === response.routine.id);
    if (index >= 0) state.routines[index] = response.routine;
    else state.routines.unshift(response.routine);
    view.renderRoutines(state.routines, response.routine.id);
    if (response.routine.spotify_url && state.playlistSource?.playlists?.some((playlist) => playlist.spotify_url === response.routine.spotify_url)) {
      state.playlistSource = localPlaylistSource(state.playlistSource, state.playlistSource.playlists, response.routine.spotify_url);
    }
    view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
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
      { label: 'Undo', onClick: () => { if (isCurrentOperation(operation)) void undoRoutineSave({ previous: previousSnapshot, saved: response.routine }); } },
    );
  } catch (error) {
    if (isCurrentOperation(operation)) showError(error, 'Couldn’t save focus setup');
  } finally {
    if (isCurrentOperation(operation)) elements.saveRoutines.forEach((button) => { button.disabled = false; });
  }
}

async function deleteRoutine() {
  const operation = currentOperation();
  if (!isCurrentOperation(operation)) return;
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
  if (!accepted || !isCurrentOperation(operation)) return;
  const routineIndex = state.routines.findIndex((item) => item.id === routine.id);
  const previousPlaylistSource = state.playlistSource;
  state.routines = state.routines.filter((item) => item.id !== routine.id);
  view.renderRoutines(state.routines);
  view.fillRoutine(null);
  view.renderPlaylists(null, state.playlistEntitlements);
  state.playlistSource = null;
  renderSuggestions();
  view.setSettingsStatus('Routine deleted.');
  if (window.APStudyUndo?.stage) {
    window.APStudyUndo.stage({
      message: `“${routine.name}” deleted.`,
      commit: ({ reason }) => {
        // Staged deletion must still commit when pagehide flushes the undo window.
        if (reason === 'pagehide') return focusApi.deleteRoutine(routine.id, { keepalive: true });
        if (isCurrentOperation(operation)) return focusApi.deleteRoutine(routine.id, { signal: operation.signal });
      },
      restore: () => {
        if (!isCurrentOperation(operation)) return;
        if (!state.routines.some((item) => item.id === routine.id)) {
          state.routines.splice(Math.min(Math.max(0, routineIndex), state.routines.length), 0, routine);
        }
        if (!state.playlistSource) state.playlistSource = previousPlaylistSource;
        view.renderRoutines(state.routines, routine.id);
        view.fillRoutine(routine);
        view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
        renderSuggestions();
        view.setSettingsStatus('Routine restored.', 'success');
      },
      errorTitle: 'Couldn’t delete focus setup',
    });
    return;
  }
  try {
    await focusApi.deleteRoutine(routine.id, { signal: operation.signal });
  } catch (error) {
    if (!isCurrentOperation(operation)) return;
    if (!state.routines.some((item) => item.id === routine.id)) {
      state.routines.splice(Math.min(Math.max(0, routineIndex), state.routines.length), 0, routine);
    }
    if (!state.playlistSource) state.playlistSource = previousPlaylistSource;
    view.renderRoutines(state.routines, routine.id);
    view.fillRoutine(routine);
    view.renderPlaylists(state.playlistSource, state.playlistEntitlements);
    renderSuggestions();
    showError(error, 'Couldn’t delete focus setup');
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
  elements.form.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-focus-preset]');
    if (!preset) return;
    const focusMinutes = Number(preset.dataset.focus);
    const breakMinutes = Number(preset.dataset.break) || 0;
    const cycles = Number(preset.dataset.cycles) || 1;
    const recentMatch = state.recentSelections.find((selection) => (
      Number(selection.focus_minutes) === focusMinutes
      && (Number(selection.break_minutes) || 0) === breakMinutes
      && (Number(selection.cycles) || 1) === cycles
    ));
    applySelection(recentMatch || {
      focus_minutes: focusMinutes,
      break_minutes: breakMinutes,
      long_break_minutes: breakMinutes,
      cycles,
    });
  }, listenerOptions);
  elements.suggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-break-suggestion]');
    if (!button) return;
    elements.breakMinutes.value = button.dataset.breakSuggestion;
    if (!Number(elements.longBreakMinutes.value)) elements.longBreakMinutes.value = button.dataset.breakSuggestion;
  }, listenerOptions);
  elements.layoutInputs.forEach((input) => input.addEventListener('change', () => {
    if (input.checked) view.setMusicLayout(input.value);
  }, listenerOptions));
  elements.playlistUrlInput?.addEventListener('input', () => view.syncPlaylistControls({ clearStatus: true }), listenerOptions);
  elements.playlistToggle?.addEventListener('click', () => {
    const open = elements.playlistToggle.getAttribute('aria-expanded') !== 'true';
    view.setPlaylistEditor(open);
    if (!open) view.setPlaylistStatus();
  }, listenerOptions);
  elements.playlistApply?.addEventListener('click', () => { void applyPlaylist(); }, listenerOptions);
  elements.playlistRemove?.addEventListener('click', (event) => {
    if (document.body.classList.contains('focus-session-active')) return;
    const coarsePointer = window.matchMedia?.('(hover: none), (pointer: coarse)').matches;
    if (event.detail > 0 && coarsePointer && !elements.playerFrame?.classList.contains('is-actions-visible')) {
      elements.playerFrame?.classList.add('is-actions-visible');
      return;
    }
    void removePlaylist();
  }, listenerOptions);
  elements.playerHost?.addEventListener('click', (event) => {
    if (!event.target.closest('[data-focus-player-load]')) return;
    const operation = currentOperation();
    if (isCurrentOperation(operation)) void view.activateMusic({ autoplay: false, signal: operation.signal });
  }, listenerOptions);
  elements.playlistUrlInput?.addEventListener('keydown', (event) => {
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
    else void loadState();
  }, listenerOptions);
  window.addEventListener('online', () => {
    if (state.session && remainingSeconds(state.session) <= 0) void advancePhase();
  }, listenerOptions);
  window.APStudyPageLifecycle?.register?.({
    pause: pauseRuntime,
    resume: resumeRuntime,
    dispose: () => {
      pauseRuntime();
      state.disposed = true;
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
