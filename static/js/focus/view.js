import { formatTimer, nextPhaseLabel, phaseLabel, progressRatio } from './timer.js';

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

export function createFocusView() {
  let utilityFadeTimer = null;
  let historyFadeTimer = null;
  const elements = {
    loading: document.querySelector('[data-focus-loading]'),
    setup: document.querySelector('[data-focus-setup]'),
    session: document.querySelector('[data-focus-session]'),
    utilities: document.querySelector('[data-focus-utilities]'),
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
    announcer: document.querySelector('[data-focus-announcer]'),
  };

  function showMode(active) {
    window.clearTimeout(utilityFadeTimer);
    window.clearTimeout(historyFadeTimer);
    if (!active) elements.historyRegion.hidden = false;
    document.body.classList.toggle('focus-session-active', active);
    elements.loading.hidden = true;
    elements.setup.hidden = active;
    elements.session.hidden = !active;
    elements.utilities.hidden = false;
    if (active) {
      historyFadeTimer = window.setTimeout(() => {
        if (document.body.classList.contains('focus-session-active')) elements.historyRegion.hidden = true;
      }, 200);
    }
  }

  function setFormStatus(message = '', tone = '') {
    text(elements.formStatus, message);
    if (tone) elements.formStatus.dataset.tone = tone;
    else elements.formStatus.removeAttribute('data-tone');
  }

  function setBusy(busy) {
    elements.form.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  function setSessionBusy(busy, activeButton = null) {
    [elements.toggle, elements.completePhase, elements.end].forEach((button) => {
      button.disabled = busy;
      button.removeAttribute('aria-busy');
    });
    if (busy && activeButton) activeButton.setAttribute('aria-busy', 'true');
  }

  function renderRoutines(routines, selectedId = '') {
    const current = String(selectedId || elements.routineSelect.value || '');
    elements.routineSelect.replaceChildren(option('', 'Custom routine'));
    routines.forEach((routine) => {
      elements.routineSelect.appendChild(option(routine.id, routine.name));
    });
    elements.routineSelect.value = routines.some((routine) => String(routine.id) === current) ? current : '';
    elements.deleteRoutine.hidden = !elements.routineSelect.value;
  }

  function fillRoutine(routine) {
    elements.routineName.value = routine?.name || '';
    elements.focusMinutes.value = routine?.focus_minutes ?? 25;
    elements.breakMinutes.value = routine?.break_minutes ?? 0;
    elements.longBreakMinutes.value = routine?.long_break_minutes ?? routine?.break_minutes ?? 0;
    elements.cycles.value = routine?.cycles ?? 1;
    elements.spotifyUrl.value = routine?.spotify_url || '';
    elements.deleteRoutine.hidden = !routine;
  }

  function renderSuggestions(values) {
    elements.suggestions.replaceChildren();
    values.forEach((minutes) => {
      elements.suggestions.appendChild(choice(`${minutes} min`, { breakSuggestion: minutes }));
    });
  }

  function renderRecent(selections) {
    elements.recentList.replaceChildren();
    selections.forEach((selection, index) => {
      const breakLabel = Number(selection.break_minutes) ? ` / ${selection.break_minutes}` : '';
      elements.recentList.appendChild(choice(
        `${selection.focus_minutes}${breakLabel} min`,
        { recentSelection: index },
      ));
    });
    elements.recentSelections.hidden = selections.length === 0;
  }

  function renderCycles(session) {
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
    renderCycles(session);
  }

  function renderTick(session, remaining) {
    text(elements.time, formatTimer(remaining));
    const ratio = progressRatio(session, remaining);
    elements.progress.style.setProperty('--focus-progress', String(ratio));
    elements.time.setAttribute('datetime', `PT${Math.max(0, remaining)}S`);
    document.title = `${formatTimer(remaining)} · ${session.phase === 'break' ? 'Break' : 'Focus'} - Nest`;
  }

  function renderHistory(history) {
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
    elements.historyEmpty.hidden = history.length > 0;
  }

  function renderSpotify(source) {
    const embedUrl = source?.spotify_embed_url || '';
    const spotifyUrl = source?.spotify_url || '';
    const active = document.body.classList.contains('focus-session-active');
    window.clearTimeout(utilityFadeTimer);
    if (embedUrl) {
      if (elements.spotifyEmbed.dataset.src !== embedUrl) {
        elements.spotifyEmbed.src = embedUrl;
        elements.spotifyEmbed.dataset.src = embedUrl;
      }
      elements.spotifyEmbed.hidden = false;
      elements.spotifyRegion.hidden = false;
      elements.utilities.hidden = false;
      elements.spotifyEmpty.hidden = true;
      elements.openSpotify.hidden = false;
      elements.openSpotify.href = spotifyUrl;
      text(elements.spotifyLabel, source.routine_name || source.name || 'Saved focus playlist');
    } else {
      elements.spotifyEmbed.hidden = true;
      elements.spotifyEmpty.hidden = active;
      elements.spotifyRegion.hidden = active;
      elements.openSpotify.hidden = true;
      text(elements.spotifyLabel, 'Your routine can keep one playlist close.');
      if (active) {
        utilityFadeTimer = window.setTimeout(() => {
          if (document.body.classList.contains('focus-session-active')) elements.utilities.hidden = true;
        }, 200);
      } else {
        elements.utilities.hidden = false;
      }
    }
  }

  function announce(message) {
    text(elements.announcer, '');
    window.setTimeout(() => text(elements.announcer, message), 20);
  }

  return {
    elements,
    showMode,
    setFormStatus,
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
    announce,
  };
}
