import { normalizeSpotifyPlaylist, spotifyEmbedUrl } from './data.js';
import {
  eggCrackLevel,
  formatTimer,
  nestStage,
  nextPhaseLabel,
  phaseLabel,
  progressRatio,
} from './timer.js';

const LAYOUT_KEY = 'apstudy.focus.spotify.layout.v1';
const LAYOUT_MAP = new Map([
  ['below', 'below'],
  ['bottom-compact', 'below'],
  ['bottom-large', 'below'],
  ['beside', 'beside'],
  ['right-compact', 'beside'],
  ['right-large', 'beside'],
  ['floating', 'floating'],
]);

function text(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function choice(label, dataset = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'focus-choice';
  button.textContent = label;
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
    // Browser preferences are optional; storage restrictions must not block the timer.
  }
}

export function completionMessage(phase, randomValue = Math.random()) {
  const focusMessages = ['Focus complete.', 'One block done.', 'You made progress.'];
  const breakMessages = ['Break complete.', 'Ready when you are.', 'Back to focus.'];
  const messages = phase === 'break' ? breakMessages : focusMessages;
  const index = Math.min(messages.length - 1, Math.floor(Math.max(0, randomValue) * messages.length));
  return messages[index];
}

export function createFocusView() {
  let countdownTimer = null;
  let eggOpenTimer = null;
  let lastSettingsTrigger = null;
  let playlistBusy = false;
  const elements = {
    loading: document.querySelector('[data-focus-loading]'),
    setup: document.querySelector('[data-focus-setup]'),
    session: document.querySelector('[data-focus-session]'),
    utilities: document.querySelector('[data-focus-utilities]'),
    options: document.querySelector('[data-focus-options]'),
    optionsOpen: [...document.querySelectorAll('[data-focus-options-open], [data-focus-session-options]')],
    optionsClose: document.querySelector('[data-focus-options-close]'),
    optionsDescription: document.querySelector('[data-focus-options-description]'),
    activeSummary: document.querySelector('[data-focus-active-summary]'),
    activeSummaryCopy: document.querySelector('[data-focus-active-summary-copy]'),
    inactiveSettings: document.querySelector('[data-focus-inactive-settings]'),
    form: document.querySelector('[data-focus-form]'),
    formStatus: document.querySelector('[data-focus-form-status]'),
    settingsStatus: document.querySelector('[data-focus-settings-status]'),
    suggestions: document.querySelector('[data-focus-break-suggestions]'),
    suggestionBlock: document.querySelector('[data-focus-suggestion-block]'),
    recentSelections: document.querySelector('[data-focus-recent-selections]'),
    recentList: document.querySelector('[data-focus-recent-list]'),
    routinePicker: document.querySelector('[data-focus-routine-picker]'),
    routineSelect: document.getElementById('focus-routine-select'),
    routineName: document.getElementById('focus-routine-name'),
    focusMinutes: document.getElementById('focus-minutes'),
    breakMinutes: document.getElementById('focus-break-minutes'),
    longBreakMinutes: document.getElementById('focus-long-break-minutes'),
    cycles: document.getElementById('focus-cycles'),
    breakField: document.querySelector('[data-focus-break-field]'),
    longBreakField: document.querySelector('[data-focus-long-break-field]'),
    autoStartRow: document.querySelector('[data-focus-auto-start-row]'),
    autoStart: document.getElementById('focus-auto-start'),
    saveRoutine: document.querySelector('[data-focus-save-routine]'),
    deleteRoutine: document.querySelector('[data-focus-delete-routine]'),
    spotifyUrl: document.getElementById('focus-spotify-url'),
    layoutInputs: [...document.querySelectorAll('input[name="spotify_layout"]')],
    playlistApply: document.querySelector('[data-focus-playlist-apply]'),
    playlistAction: document.querySelector('[data-focus-playlist-action]'),
    playlistRemove: document.querySelector('[data-focus-playlist-remove]'),
    playlistStatus: document.querySelector('[data-focus-playlist-status]'),
    time: document.querySelector('[data-focus-time]'),
    progress: document.querySelector('[data-focus-progress]'),
    phaseLabel: document.querySelector('[data-focus-phase-label]'),
    cycleLabel: document.querySelector('[data-focus-cycle-label]'),
    cycleDots: document.querySelector('[data-focus-cycle-dots]'),
    toggle: document.querySelector('[data-focus-toggle]'),
    toggleLabel: document.querySelector('[data-focus-toggle-label]'),
    completePhase: document.querySelector('[data-focus-complete-phase]'),
    completePhaseLabel: document.querySelector('[data-focus-complete-phase-label]'),
    end: document.querySelector('[data-focus-end]'),
    nextPhase: document.querySelector('[data-focus-next-phase]'),
    history: document.querySelector('[data-focus-history]'),
    historyRegion: document.querySelector('[data-focus-history-region]'),
    spotifyEmbed: document.querySelector('[data-focus-spotify-embed]'),
    spotifyLabel: document.querySelector('[data-focus-spotify-label]'),
    openSpotify: document.querySelector('[data-focus-open-spotify]'),
    countdown: document.querySelector('[data-focus-countdown]'),
    egg: document.querySelector('[data-focus-egg]'),
    eggResult: document.querySelector('[data-focus-egg-result]'),
    announcer: document.querySelector('[data-focus-announcer]'),
  };

  function setSettingsContext(active, session = null) {
    if (elements.activeSummary) elements.activeSummary.hidden = !active;
    if (elements.inactiveSettings) elements.inactiveSettings.hidden = active;
    text(elements.optionsDescription, active
      ? 'Review this session and place the Spotify player.'
      : 'Adjust the rhythm and player placement.');
    if (!active || !session) return;
    const focusMinutes = Math.round(Number(session.focus_seconds || 0) / 60);
    const breakMinutes = Math.round(Number(session.break_seconds || 0) / 60);
    const cycles = Number(session.total_cycles || 1);
    const parts = [`${focusMinutes} min focus`, `${cycles} ${cycles === 1 ? 'cycle' : 'cycles'}`];
    if (cycles > 1) parts.splice(1, 0, `${breakMinutes} min break`);
    text(elements.activeSummaryCopy, parts.join(' · '));
  }

  function showMode(active, session = null) {
    document.body.classList.toggle('focus-session-active', active);
    if (elements.loading) elements.loading.hidden = true;
    if (elements.setup) elements.setup.hidden = active;
    if (elements.session) elements.session.hidden = !active;
    if (elements.utilities) elements.utilities.hidden = false;
    setSettingsContext(active, session);
  }

  function syncOptionsState() {
    const open = Boolean(elements.options?.open);
    document.body.classList.toggle('focus-settings-open', open);
    elements.optionsOpen.forEach((trigger) => trigger.setAttribute('aria-expanded', String(open)));
  }

  function openOptions(trigger) {
    if (!elements.options || elements.options.open) return;
    lastSettingsTrigger = trigger || document.activeElement;
    if (typeof elements.options.showModal === 'function') elements.options.showModal();
    else elements.options.setAttribute('open', '');
    syncOptionsState();
  }

  function closeOptions() {
    if (!elements.options?.open) return;
    if (typeof elements.options.close === 'function') elements.options.close();
    else elements.options.removeAttribute('open');
    syncOptionsState();
    window.setTimeout(() => lastSettingsTrigger?.focus?.(), 0);
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

  function setPlaylistStatus(message = '', tone = '') {
    text(elements.playlistStatus, message);
    if (tone) elements.playlistStatus?.setAttribute('data-tone', tone);
    else elements.playlistStatus?.removeAttribute('data-tone');
  }

  function setBusy(busy) {
    const submit = elements.form?.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = busy;
      if (busy) submit.setAttribute('aria-busy', 'true');
      else submit.removeAttribute('aria-busy');
    }
  }

  function setSessionBusy(busy, activeButton = null) {
    [elements.toggle, elements.completePhase, elements.end].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      button.removeAttribute('aria-busy');
    });
    if (busy && activeButton) activeButton.setAttribute('aria-busy', 'true');
  }

  function setPlaylistBusy(busy) {
    playlistBusy = busy;
    [elements.playlistApply, elements.playlistRemove].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      if (busy) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });
    if (!busy) syncPlaylistControls();
  }

  function renderRoutines(routines, selectedId = '') {
    if (!elements.routineSelect) return;
    const current = String(selectedId || elements.routineSelect.value || '');
    elements.routineSelect.replaceChildren(option('', 'Custom timer'));
    routines.forEach((routine) => elements.routineSelect.appendChild(option(routine.id, routine.name)));
    elements.routineSelect.value = routines.some((routine) => String(routine.id) === current) ? current : '';
    if (elements.routinePicker) elements.routinePicker.hidden = routines.length === 0;
    const hasSelection = Boolean(elements.routineSelect.value);
    if (elements.deleteRoutine) elements.deleteRoutine.hidden = !hasSelection;
    text(elements.saveRoutine, hasSelection ? 'Update routine' : 'Save routine');
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
    text(elements.saveRoutine, routine ? 'Update routine' : 'Save routine');
    syncRhythmVisibility();
  }

  function syncRhythmVisibility() {
    const cycles = Math.max(1, Number(elements.cycles?.value || 1));
    if (elements.breakField) elements.breakField.hidden = cycles <= 1;
    if (elements.longBreakField) elements.longBreakField.hidden = cycles < 4;
    if (elements.autoStartRow) elements.autoStartRow.hidden = cycles <= 1;
    if (elements.suggestionBlock) {
      elements.suggestionBlock.hidden = cycles <= 1 || !elements.suggestions?.children.length;
    }
  }

  function renderSuggestions(values) {
    if (!elements.suggestions) return;
    elements.suggestions.replaceChildren();
    values.forEach((minutes) => {
      elements.suggestions.appendChild(choice(`${minutes} min`, { breakSuggestion: minutes }));
    });
    syncRhythmVisibility();
  }

  function renderRecent(selections) {
    if (!elements.recentList) return;
    elements.recentList.replaceChildren();
    selections.forEach((selection, index) => {
      const breakLabel = Number(selection.break_minutes) ? ` / ${selection.break_minutes}` : '';
      elements.recentList.appendChild(choice(
        `${selection.focus_minutes}${breakLabel} min`,
        { recentSelection: index },
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
    text(elements.completePhaseLabel, session.phase === 'break' ? 'Finish break' : 'Finish focus');
    text(elements.nextPhase, nextPhaseLabel(session));
    elements.session?.setAttribute('data-phase', session.phase);
    elements.egg?.setAttribute('aria-label', session.phase === 'break'
      ? 'An egg resting in a nest during the break'
      : 'An egg resting in a nest during focus');
    renderCycles(session);
    setSettingsContext(true, session);
  }

  function renderEggProgress(session, remaining) {
    if (!elements.egg) return;
    const state = elements.egg.dataset.eggState;
    if (state === 'opening' || state === 'open') return;
    const ratio = progressRatio(session, remaining);
    elements.egg.dataset.nestStage = String(nestStage(ratio));
    elements.egg.dataset.crackLevel = String(eggCrackLevel(ratio));
    elements.egg.style.setProperty('--focus-egg-progress', String(ratio));
  }

  function renderTick(session, remaining) {
    text(elements.time, formatTimer(remaining));
    const ratio = progressRatio(session, remaining);
    if (elements.progress) elements.progress.style.setProperty('--focus-progress', String(ratio));
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
    if (elements.historyRegion) {
      elements.historyRegion.hidden = history.length === 0;
      if (!history.length) elements.historyRegion.open = false;
    }
  }

  function syncPlaylistControls({ clearStatus = false } = {}) {
    const raw = String(elements.spotifyUrl?.value || '').trim();
    const normalized = normalizeSpotifyPlaylist(raw);
    const invalid = Boolean(raw && !normalized);
    elements.spotifyUrl?.setAttribute('aria-invalid', String(invalid));
    if (elements.playlistApply) elements.playlistApply.disabled = playlistBusy || !normalized;
    if (clearStatus) setPlaylistStatus(invalid ? 'Use an open.spotify.com playlist URL.' : '', invalid ? 'error' : '');
    return normalized;
  }

  function renderSpotify(source) {
    const spotifyUrl = source?.spotify_url || '';
    const embedUrl = source?.spotify_embed_url || spotifyEmbedUrl(spotifyUrl);
    if (elements.spotifyUrl) elements.spotifyUrl.value = spotifyUrl;
    text(elements.playlistAction, embedUrl ? 'Update playlist' : 'Add playlist');
    if (elements.playlistRemove) elements.playlistRemove.hidden = !embedUrl;
    if (embedUrl && elements.spotifyEmbed) {
      if (elements.spotifyEmbed.dataset.src !== embedUrl) {
        elements.spotifyEmbed.src = embedUrl;
        elements.spotifyEmbed.dataset.src = embedUrl;
      }
      elements.spotifyEmbed.hidden = false;
      if (elements.openSpotify) {
        elements.openSpotify.hidden = false;
        elements.openSpotify.href = spotifyUrl;
      }
      text(elements.spotifyLabel, source?.routine_name || source?.name || 'Playlist ready for this session.');
    } else {
      if (elements.spotifyEmbed) elements.spotifyEmbed.hidden = true;
      if (elements.openSpotify) elements.openSpotify.hidden = true;
      text(elements.spotifyLabel, 'Add an optional Spotify playlist.');
    }
    syncPlaylistControls();
  }

  function setSpotifyLayout(value, persist = true) {
    const layout = LAYOUT_MAP.get(value) || 'below';
    document.body.dataset.spotifyLayout = layout;
    elements.layoutInputs.forEach((input) => { input.checked = input.value === layout; });
    if (persist) writePreference(LAYOUT_KEY, layout);
    return layout;
  }

  function loadPreferences() {
    setSpotifyLayout(readPreference(LAYOUT_KEY, 'below'), false);
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
    elements.egg.dataset.nestStage = '0';
    elements.egg.style.setProperty('--focus-egg-progress', '0');
    elements.egg.setAttribute('aria-label', 'An egg resting in a nest');
    text(elements.eggResult, 'Focus complete.');
  }

  function playEggOpening(phase) {
    if (!elements.egg) return Promise.resolve();
    window.clearTimeout(countdownTimer);
    window.clearTimeout(eggOpenTimer);
    elements.egg.dataset.nestStage = '8';
    elements.egg.dataset.crackLevel = '3';
    elements.egg.dataset.eggState = 'opening';
    text(elements.eggResult, completionMessage(phase));
    elements.egg.setAttribute('aria-label', `${phase === 'break' ? 'Break' : 'Focus'} complete; an open book rises from the egg`);
    requestAnimationFrame(() => {
      if (elements.egg) elements.egg.dataset.eggState = 'open';
    });
    return new Promise((resolve) => {
      eggOpenTimer = window.setTimeout(resolve, 3000);
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
    openOptions,
    closeOptions,
    setFormStatus,
    setSettingsStatus,
    setPlaylistStatus,
    setBusy,
    setSessionBusy,
    setPlaylistBusy,
    renderRoutines,
    fillRoutine,
    syncRhythmVisibility,
    renderSuggestions,
    renderRecent,
    renderSession,
    renderTick,
    renderHistory,
    renderSpotify,
    syncPlaylistControls,
    setSpotifyLayout,
    startCountdown,
    playEggOpening,
    resetEgg,
    announce,
  };
}
