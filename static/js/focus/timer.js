export function clockedSession(session) {
  if (!session) return null;
  return {
    ...session,
    _clockStartedAt: performance.now(),
    _clockRemaining: Number(session.remaining_seconds || 0),
  };
}

export function remainingSeconds(session) {
  if (!session) return 0;
  if (session.state !== 'running') return Math.max(0, Number(session.remaining_seconds || 0));
  const elapsed = Math.floor((performance.now() - Number(session._clockStartedAt || 0)) / 1000);
  return Math.max(0, Number(session._clockRemaining || 0) - elapsed);
}

export function formatTimer(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function progressRatio(session, remaining) {
  const duration = Math.max(1, Number(session?.phase_duration_seconds || 1));
  return Math.min(1, Math.max(0, 1 - remaining / duration));
}

export function phaseLabel(session) {
  if (!session) return '';
  if (session.phase === 'break') return session.state === 'paused' ? 'Break ready' : 'Break';
  return session.state === 'paused' ? 'Focus paused' : 'Focus session';
}

export function nextPhaseLabel(session) {
  if (!session) return '';
  if (session.phase === 'break') return 'Focus next';
  const completedAfterThis = Number(session.completed_focus_cycles || 0) + 1;
  if (completedAfterThis >= Number(session.total_cycles || 1)) return 'Last focus phase';
  const longBreak = completedAfterThis % 4 === 0 && Number(session.long_break_seconds || 0) > 0;
  const seconds = longBreak ? session.long_break_seconds : session.break_seconds;
  return seconds ? `Break next · ${Math.round(Number(seconds) / 60)} min` : 'Next focus follows immediately';
}
