import { spotifyEmbedUrl } from './data.js';
import { formatTimer, nextPhaseLabel, phaseLabel, progressRatio } from './timer.js';

const LAYOUTS = new Set(['bottom-compact', 'bottom-large', 'right-compact', 'right-large', 'floating']);
const VOLUME_KEY = 'apstudy.focus.spotify.volume.v1';
const LAYOUT_KEY = 'apstudy.focus.spotify.layout.v1';

function text(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function choice(label, dataset = {}, title = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'focus-choice';
  button.textContent = label;
  if (title) button.title = title;
  Object.entries(dataset).forEach(([key, value]) => { button.dataset[key] = String(value); });
  return button;
}

function formatCompletedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function readPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (_error) {
    // Preferences are an enhancement; private browsing should not block Focus Mode.
  }
}

function completionMessage(phase) {
  if (phase === 'break') return ['Break time!', 'Quick rest!'][Math.floor(Math.random() * 2)];
  return Math.random() < 0.0005
    ? "You're focused!"
    : ['Complete!', 'You made it!'][Math.floor(Math.random() * 2)];
}

export function createFocusView() {
  let historyFadeTimer = null;
  let countdownTimer = null;
  let eggOpenTimer = null;
  const elements = {
    loading: document.querySelector('[data-focus-loading]'),
    setup: document.querySelector('[data-focus-setup]'),
    session: document.querySelector('[data-focus-session]'),
    utilities: document.querySelector('[data-focus-utilities]'),
    options: document.querySelector('[data-focus-options]') || document.querySelector('.focus-options'),
    optionsSummary: document.querySelector('#focus-options-summary')
      || document.querySelector('.focus-options > summary'),
    optionsClose: document.querySelector('[data-focus-options-close]'),
    optionsBackdrop: document.querySelector('[data-focus-options-backdrop]'),
    sessionOptions: document.querySelector('[data-focus-session-options]'),
    form: document.querySelector('[data-focus-form]'),
    formStatus: document.querySelector('[data-focus-form-status]'),
    suggestions: document.querySelector('[data-focus-break-suggestions]'),
    recentSelections: document.querySelector('[data-focus-recent-selections]'),
    recentList: document.querySelector('[data-focus-recent-list]'),
    routineSelect: document.getElementById('focus-routine-select'),
    routineName: document.getElementById('focus-routine-name'),
    focusMinutes: document.getElementById('focus-minutes'),
    breakMinutes: document.getElementById('focus-break-minutes'),
    longBreakMinutes: document.getElementById('focus-long-break-minutes'),
    cycles: document.getElementById('focus-cycles'),
    spotifyUrl: document.getElementById('focus-spotify-url'),
    spotifyPanelUrl: document.querySelector('[data-focus-spotify-panel-url]'),
    spotifyVolume: document.getElementById('focus-volume'),
    spotifyVolumeValue: document.querySelector('[data-focus-volume-value]'),
    spotifyLayout: document.getElementById('focus-spotify-layout'),
    applyPlaylist: document.querySelector('[data-focus-apply-playlist]'),
    settingsStatus: document.querySelector('[data-focus-settings-status]'),
    spotifyPanelApply: document.querySelector('[data-focus-spotify-panel-apply]'),
    spotifyPanelAction: document.querySelector('[data-focus-spotify-panel-action]'),
    spotifyPanelStatus: document.querySelector('[data-focus-spotify-panel-status]'),
    autoStart: document.getElementById('focus-auto-start'),
    saveRoutine: document.querySelector('[data-focus-save-routine]'),
    deleteRoutine: document.querySelector('[data-focus-delete-routine]'),
    time: document.querySelector('[data-focus-time]'),
    progress: document.querySelector('[data-focus-progress]'),
    phaseLabel: document.querySelector('[data-focus-phase-label]'),
    cycleLabel: document.querySelector('[data-focus-cycle-label]'),
    cycleDots: document.querySelector('[data-focus-cycle-dots]'),
    toggle: document.querySelector('[data-focus-toggle]'),
    toggleLabel: document.querySelector('[data-focus-toggle-label]'),
    completePhase: document.querySelector('[data-focus-complete-phase]'),
    end: document.querySelector('[data-focus-end]'),
    nextPhase: document.querySelector('[data-focus-next-phase]'),
    history: document.querySelector('[data-focus-history]'),
    historyRegion: document.querySelector('.focus-history-region'),
    historyEmpty: document.querySelector('[data-focus-history-empty]'),
    spotifyEmbed: document.querySelector('[data-focus-spotify-embed]'),
    spotifyEmpty: document.querySelector('[data-focus-spotify-empty]'),
    spotifyLabel: document.querySelector('[data-focus-spotify-label]'),
    spotifyRegion: document.querySelector('.focus-spotify-region'),
    openSpotify: document.querySelector('[data-focus-open-spotify]'),
    countdown: document.querySelector('[data-focus-countdown]'),
    egg: document.querySelector('[data-focus-egg]'),
    eggResult: document.querySelector('[data-focus-egg-result]'),
    announcer: document.querySelector('[data-focus-announcer]'),
  };
  document.body.classList.toggle('focus-has-settings-popover', Boolean(elements.options?.querySelector('.focus-options-popover')));

  function showMode(active) {
    window.clearTimeout(historyFadeTimer);
    if (elements.historyRegion) elements.historyRegion.hidden = false;
    document.body.classList.toggle('focus-session-active', active);
    if (elements.loading) elements.loading.hidden = true;
    if (elements.setup) elements.setup.hidden = active;
    if (elements.session) elements.session.hidden = !active;
    if (elements.utilities) elements.utilities.hidden = false;
    syncOptionsState();
    if (active && elements.historyRegion) {
      historyFadeTimer = window.setTimeout(() => {
        if (document.body.classList.contains('focus-session-active')) elements.historyRegion.hidden = true;
      }, 200);
    }
  }

  function syncOptionsState() {
    const open = Boolean(elements.options?.open);
    document.body.classList.toggle('focus-settings-open', open);
    elements.setup?.classList.toggle('focus-setup-options-open', open);
    elements.optionsSummary?.setAttribute('aria-expanded', String(open));
    elements.sessionOptions?.setAttribute('aria-expanded', String(open));
  }

  function closeOptions() {
    if (!elements.options) return;
    elements.options.open = false;
    syncOptionsState();
  }

  function setFormStatus(message = '', tone = '') {
    text(elements.formStatus, message);
    if (tone) elements.formStatus?.setAttribute('data-tone', tone);
    else elements.formStatus?.removeAttribute('data-tone');
  }

  function setSettingsStatus(message = '', tone = '') {
    text(elements.settingsStatus, message);
    if (tone) elements.settingsStatus?.setAttribute('data-tone', tone);
    else elements.settingsStatus?.removeAttribute('data-tone');
  }

  function setSpotifyPanelStatus(message = '', tone = '') {
    text(elements.spotifyPanelStatus, message);
    if (tone) elements.spotifyPanelStatus?.setAttribute('data-tone', tone);
    else elements.spotifyPanelStatus?.removeAttribute('data-tone');
  }

  function setBusy(busy) {
    elements.form?.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  function setSessionBusy(busy, activeButton = null) {
    [elements.toggle, elements.completePhase, elements.end].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      button.removeAttribute('aria-busy');
    });
    if (busy && activeButton) activeButton.setAttribute('aria-busy', 'true');
  }

  function renderRoutines(routines, selectedId = '') {
    if (!elements.routineSelect) return;
    const current = String(selectedId || elements.routineSelect.value || '');
    elements.routineSelect.replaceChildren(option('', 'Custom routine'));
    routines.forEach((routine) => {
      elements.routineSelect.appendChild(option(routine.id, routine.name));
    });
    elements.routineSelect.value = routines.some((routine) => String(routine.id) === current) ? current : '';
    if (elements.deleteRoutine) elements.deleteRoutine.hidden = !elements.routineSelect.value;
  }

  function fillRoutine(routine) {
    if (!elements.routineName) return;
    elements.routineName.value = routine?.name || '';
    elements.focusMinutes.value = routine?.focus_minutes ?? 25;
    elements.breakMinutes.value = routine?.break_minutes ?? 0;
    elements.longBreakMinutes.value = routine?.long_break_minutes ?? routine?.break_minutes ?? 0;
    elements.cycles.value = routine?.cycles ?? 1;
    elements.spotifyUrl.value = routine?.spotify_url || '';
    if (elements.deleteRoutine) elements.deleteRoutine.hidden = !routine;
  }

  function renderSuggestions(values) {
    if (!elements.suggestions) return;
    elements.suggestions.replaceChildren();
    values.forEach((minutes) => {
      elements.suggestions.appendChild(choice(
        `${minutes} min`,
        { breakSuggestion: minutes },
        `Use a ${minutes}-minute break suggestion for this focus block.`,
      ));
    });
  }

  function renderRecent(selections) {
    if (!elements.recentList) return;
    elements.recentList.replaceChildren();
    selections.forEach((selection, index) => {
      const breakLabel = Number(selection.break_minutes) ? ` / ${selection.break_minutes}` : '';
      elements.recentList.appendChild(choice(
        `${selection.focus_minutes}${breakLabel} min`,
        { recentSelection: index },
        'Reuse this recent focus and break combination.',
      ));
    });
    if (elements.recentSelections) elements.recentSelections.hidden = selections.length === 0;
  }

  function renderCycles(session) {
    if (!elements.cycleDots) return;
    elements.cycleDots.replaceChildren();
    const completed = Number(session.completed_focus_cycles || 0);
    const current = Number(session.cycle_number || completed + 1);
    for (let cycle = 1; cycle <= Number(session.total_cycles || 1); cycle += 1) {
      const dot = document.createElement('span');
      dot.className = 'focus-cycle-dot';
      if (cycle <= completed) dot.classList.add('is-complete');
      else if (cycle === current) dot.classList.add('is-current');
      elements.cycleDots.appendChild(dot);
    }
  }

  function renderSession(session) {
    text(elements.cycleLabel, `${session.phase === 'break' ? 'Break after focus' : 'Focus'} ${session.cycle_number} of ${session.total_cycles}`);
    text(elements.phaseLabel, phaseLabel(session));
    text(elements.toggleLabel, session.state === 'paused' ? (session.phase === 'break' ? 'Start break' : 'Resume') : 'Pause');
    text(elements.nextPhase, nextPhaseLabel(session));
    elements.session?.setAttribute('data-phase', session.phase);
    if (elements.egg) elements.egg.setAttribute('aria-label', session.phase === 'break' ? 'Break egg' : 'Focus egg');
    renderCycles(session);
  }

  function renderEggProgress(session, remaining) {
    if (!elements.egg) return;
    const state = elements.egg.dataset.eggState;
    if (state === 'opening' || state === 'open') return;
    const ratio = progressRatio(session, remaining);
    const level = ratio >= 0.88 ? 4 : ratio >= 0.62 ? 3 : ratio >= 0.36 ? 2 : ratio >= 0.14 ? 1 : 0;
    elements.egg.dataset.crackLevel = String(level);
    elements.egg.style.setProperty('--focus-egg-progress', String(ratio));
  }

  function renderTick(session, remaining) {
    text(elements.time, formatTimer(remaining));
    const ratio = progressRatio(session, remaining);
    if (elements.progress) {
      elements.progress.style.setProperty('--focus-progress', String(ratio));
      elements.progress.style.setProperty('--focus-progress-percent', `${ratio * 100}%`);
    }
    elements.time?.setAttribute('datetime', `PT${Math.max(0, remaining)}S`);
    renderEggProgress(session, remaining);
    document.title = `${formatTimer(remaining)} · ${session.phase === 'break' ? 'Break' : 'Focus'} - Nest`;
  }

  function renderHistory(history) {
    if (!elements.history) return;
    elements.history.replaceChildren();
    history.slice(0, 8).forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'focus-history-item';
      const copy = document.createElement('span');
      copy.className = 'focus-history-copy';
      const title = document.createElement('strong');
      title.textContent = `${Math.round(Number(entry.duration_seconds || 0) / 60)} min ${entry.phase}`;
      const routine = document.createElement('span');
      routine.textContent = entry.routine_name || `Cycle ${entry.cycle_number}`;
      copy.append(title, routine);
      const time = document.createElement('time');
      time.dateTime = entry.completed_at;
      time.textContent = formatCompletedAt(entry.completed_at);
      item.append(copy, time);
      elements.history.appendChild(item);
    });
    if (elements.historyEmpty) elements.historyEmpty.hidden = history.length > 0;
  }

  function renderSpotify(source) {
    if (!elements.spotifyRegion) return;
    const spotifyUrl = source?.spotify_url || '';
    const embedUrl = source?.spotify_embed_url || spotifyEmbedUrl(spotifyUrl);
    const active = document.body.classList.contains('focus-session-active');
    if (active && elements.spotifyUrl && spotifyUrl) elements.spotifyUrl.value = spotifyUrl;
    if (elements.spotifyPanelUrl) elements.spotifyPanelUrl.value = spotifyUrl;
    text(elements.spotifyPanelAction, embedUrl ? 'Change playlist' : 'Add playlist');
    if (elements.applyPlaylist) elements.applyPlaylist.hidden = !active;
    if (embedUrl && elements.spotifyEmbed) {
      if (elements.spotifyEmbed.dataset.src !== embedUrl) {
        elements.spotifyEmbed.src = embedUrl;
        elements.spotifyEmbed.dataset.src = embedUrl;
      }
      elements.spotifyEmbed.hidden = false;
      elements.spotifyRegion.hidden = false;
      if (elements.utilities) elements.utilities.hidden = false;
      if (elements.spotifyEmpty) elements.spotifyEmpty.hidden = true;
      if (elements.openSpotify) {
        elements.openSpotify.hidden = false;
        elements.openSpotify.href = spotifyUrl;
      }
      text(elements.spotifyLabel, source?.routine_name || source?.name || 'Saved focus playlist');
    } else {
      if (elements.spotifyEmbed) elements.spotifyEmbed.hidden = true;
      if (elements.spotifyEmpty) elements.spotifyEmpty.hidden = false;
      elements.spotifyRegion.hidden = false;
      if (elements.openSpotify) elements.openSpotify.hidden = true;
      text(elements.spotifyLabel, 'Your routine can keep one playlist close.');
      if (elements.utilities) elements.utilities.hidden = false;
    }
  }

  function setSpotifyVolume(value, persist = true) {
    const volume = Math.min(100, Math.max(0, Number(value) || 0));
    if (elements.spotifyVolume) elements.spotifyVolume.value = String(volume);
    text(elements.spotifyVolumeValue, `${volume}%`);
    document.body.style.setProperty('--focus-spotify-volume', String(volume / 100));
    if (persist) writePreference(VOLUME_KEY, volume);
  }

  function setSpotifyLayout(value, persist = true) {
    const layout = LAYOUTS.has(value) ? value : 'bottom-compact';
    if (elements.spotifyLayout) elements.spotifyLayout.value = layout;
    document.body.dataset.spotifyLayout = layout;
    if (persist) writePreference(LAYOUT_KEY, layout);
  }

  function loadPreferences() {
    setSpotifyVolume(readPreference(VOLUME_KEY, '100'), false);
    setSpotifyLayout(readPreference(LAYOUT_KEY, 'bottom-compact'), false);
  }

  function startCountdown() {
    if (!elements.countdown || !elements.egg) return Promise.resolve();
    window.clearTimeout(countdownTimer);
    window.clearTimeout(eggOpenTimer);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const interval = reducedMotion ? 120 : 380;
    let number = 3;
    elements.egg.dataset.eggState = 'countdown';
    elements.countdown.hidden = false;
    return new Promise((resolve) => {
      const showNumber = () => {
        if (number === 0) {
          elements.countdown.hidden = true;
          elements.countdown.textContent = '';
          elements.egg.dataset.eggState = 'closed';
          resolve();
          return;
        }
        text(elements.countdown, number);
        elements.countdown.classList.remove('is-counting');
        void elements.countdown.offsetWidth;
        elements.countdown.classList.add('is-counting');
        number -= 1;
        countdownTimer = window.setTimeout(showNumber, interval);
      };
      showNumber();
    });
  }

  function resetEgg() {
    window.clearTimeout(eggOpenTimer);
    if (!elements.egg) return;
    elements.egg.dataset.eggState = 'closed';
    elements.egg.dataset.crackLevel = '0';
    elements.egg.style.setProperty('--focus-egg-progress', '0');
    elements.egg.setAttribute('aria-label', 'Focus egg');
    text(elements.eggResult, 'Complete!');
  }

  function playEggOpening(phase) {
    if (!elements.egg) return Promise.resolve();
    window.clearTimeout(countdownTimer);
    window.clearTimeout(eggOpenTimer);
    elements.egg.dataset.crackLevel = '4';
    elements.egg.dataset.eggState = 'opening';
    text(elements.eggResult, completionMessage(phase));
    elements.egg.setAttribute('aria-label', `${phase === 'break' ? 'Break' : 'Focus'} complete`);
    requestAnimationFrame(() => {
      if (elements.egg) elements.egg.dataset.eggState = 'open';
    });
    return new Promise((resolve) => {
      eggOpenTimer = window.setTimeout(resolve, 1700);
    });
  }

  function announce(message) {
    text(elements.announcer, '');
    window.setTimeout(() => text(elements.announcer, message), 20);
  }

  loadPreferences();

  return {
    elements,
    showMode,
    syncOptionsState,
    closeOptions,
    setFormStatus,
    setSettingsStatus,
    setSpotifyPanelStatus,
    setBusy,
    setSessionBusy,
    renderRoutines,
    fillRoutine,
    renderSuggestions,
    renderRecent,
    renderSession,
    renderTick,
    renderHistory,
    renderSpotify,
    setSpotifyVolume,
    setSpotifyLayout,
    startCountdown,
    playEggOpening,
    resetEgg,
    announce,
  };
}
