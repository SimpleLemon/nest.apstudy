import { normalizeSpotifyPlaylist, spotifyEmbedUrl } from './data.js';
import {
  eggCrackLevel,
  formatTimer,
  nestStage,
  nextPhaseLabel,
  phaseLabel,
  progressRatio,
} from './timer.js';
import { createSpotifyPlayer } from './spotify-player.js';
import { createSpotifyLayout } from './spotify-layout.js';

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

function playlistCard(playlist) {
  const item = document.createElement('li');
  item.className = 'focus-playlist-item';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'focus-playlist-card';
  button.dataset.spotifyPlaylist = playlist.spotify_url;
  button.setAttribute('aria-label', `Open ${playlist.title || 'Spotify playlist'} by ${playlist.creator || 'Spotify'}`);
  if (playlist.thumbnail_url) {
    const image = document.createElement('img');
    image.className = 'focus-playlist-artwork';
    image.src = playlist.thumbnail_url;
    image.alt = '';
    image.loading = 'lazy';
    button.appendChild(image);
  } else {
    const fallback = document.createElement('span');
    fallback.className = 'focus-playlist-artwork focus-playlist-artwork-fallback';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'queue_music';
    fallback.appendChild(icon);
    button.appendChild(fallback);
  }
  const copy = document.createElement('span');
  copy.className = 'focus-playlist-card-copy';
  const title = document.createElement('strong');
  title.textContent = playlist.title || 'Spotify playlist';
  const creator = document.createElement('span');
  creator.textContent = playlist.creator || 'Spotify';
  copy.append(title, creator);
  button.appendChild(copy);
  item.appendChild(button);
  return item;
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

export function completionMessage(phase, randomValue = Math.random()) {
  const focusMessages = ['Focus complete.', 'One block done.', 'You made progress.'];
  const breakMessages = ['Break complete.', 'Ready when you are.', 'Back to focus.'];
  const messages = phase === 'break' ? breakMessages : focusMessages;
  const index = Math.min(messages.length - 1, Math.floor(Math.max(0, randomValue) * messages.length));
  return messages[index];
}

export function createFocusView({ savePlayerPreferences } = {}) {
  let countdownTimer = null;
  let eggOpenTimer = null;
  let countdownResolve = null;
  let eggOpenResolve = null;
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
    settingsStatuses: [...document.querySelectorAll('[data-focus-settings-status]')],
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
    saveRoutines: [...document.querySelectorAll('[data-focus-save-routine]')],
    saveRoutineLabels: [...document.querySelectorAll('[data-focus-save-routine-label]')],
    deleteRoutine: document.querySelector('[data-focus-delete-routine]'),
    spotifyUrl: document.getElementById('focus-spotify-url'),
    playlistToggle: document.querySelector('[data-focus-playlist-toggle]'),
    playlistEditor: document.querySelector('[data-focus-playlist-editor]'),
    layoutInputs: [...document.querySelectorAll('input[name="spotify_layout"]')],
    playlistApply: document.querySelector('[data-focus-playlist-apply]'),
    playlistAction: document.querySelector('[data-focus-playlist-action]'),
    playlistRemove: document.querySelector('[data-focus-playlist-remove]'),
    playlistStatus: document.querySelector('[data-focus-playlist-status]'),
    playlistData: document.querySelector('[data-focus-playlist-data]'),
    playlistList: document.querySelector('[data-focus-playlist-list]'),
    time: document.querySelector('[data-focus-time]'),
    progress: document.querySelector('[data-focus-progress]'),
    phaseLabel: document.querySelector('[data-focus-phase-label]'),
    cycleLabel: document.querySelector('[data-focus-cycle-label]'),
    cycleStatus: document.querySelector('[data-focus-cycle-status]'),
    cycleDots: document.querySelector('[data-focus-cycle-dots]'),
    toggle: document.querySelector('[data-focus-toggle]'),
    toggleLabel: document.querySelector('[data-focus-toggle-label]'),
    completePhase: document.querySelector('[data-focus-complete-phase]'),
    completePhaseLabel: document.querySelector('[data-focus-complete-phase-label]'),
    end: document.querySelector('[data-focus-end]'),
    exitLabel: document.querySelector('[data-focus-exit-label]'),
    nextPhase: document.querySelector('[data-focus-next-phase]'),
    history: document.querySelector('[data-focus-history]'),
    historyRegion: document.querySelector('[data-focus-history-region]'),
    spotifyEmbed: document.querySelector('[data-focus-spotify-embed]'),
    floatingControls: document.querySelector('[data-focus-floating-controls]'),
    floatingHandle: document.querySelector('[data-focus-floating-handle]'),
    floatingSize: document.querySelector('[data-focus-floating-size]'),
    countdown: document.querySelector('[data-focus-countdown]'),
    egg: document.querySelector('[data-focus-egg]'),
    eggResult: document.querySelector('[data-focus-egg-result]'),
    announcer: document.querySelector('[data-focus-announcer]'),
  };
  const spotifyPlayer = createSpotifyPlayer(elements.spotifyEmbed);
  const spotifyLayout = createSpotifyLayout({ elements, savePreferences: savePlayerPreferences });

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
    elements.settingsStatuses.forEach((status) => {
      text(status, message);
      if (tone) status.setAttribute('data-tone', tone);
      else status.removeAttribute('data-tone');
    });
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
    elements.routineSelect.replaceChildren(option('', routines.length ? 'New setup' : 'Default'));
    routines.forEach((routine) => elements.routineSelect.appendChild(option(routine.id, routine.name)));
    elements.routineSelect.value = routines.some((routine) => String(routine.id) === current) ? current : '';
    const hasSelection = Boolean(elements.routineSelect.value);
    if (elements.deleteRoutine) elements.deleteRoutine.hidden = !hasSelection;
    elements.saveRoutineLabels.forEach((label) => text(label, hasSelection ? 'Save changes' : 'Save setup'));
  }

  function fillRoutine(routine) {
    if (!elements.routineName) return;
    elements.routineName.value = routine?.name || 'Default';
    elements.focusMinutes.value = routine?.focus_minutes ?? 25;
    elements.breakMinutes.value = routine?.break_minutes ?? 0;
    elements.longBreakMinutes.value = routine?.long_break_minutes ?? routine?.break_minutes ?? 0;
    elements.cycles.value = routine?.cycles ?? 1;
    elements.spotifyUrl.value = routine?.spotify_url || '';
    if (elements.deleteRoutine) elements.deleteRoutine.hidden = !routine;
    elements.saveRoutineLabels.forEach((label) => text(label, routine ? 'Save changes' : 'Save setup'));
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
    const totalCycles = Number(session.total_cycles || 1);
    if (elements.cycleStatus) elements.cycleStatus.hidden = totalCycles <= 1;
    if (totalCycles <= 1) return;
    const completed = Number(session.completed_focus_cycles || 0);
    const current = Number(session.cycle_number || completed + 1);
    for (let cycle = 1; cycle <= totalCycles; cycle += 1) {
      const dot = document.createElement('span');
      dot.className = 'focus-cycle-dot';
      if (cycle <= completed) dot.classList.add('is-complete');
      else if (cycle === current) dot.classList.add('is-current');
      elements.cycleDots.appendChild(dot);
    }
  }

  function renderSession(session) {
    const completed = session.state === 'completed';
    text(elements.cycleLabel, `${session.phase === 'break' ? 'Break after focus' : 'Focus'} ${session.cycle_number} of ${session.total_cycles}`);
    text(elements.phaseLabel, completed ? `${session.phase === 'break' ? 'Break' : 'Focus'} complete` : phaseLabel(session));
    text(elements.toggleLabel, session.state === 'paused' ? (session.phase === 'break' ? 'Start break' : 'Resume') : 'Pause');
    text(elements.completePhaseLabel, session.phase === 'break' ? 'Finish break' : 'Finish focus');
    text(elements.nextPhase, completed ? '' : nextPhaseLabel(session));
    text(elements.exitLabel, completed ? 'Exit focus' : 'Exit');
    elements.session?.setAttribute('data-phase', session.phase);
    elements.session?.setAttribute('data-session-state', session.state);
    if (elements.toggle) elements.toggle.hidden = completed;
    if (elements.completePhase) elements.completePhase.hidden = completed;
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

  function setPlaylistEditor(open) {
    if (!elements.playlistEditor || !elements.playlistToggle) return;
    elements.playlistEditor.hidden = !open;
    elements.playlistToggle.setAttribute('aria-expanded', String(open));
    elements.playlistToggle.classList.toggle('is-open', open);
    if (open) window.setTimeout(() => elements.spotifyUrl?.focus(), 0);
  }

  function renderSpotify(source) {
    const spotifyUrl = source?.spotify_url || '';
    const embedUrl = source?.spotify_embed_url || spotifyEmbedUrl(spotifyUrl);
    const playlists = Array.isArray(source?.playlists) ? source.playlists : (spotifyUrl ? [{
      spotify_url: spotifyUrl,
      spotify_embed_url: embedUrl,
      title: 'Spotify playlist',
      creator: 'Spotify',
    }] : []);
    if (elements.spotifyUrl) elements.spotifyUrl.value = spotifyUrl;
    if (elements.playlistData) {
      elements.playlistData.value = JSON.stringify(playlists.map((playlist) => playlist.spotify_url));
    }
    if (elements.playlistList) {
      elements.playlistList.replaceChildren(...playlists
        .filter((playlist) => playlist.spotify_url !== spotifyUrl)
        .map(playlistCard));
      elements.playlistList.hidden = playlists.length <= 1;
    }
    text(elements.playlistAction, 'Add playlist');
    if (elements.playlistRemove) elements.playlistRemove.hidden = !embedUrl;
    if (embedUrl && elements.spotifyEmbed) {
      elements.spotifyEmbed.hidden = false;
      void spotifyPlayer.load(spotifyUrl, embedUrl);
    } else {
      spotifyPlayer.clear();
    }
    setPlaylistEditor(false);
    syncPlaylistControls();
  }

  function setSpotifyLayout(value, persist = true) {
    return spotifyLayout.setLayout(value, persist);
  }

  function applyPlayerPreferences(value) {
    spotifyLayout.applyPreferences(value);
  }

  function startCountdown() {
    if (!elements.countdown || !elements.egg) return Promise.resolve();
    window.clearTimeout(countdownTimer);
    window.clearTimeout(eggOpenTimer);
    countdownResolve?.();
    eggOpenResolve?.();
    countdownResolve = null;
    eggOpenResolve = null;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const interval = reducedMotion ? 120 : 380;
    let number = 3;
    elements.egg.dataset.eggState = 'countdown';
    elements.session?.setAttribute('data-countdown-active', 'true');
    elements.countdown.hidden = false;
    return new Promise((resolve) => {
      countdownResolve = resolve;
      const showNumber = () => {
        if (number === 0) {
          elements.countdown.hidden = true;
          elements.countdown.textContent = '';
          elements.egg.dataset.eggState = 'closed';
          elements.session?.removeAttribute('data-countdown-active');
          countdownResolve = null;
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
    eggOpenResolve?.();
    eggOpenResolve = null;
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
    countdownResolve?.();
    eggOpenResolve?.();
    countdownResolve = null;
    eggOpenResolve = null;
    elements.session?.removeAttribute('data-countdown-active');
    elements.egg.dataset.nestStage = '8';
    elements.egg.dataset.crackLevel = '3';
    elements.egg.dataset.eggState = 'opening';
    text(elements.eggResult, completionMessage(phase));
    elements.egg.setAttribute('aria-label', `${phase === 'break' ? 'Break' : 'Focus'} complete; an open book rises from the egg`);
    requestAnimationFrame(() => {
      if (elements.egg) elements.egg.dataset.eggState = 'open';
    });
    return new Promise((resolve) => {
      eggOpenResolve = resolve;
      eggOpenTimer = window.setTimeout(() => {
        eggOpenResolve = null;
        resolve();
      }, 3000);
    });
  }

  function announce(message) {
    text(elements.announcer, '');
    window.setTimeout(() => text(elements.announcer, message), 20);
  }

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
    setPlaylistEditor,
    syncPlaylistControls,
    setSpotifyLayout,
    applyPlayerPreferences,
    startCountdown,
    playEggOpening,
    resetEgg,
    pauseSpotify: () => spotifyPlayer.pause(),
    resumeSpotify: () => spotifyPlayer.resume(),
    dispose: () => {
      window.clearTimeout(countdownTimer);
      window.clearTimeout(eggOpenTimer);
      countdownResolve?.();
      eggOpenResolve?.();
      countdownResolve = null;
      eggOpenResolve = null;
      spotifyLayout.dispose();
      spotifyPlayer.dispose();
    },
    announce,
  };
}
