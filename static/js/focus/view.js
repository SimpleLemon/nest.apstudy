import {
  buildFocusTimeSuggestions,
  focusTimeSelectionKey,
  normalizePlaylist,
  playlistEmbedUrl,
  playlistProvider,
} from './data.js';
import { createRoutinePicker } from './routine-picker.js';
import {
  eggCrackLevel,
  formatTimer,
  nestStage,
  nextPhaseLabel,
  phaseLabel,
  progressRatio,
} from './timer.js';

function text(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

function choice(label, dataset = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'focus-choice';
  button.textContent = label;
  Object.entries(dataset).forEach(([key, value]) => { button.dataset[key] = String(value); });
  return button;
}

function lineIcon(paths, className = 'focus-inline-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  paths.forEach((value) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    svg.appendChild(path);
  });
  return svg;
}

function providerName(value) {
  if (value === 'spotify') return 'spotify';
  if (value === 'youtube_music') return 'youtube_music';
  return 'youtube';
}

function providerSvg(value) {
  const provider = providerName(value);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (provider === 'spotify') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    svg.appendChild(circle);
    ['M7 9.2c3.7-1 7.5-.7 10.6.9', 'M7.7 12.4c3-.8 6.4-.5 9 .7', 'M8.5 15.4c2.4-.6 5-.4 7.2.6'].forEach((value) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', value);
      svg.appendChild(path);
    });
  } else if (provider === 'youtube_music') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    svg.appendChild(circle);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm10 8.5 6 3.5-6 3.5v-7Z');
    svg.appendChild(path);
  } else {
    ['M21 8.1a3 3 0 0 0-2.1-2.1C17 5.5 12 5.5 12 5.5S7 5.5 5.1 6A3 3 0 0 0 3 8.1 31 31 0 0 0 2.5 12 31 31 0 0 0 3 15.9 3 3 0 0 0 5.1 18c1.9.5 6.9.5 6.9.5s5 0 6.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-3.9 31 31 0 0 0-.5-3.9Z', 'm10 9 5 3-5 3V9Z'].forEach((value) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', value);
      svg.appendChild(path);
    });
  }
  return svg;
}

function providerIcon(value) {
  const mark = document.createElement('span');
  const provider = providerName(value);
  mark.className = `focus-playlist-card-provider is-${provider}`;
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(providerSvg(provider));
  return mark;
}

function playlistCard(playlist) {
  const item = document.createElement('li');
  item.className = 'focus-playlist-item';
  item.dataset.focusPlaylistItem = playlist.spotify_url;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'focus-playlist-card-remove';
  remove.dataset.focusPlaylistRemove = playlist.spotify_url;
  remove.setAttribute('aria-label', `Remove ${playlist.title || 'playlist'}`);
  remove.appendChild(lineIcon(['M4.5 7h15M9 7V4.5h6V7M7 7l.7 12h8.6L17 7M10 10.5v5M14 10.5v5']));
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
    fallback.appendChild(lineIcon([
      'M9 17.5a2.5 2.5 0 1 1-2.5-2.5H9v2.5ZM9 15V6l9-2v9.5',
      'M18 13.5a2.5 2.5 0 1 1-2.5-2.5H18v2.5Z',
    ]));
    button.appendChild(fallback);
  }
  const copy = document.createElement('span');
  copy.className = 'focus-playlist-card-copy';
  const title = document.createElement('strong');
  title.textContent = playlist.title || 'Spotify playlist';
  const creator = document.createElement('span');
  creator.textContent = playlist.creator || 'Spotify';
  copy.append(title, creator);
  const providerName = playlist.provider || playlistProvider(playlist.spotify_url);
  button.append(copy, providerIcon(providerName));
  item.append(remove, button);
  return item;
}

function playerPlaceholder(source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'focus-player-placeholder';

  if (source.thumbnail_url) {
    const image = document.createElement('img');
    image.className = 'focus-player-placeholder-artwork';
    image.src = source.thumbnail_url;
    image.alt = '';
    image.loading = 'lazy';
    wrapper.appendChild(image);
  }

  const copy = document.createElement('span');
  copy.className = 'focus-player-placeholder-copy';
  const title = document.createElement('strong');
  title.textContent = source.title || 'Playlist ready';
  const description = document.createElement('span');
  description.textContent = source.creator
    ? `${source.creator} · Player loads when focus starts.`
    : 'Player loads when focus starts.';
  copy.append(title, description);

  const load = document.createElement('button');
  load.type = 'button';
  load.className = 'focus-button focus-button-secondary focus-player-load';
  load.dataset.focusPlayerLoad = 'true';
  load.textContent = 'Load player';
  wrapper.append(copy, load);
  return wrapper;
}

export function completionMessage(phase, randomValue = Math.random()) {
  const focusMessages = ['Focus complete.', 'One block done.', 'You made progress.'];
  const breakMessages = ['Break complete.', 'Ready when you are.', 'Back to focus.'];
  const messages = phase === 'break' ? breakMessages : focusMessages;
  const index = Math.min(messages.length - 1, Math.floor(Math.max(0, randomValue) * messages.length));
  return messages[index];
}

export function createFocusView({ savePlayerPreferences, notify, onRoutineSelect, onRoutineCreate } = {}) {
  let countdownTimer = null;
  let eggOpenTimer = null;
  let countdownResolve = null;
  let eggOpenResolve = null;
  let playlistBusy = false;
  let playlistEntitlements = null;
  let musicRuntime = null;
  let musicRuntimePromise = null;
  let deferredSpotifySource = null;
  let playerLoadingTimer = null;
  let playerAssistTimer = null;
  let pendingPlayerPreferences = { layout: 'beside' };
  let pendingHistory = [];
  let historyModulePromise = null;
  let historyPreparePromise = null;
  let historyRendered = false;
  let settingsPanel = null;
  let settingsPanelPromise = null;
  let lazyStylesPromise = null;
  let disposed = false;
  const elements = {
    loading: document.querySelector('[data-focus-loading]'),
    setup: document.querySelector('[data-focus-setup]'),
    session: document.querySelector('[data-focus-session]'),
    utilities: document.querySelector('[data-focus-utilities]'),
    options: document.querySelector('[data-focus-options]'),
    optionsOpen: [...document.querySelectorAll('[data-focus-options-open], [data-focus-session-options]')],
    optionsClose: document.querySelector('[data-focus-options-close]'),
    activeSummary: document.querySelector('[data-focus-active-summary]'),
    activeSummaryCopy: document.querySelector('[data-focus-active-summary-copy]'),
    inactiveSettings: document.querySelector('[data-focus-inactive-settings]'),
    form: document.querySelector('[data-focus-form]'),
    startButton: document.querySelector('[data-focus-form] button[type="submit"]'),
    settingsStatuses: [...document.querySelectorAll('[data-focus-settings-status]')],
    suggestions: document.querySelector('[data-focus-break-suggestions]'),
    suggestionBlock: document.querySelector('[data-focus-suggestion-block]'),
    recentList: document.querySelector('[data-focus-recent-list]'),
    routinePicker: document.querySelector('[data-focus-routine-picker]'),
    routineCombobox: document.querySelector('[data-focus-routine-combobox]'),
    routineSelect: document.getElementById('focus-routine-select'),
    routineCreatePanel: document.querySelector('[data-focus-routine-create]'),
    routineExistingActions: document.querySelector('[data-focus-routine-existing-actions]'),
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
    activeSpotifyUrl: document.querySelector('[data-focus-active-playlist-url]'),
    playlistComposer: document.querySelector('[data-focus-playlist-composer]'),
    playlistToggle: document.querySelector('[data-focus-playlist-toggle]'),
    playlistEditor: document.querySelector('[data-focus-playlist-editor]'),
    layoutInputs: [...document.querySelectorAll('input[name="spotify_layout"]')],
    playlistApply: document.querySelector('[data-focus-playlist-apply]'),
    playlistSubmitLogo: document.querySelector('[data-focus-playlist-submit-logo]'),
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
    playerFrame: document.querySelector('[data-focus-player-frame]'),
    spotifyEmbed: document.querySelector('[data-focus-spotify-embed]'),
    floatingControls: document.querySelector('[data-focus-floating-controls]'),
    floatingHandle: document.querySelector('[data-focus-floating-handle]'),
    floatingSize: document.querySelector('[data-focus-floating-size]'),
    panelResize: document.querySelector('[data-focus-panel-resize]'),
    countdown: document.querySelector('[data-focus-countdown]'),
    egg: document.querySelector('[data-focus-egg]'),
    eggResult: document.querySelector('[data-focus-egg-result]'),
    announcer: document.querySelector('[data-focus-announcer]'),
  };
  const setupAnchor = document.createComment('focus-setup-mount');
  const sessionAnchor = document.createComment('focus-session-mount');
  elements.setup?.before(setupAnchor);
  elements.session?.before(sessionAnchor);

  function ensureLazyStyles() {
    const existing = document.querySelector('link[data-focus-lazy-styles]');
    if (existing?.dataset.loaded === 'true' || existing?.sheet) return Promise.resolve();
    if (lazyStylesPromise) return lazyStylesPromise;
    const link = existing || document.createElement('link');
    if (!existing) {
      link.rel = 'stylesheet';
      link.href = '/static/css/focus-lazy.css';
      link.dataset.focusLazyStyles = 'true';
    }
    lazyStylesPromise = new Promise((resolve) => {
      link.addEventListener('load', () => {
        link.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      link.addEventListener('error', resolve, { once: true });
    });
    if (!existing) document.head.appendChild(link);
    return lazyStylesPromise;
  }

  async function ensureMusicRuntime() {
    if (disposed) return null;
    if (musicRuntime) return musicRuntime;
    musicRuntimePromise ||= import('./music-runtime.js');
    const { createMusicRuntime } = await musicRuntimePromise;
    if (disposed) return null;
    musicRuntime ||= createMusicRuntime({ elements, savePreferences: savePlayerPreferences });
    musicRuntime.applyPreferences(pendingPlayerPreferences);
    return musicRuntime;
  }

  function clearPlayerFeedback() {
    window.clearTimeout(playerLoadingTimer);
    window.clearTimeout(playerAssistTimer);
    playerLoadingTimer = null;
    playerAssistTimer = null;
    elements.spotifyEmbed?.classList.remove('is-player-loading');
    document.querySelector('[data-focus-player-assist]')?.remove();
  }

  function renderPlayerPlaceholder() {
    if (!elements.spotifyEmbed || !deferredSpotifySource) return;
    clearPlayerFeedback();
    elements.spotifyEmbed.hidden = false;
    elements.spotifyEmbed.dataset.playerState = 'deferred';
    elements.spotifyEmbed.replaceChildren(playerPlaceholder(deferredSpotifySource));
  }

  async function activateSpotify({ autoplay = false } = {}) {
    if (disposed || !deferredSpotifySource || !elements.spotifyEmbed) return false;
    const source = deferredSpotifySource;
    clearPlayerFeedback();
    elements.spotifyEmbed.dataset.playerState = 'loading';
    playerLoadingTimer = window.setTimeout(() => {
      if (elements.spotifyEmbed?.dataset.playerState === 'loading') {
        elements.spotifyEmbed.classList.add('is-player-loading');
      }
    }, 100);
    try {
      const runtime = await ensureMusicRuntime();
      if (!runtime) return false;
      const loaded = await runtime.activate(source, { autoplay });
      if (source !== deferredSpotifySource) return false;
      window.clearTimeout(playerLoadingTimer);
      elements.spotifyEmbed.classList.remove('is-player-loading');
      elements.spotifyEmbed.dataset.playerState = loaded ? 'ready' : 'deferred';
      if (!loaded) renderPlayerPlaceholder();
      if (loaded && autoplay) {
        playerAssistTimer = window.setTimeout(() => {
          if (!elements.spotifyEmbed || elements.spotifyEmbed.dataset.playerState !== 'ready') return;
          const assist = document.createElement('p');
          assist.className = 'focus-player-assist';
          assist.dataset.focusPlayerAssist = 'true';
          assist.textContent = 'If music does not start, press play in the player.';
          elements.spotifyEmbed.insertAdjacentElement('afterend', assist);
          window.setTimeout(() => assist.remove(), 6000);
        }, 1000);
      }
      return loaded;
    } catch (_error) {
      if (source === deferredSpotifySource) renderPlayerPlaceholder();
      notify?.({
        message: 'The player could not load. Your timer is still running.',
        title: 'Couldn’t load playlist player',
        type: 'error',
      });
      return false;
    }
  }

  function setSettingsContext(active, session = null) {
    if (elements.activeSummary) elements.activeSummary.hidden = !active;
    if (elements.inactiveSettings) elements.inactiveSettings.hidden = active;
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
    if (active) {
      elements.setup?.remove();
      if (elements.session && !elements.session.isConnected) sessionAnchor.after(elements.session);
    } else {
      elements.session?.remove();
      if (elements.setup && !elements.setup.isConnected) setupAnchor.after(elements.setup);
      setBusy(false);
    }
    if (elements.setup) elements.setup.hidden = active;
    if (elements.session) elements.session.hidden = !active;
    if (elements.utilities) elements.utilities.hidden = false;
    setSettingsContext(active, session);
  }

  function syncOptionsState() {
    if (settingsPanel) return settingsPanel.sync();
    const open = Boolean(elements.options?.open);
    document.body.classList.toggle('focus-settings-open', open);
    elements.optionsOpen.forEach((trigger) => trigger.setAttribute('aria-expanded', String(open)));
  }

  async function ensureSettingsPanel() {
    if (disposed) return null;
    if (settingsPanel) return settingsPanel;
    void ensureLazyStyles();
    settingsPanelPromise ||= import('./settings-panel.js');
    const { createSettingsPanel } = await settingsPanelPromise;
    if (disposed) return null;
    settingsPanel ||= createSettingsPanel({
      dialog: elements.options,
      openButtons: elements.optionsOpen,
      closeButton: elements.optionsClose,
    });
    return settingsPanel;
  }

  async function openOptions(trigger) {
    const loadingTimer = window.setTimeout(() => trigger?.setAttribute('aria-busy', 'true'), 100);
    try {
      const panel = await ensureSettingsPanel();
      panel?.open(trigger);
    } finally {
      window.clearTimeout(loadingTimer);
      trigger?.removeAttribute('aria-busy');
    }
  }

  function closeOptions() {
    settingsPanel?.close();
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
    const submit = elements.startButton
      || elements.form?.querySelector('button[type="submit"]');
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

  const routinePickerControl = createRoutinePicker({
    root: elements.routineCombobox,
    input: elements.routineSelect,
    createPanel: elements.routineCreatePanel,
    existingActions: elements.routineExistingActions,
    nameInput: elements.routineName,
    onSelect: (routineId) => onRoutineSelect?.(routineId),
    onCreateNew: () => onRoutineCreate?.(),
  });

  function syncRoutineMode(routine) {
    const hasSelection = Boolean(routine?.id);
    const creating = routinePickerControl?.isCreateMode();
    elements.saveRoutineLabels.forEach((label) => text(label, hasSelection ? 'Save changes' : 'Save setup'));
    if (elements.routineCreatePanel) elements.routineCreatePanel.hidden = hasSelection || !creating;
    if (elements.routineExistingActions) elements.routineExistingActions.hidden = !hasSelection;
  }

  function renderRoutines(routines, selectedId = '') {
    routinePickerControl?.setRoutines(routines, selectedId);
    const selected = routines.find((routine) => String(routine.id) === String(selectedId || elements.routineSelect?.value || '')) || null;
    syncRoutineMode(selected);
  }

  function fillRoutine(routine, { updatePicker = true } = {}) {
    if (!elements.routineName) return;
    elements.routineName.value = routine?.name || 'Default';
    elements.focusMinutes.value = routine?.focus_minutes ?? 25;
    elements.breakMinutes.value = routine?.break_minutes ?? 0;
    elements.longBreakMinutes.value = routine?.long_break_minutes ?? routine?.break_minutes ?? 0;
    elements.cycles.value = routine?.cycles ?? 1;
    if (elements.activeSpotifyUrl) elements.activeSpotifyUrl.value = routine?.spotify_url || '';
    if (elements.spotifyUrl) elements.spotifyUrl.value = '';
    if (updatePicker) {
      if (routine?.id) routinePickerControl?.setValue(routine.id);
      else routinePickerControl?.enterCreateMode({ notify: false });
    }
    syncRoutineMode(routine);
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

  function renderRecent(selections = []) {
    if (!elements.recentList) return;
    const items = buildFocusTimeSuggestions(selections);
    const currentKey = focusTimeSelectionKey({
      focus_minutes: Number(elements.focusMinutes?.value) || 0,
      break_minutes: Number(elements.breakMinutes?.value) || 0,
      cycles: Number(elements.cycles?.value) || 1,
    });
    const buttons = items.map((selection) => {
      const breakLabel = selection.break_minutes ? ` / ${selection.break_minutes}` : '';
      const label = selection.fromRecent
        ? `${selection.focus_minutes}${breakLabel} min`
        : `${selection.focus_minutes} min`;
      const button = choice(label, {
        focusPreset: '',
        focus: selection.focus_minutes,
        break: selection.break_minutes,
        cycles: selection.cycles,
      });
      button.setAttribute(
        'aria-label',
        selection.break_minutes
          ? `Set ${selection.focus_minutes} / ${selection.break_minutes} minutes`
          : `Set ${selection.focus_minutes} minutes`,
      );
      button.setAttribute('aria-pressed', String(focusTimeSelectionKey(selection) === currentKey));
      return button;
    });
    elements.recentList.replaceChildren(...buttons);
  }

  function syncTimeSuggestionPressed() {
    if (!elements.recentList) return;
    const currentKey = focusTimeSelectionKey({
      focus_minutes: Number(elements.focusMinutes?.value) || 0,
      break_minutes: Number(elements.breakMinutes?.value) || 0,
      cycles: Number(elements.cycles?.value) || 1,
    });
    elements.recentList.querySelectorAll('[data-focus-preset]').forEach((button) => {
      const key = focusTimeSelectionKey({
        focus_minutes: Number(button.dataset.focus) || 0,
        break_minutes: Number(button.dataset.break) || 0,
        cycles: Number(button.dataset.cycles) || 1,
      });
      button.setAttribute('aria-pressed', String(key === currentKey));
    });
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
    document.title = `${formatTimer(remaining)} · ${session.phase === 'break' ? 'Break' : 'Focus'}`;
  }

  function prepareHistory() {
    if (disposed || !elements.history || !pendingHistory.length) return Promise.resolve();
    if (historyPreparePromise) return historyPreparePromise;
    historyPreparePromise = (async () => {
      await ensureLazyStyles();
      historyModulePromise ||= import('./history-view.js');
      const { renderHistory: renderHistoryList } = await historyModulePromise;
      if (!disposed && pendingHistory.length) {
        renderHistoryList(elements.history, pendingHistory);
        historyRendered = true;
      }
    })().finally(() => {
      historyPreparePromise = null;
    });
    return historyPreparePromise;
  }

  async function mountHistory() {
    if (disposed || !elements.history || !elements.historyRegion?.open || !pendingHistory.length || historyRendered) return;
    elements.historyRegion.classList.add('is-lazy-loading');
    await prepareHistory();
    elements.historyRegion?.classList.remove('is-lazy-loading');
  }

  function renderHistory(history) {
    pendingHistory = history;
    historyRendered = false;
    if (elements.historyRegion) {
      elements.historyRegion.hidden = history.length === 0;
      if (!history.length) elements.historyRegion.open = false;
    }
    if (!history.length) elements.history?.replaceChildren();
    else void prepareHistory();
  }

  function syncPlaylistControls({ clearStatus = false, entitlements = playlistEntitlements, playlists = [] } = {}) {
    const raw = String(elements.spotifyUrl?.value || '').trim();
    const normalized = normalizePlaylist(raw);
    const invalid = Boolean(raw && !normalized);
    const list = Array.isArray(playlists) ? playlists : [];
    const atLimit = entitlements?.limit != null && Number(entitlements.usage) >= Number(entitlements.limit);
    const isNew = Boolean(normalized && !list.some((playlist) => playlist.spotify_url === normalized));
    const blocked = atLimit && isNew;
    elements.spotifyUrl?.setAttribute('aria-invalid', String(invalid));
    if (elements.playlistApply) {
      elements.playlistApply.hidden = !normalized;
      elements.playlistApply.disabled = playlistBusy || !normalized || blocked;
    }
    if (elements.playlistToggle) {
      elements.playlistToggle.disabled = atLimit;
      if (atLimit) {
        elements.playlistToggle.setAttribute(
          'aria-label',
          `Playlist limit reached (${entitlements.usage} of ${entitlements.limit})`,
        );
      } else {
        elements.playlistToggle.setAttribute('aria-label', 'Add playlist');
      }
    }
    if (elements.playlistSubmitLogo) {
      elements.playlistSubmitLogo.replaceChildren();
      if (normalized) elements.playlistSubmitLogo.appendChild(providerSvg(playlistProvider(normalized)));
      elements.playlistSubmitLogo.dataset.provider = normalized ? playlistProvider(normalized) : '';
    }
    if (clearStatus) setPlaylistStatus();
    if (blocked) {
      setPlaylistStatus(`Your plan includes ${entitlements.limit} saved playlists.`, 'info');
    }
    return normalized;
  }

  function setPlaylistEditor(open, { force = false } = {}) {
    if (!elements.playlistEditor || !elements.playlistToggle || !elements.playlistComposer) return;
    if (!open && playlistBusy && !force) return;
    if (elements.spotifyUrl) elements.spotifyUrl.value = '';
    elements.spotifyUrl?.setAttribute('aria-invalid', 'false');
    elements.playlistEditor.hidden = !open;
    elements.playlistToggle.setAttribute('aria-expanded', String(open));
    elements.playlistToggle.setAttribute('aria-hidden', String(open));
    elements.playlistToggle.tabIndex = open ? -1 : 0;
    elements.playlistComposer.classList.toggle('is-open', open);
    if (!open) setPlaylistStatus();
    syncPlaylistControls();
    if (open) window.setTimeout(() => elements.spotifyUrl?.focus(), 0);
  }

  function renderSpotify(source, entitlements = playlistEntitlements) {
    playlistEntitlements = entitlements || playlistEntitlements;
    const spotifyUrl = source?.spotify_url || '';
    const embedUrl = source?.embed_url || source?.spotify_embed_url || playlistEmbedUrl(spotifyUrl);
    const playlists = Array.isArray(source?.playlists) ? source.playlists : (spotifyUrl ? [{
      spotify_url: spotifyUrl,
      spotify_embed_url: embedUrl,
      embed_url: embedUrl,
      provider: playlistProvider(spotifyUrl),
      title: 'Playlist',
      creator: 'Music',
    }] : []);
    const activePlaylist = playlists.find((playlist) => playlist.spotify_url === spotifyUrl) || {};
    const preservePlayer = deferredSpotifySource?.spotify_url === spotifyUrl
      && ['loading', 'ready'].includes(elements.spotifyEmbed?.dataset.playerState)
      && Boolean(elements.spotifyEmbed?.querySelector('iframe, .focus-spotify-controller'));
    if (elements.activeSpotifyUrl) elements.activeSpotifyUrl.value = spotifyUrl;
    if (elements.playlistData) {
      elements.playlistData.value = JSON.stringify(playlists.map((playlist) => playlist.spotify_url));
    }
    if (elements.playlistList) {
      const inactivePlaylists = playlists
        .filter((playlist) => playlist.spotify_url !== spotifyUrl)
        .map(playlistCard);
      elements.playlistList.replaceChildren(...inactivePlaylists);
      elements.playlistList.hidden = playlists.length <= 1;
      document.dispatchEvent(new CustomEvent('focus:playlist-list-rendered', {
        detail: { hasItems: inactivePlaylists.length > 0 },
      }));
    }
    text(elements.playlistAction, 'Add playlist');
    if (elements.playlistRemove) {
      elements.playlistRemove.hidden = !embedUrl;
      elements.playlistRemove.setAttribute('aria-label', `Remove ${activePlaylist.title || 'active playlist'}`);
    }
    elements.playerFrame?.classList.remove('is-actions-visible');
    if (embedUrl && elements.spotifyEmbed) {
      void ensureLazyStyles();
      void ensureMusicRuntime();
      deferredSpotifySource = {
        ...source,
        ...activePlaylist,
        spotify_url: spotifyUrl,
        spotify_embed_url: embedUrl,
        embed_url: embedUrl,
      };
      elements.spotifyEmbed.hidden = false;
      elements.spotifyEmbed.dataset.playlistProvider = source?.playlist_provider || playlistProvider(spotifyUrl);
      if (!preservePlayer) {
        musicRuntime?.clear();
        void activateSpotify({ autoplay: false });
      }
    } else {
      deferredSpotifySource = null;
      elements.spotifyEmbed?.removeAttribute('data-playlist-provider');
      elements.spotifyEmbed?.removeAttribute('data-player-state');
      clearPlayerFeedback();
      musicRuntime?.clear();
      elements.spotifyEmbed?.replaceChildren();
      if (elements.spotifyEmbed) elements.spotifyEmbed.hidden = true;
    }
    setPlaylistEditor(false, { force: true });
    syncPlaylistControls({ entitlements: playlistEntitlements, playlists });
  }

  function setSpotifyLayout(value, persist = true) {
    pendingPlayerPreferences = { ...pendingPlayerPreferences, layout: value };
    document.body.dataset.spotifyLayout = value;
    elements.layoutInputs.forEach((input) => { input.checked = input.value === value; });
    if (musicRuntime) return musicRuntime.setLayout(value, persist);
    if (persist) return savePlayerPreferences?.(pendingPlayerPreferences);
    return Promise.resolve(pendingPlayerPreferences);
  }

  function applyPlayerPreferences(value) {
    pendingPlayerPreferences = { ...pendingPlayerPreferences, ...(value || {}) };
    const layout = pendingPlayerPreferences.layout || 'beside';
    document.body.dataset.spotifyLayout = layout;
    elements.layoutInputs.forEach((input) => { input.checked = input.value === layout; });
    musicRuntime?.applyPreferences(pendingPlayerPreferences);
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
    syncTimeSuggestionPressed,
    renderSession,
    renderTick,
    renderHistory,
    renderSpotify,
    setPlaylistEditor,
    syncPlaylistControls,
    setSpotifyLayout,
    applyPlayerPreferences,
    activateSpotify,
    mountHistory,
    startCountdown,
    playEggOpening,
    resetEgg,
    pauseSpotify: () => musicRuntime?.pause(),
    resumeSpotify: () => {
      if (musicRuntime) musicRuntime.resume();
      else void activateSpotify({ autoplay: true });
    },
    clearSpotify: () => {
      clearPlayerFeedback();
      deferredSpotifySource = null;
      elements.spotifyEmbed?.removeAttribute('data-player-state');
      elements.spotifyEmbed?.removeAttribute('data-playlist-provider');
      musicRuntime?.clear();
    },
    dispose: () => {
      disposed = true;
      window.clearTimeout(countdownTimer);
      window.clearTimeout(eggOpenTimer);
      countdownResolve?.();
      eggOpenResolve?.();
      countdownResolve = null;
      eggOpenResolve = null;
      clearPlayerFeedback();
      musicRuntime?.dispose();
      musicRuntime = null;
      musicRuntimePromise = null;
      settingsPanel?.dispose();
      settingsPanel = null;
      settingsPanelPromise = null;
    },
    announce,
  };
}
