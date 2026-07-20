import { focusApi, formPayload, routineFromState, suggestedBreaks } from './data.js';
import { clockedSession, remainingSeconds } from './timer.js';
import { createFocusView } from './view.js';

const view = createFocusView();
const { elements } = view;
const state = {
  routines: [],
  history: [],
  recentSelections: [],
  session: null,
  timerId: null,
  advanceInFlight: false,
  sessionActionInFlight: false,
  shellActive: false,
  disposed: false,
};

function toast(message, type = 'success', title = '') {
  window.APStudyToast?.show?.({ message, type, duration: 7000, ...(title ? { title } : {}) });
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
  return routineFromState(state, elements.routineSelect.value);
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
}

function renderActiveSession() {
  if (!state.session) return;
  view.renderSession(state.session);
  view.renderSpotify(state.session);
  tick();
}

function renderCurrentMode() {
  const active = Boolean(state.session && ['running', 'paused'].includes(state.session.state));
  view.showMode(active);
  view.renderHistory(state.history);
  if (active) {
    focusSidebar(true);
    renderActiveSession();
  } else {
    stopTimer();
    document.title = 'Focus Mode - APStudy Nest';
    focusSidebar(false);
    renderSetup();
    view.renderSpotify(selectedRoutine());
  }
}

async function loadState({ preserveStatus = false } = {}) {
  try {
    const payload = await focusApi.state();
    state.routines = payload.routines || [];
    state.history = payload.history || [];
    state.recentSelections = payload.recent_selections || [];
    state.session = clockedSession(payload.active_session);
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
  if (!state.session || state.session.state !== 'running' || document.hidden || state.disposed) return;
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
    const payload = await focusApi.updateSession(state.session.id, 'advance');
    const next = clockedSession(payload.session);
    if (!payload.active) {
      state.session = null;
      announcePhaseTransition(previousPhase, null);
      await loadState({ preserveStatus: true });
      return;
    }
    state.session = next;
    view.renderSession(next);
    view.renderTick(next, remainingSeconds(next));
    announcePhaseTransition(previousPhase, next);
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
  try {
    const payload = await focusApi.updateSession(state.session.id, action);
    state.session = payload.active ? clockedSession(payload.session) : null;
    if (!state.session) {
      await loadState({ preserveStatus: true });
      if (action === 'complete_phase') announcePhaseTransition(previousPhase, null);
      return;
    }
    renderActiveSession();
    if (action === 'complete_phase') {
      announcePhaseTransition(previousPhase, state.session);
      await refreshHistory();
    } else {
      const message = action === 'pause' ? 'Timer paused.' : 'Timer resumed.';
      announceSessionChange(message, action === 'pause' ? 'Timer paused' : 'Timer resumed');
    }
  } catch (error) {
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
    await focusApi.updateSession(state.session.id, 'exit');
    state.session = null;
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

function applySelection(selection) {
  elements.focusMinutes.value = selection.focus_minutes;
  elements.breakMinutes.value = selection.break_minutes || 0;
  elements.longBreakMinutes.value = selection.long_break_minutes || selection.break_minutes || 0;
  elements.cycles.value = selection.cycles || 1;
  if (selection.spotify_url) elements.spotifyUrl.value = selection.spotify_url;
  elements.routineSelect.value = '';
  elements.deleteRoutine.hidden = true;
  renderSuggestions();
}

async function startSession(event) {
  event.preventDefault();
  const payload = formPayload(elements.form);
  view.setBusy(true);
  view.setFormStatus('Starting your focus session…');
  try {
    const response = await focusApi.start(payload);
    state.session = clockedSession(response.session);
    view.setFormStatus();
    renderCurrentMode();
    announceSessionChange('Focus Mode started. Nonurgent Nest notifications are muted.', 'Focus Mode started');
  } catch (error) {
    view.setFormStatus(error.message, 'error');
  } finally {
    view.setBusy(false);
  }
}

async function saveRoutine() {
  const payload = formPayload(elements.form);
  if (!elements.routineName.value.trim()) {
    view.setFormStatus('Enter a routine name before saving.', 'error');
    elements.routineName.focus();
    return;
  }
  elements.saveRoutine.disabled = true;
  try {
    const selectedId = elements.routineSelect.value;
    const response = await focusApi.saveRoutine(payload, selectedId);
    const index = state.routines.findIndex((routine) => routine.id === response.routine.id);
    if (index >= 0) state.routines[index] = response.routine;
    else state.routines.unshift(response.routine);
    view.renderRoutines(state.routines, response.routine.id);
    view.renderSpotify(response.routine);
    view.setFormStatus('Routine saved to your account.', 'success');
  } catch (error) {
    view.setFormStatus(error.message, 'error');
  } finally {
    elements.saveRoutine.disabled = false;
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
    renderSuggestions();
    view.setFormStatus('Routine deleted.');
  } catch (error) {
    view.setFormStatus(error.message, 'error');
  }
}

function bindEvents() {
  elements.form.addEventListener('submit', startSession);
  elements.options?.addEventListener('toggle', () => view.syncOptionsState());
  elements.focusMinutes.addEventListener('input', renderSuggestions);
  elements.routineSelect.addEventListener('change', () => {
    const routine = selectedRoutine();
    view.fillRoutine(routine);
    view.renderSpotify(routine);
    renderSuggestions();
  });
  document.querySelectorAll('[data-focus-preset]').forEach((button) => {
    button.addEventListener('click', () => applySelection({
      focus_minutes: Number(button.dataset.focus),
      break_minutes: Number(button.dataset.break),
      long_break_minutes: Number(button.dataset.break),
      cycles: Number(button.dataset.cycles),
    }));
  });
  elements.suggestions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-break-suggestion]');
    if (!button) return;
    elements.breakMinutes.value = button.dataset.breakSuggestion;
    if (!Number(elements.longBreakMinutes.value)) elements.longBreakMinutes.value = button.dataset.breakSuggestion;
  });
  elements.recentList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-recent-selection]');
    if (!button) return;
    applySelection(state.recentSelections[Number(button.dataset.recentSelection)]);
  });
  elements.saveRoutine.addEventListener('click', saveRoutine);
  elements.deleteRoutine.addEventListener('click', deleteRoutine);
  elements.toggle.addEventListener('click', () => updateSession(state.session?.state === 'paused' ? 'resume' : 'pause'));
  elements.completePhase.addEventListener('click', () => updateSession('complete_phase'));
  elements.end.addEventListener('click', () => endSession());
  document.addEventListener('apstudy-sidebar-state-change', (event) => {
    if (state.session && event.detail?.collapsed === false) queueMicrotask(hideSidebarForFocus);
  });
  document.addEventListener('apstudy-mobile-sidebar-toggle', () => {
    if (state.session) queueMicrotask(hideSidebarForFocus);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimer();
    else void loadState({ preserveStatus: true });
  });
  window.addEventListener('online', () => {
    if (state.session && remainingSeconds(state.session) <= 0) void advancePhase();
  });
  window.APStudyPageLifecycle?.register?.({
    pause: stopTimer,
    resume: tick,
    dispose: () => { state.disposed = true; stopTimer(); },
  });
}

bindEvents();
void loadState();
