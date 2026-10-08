function describe(policy, enabled, now = Date.now()) {
  let state = policy?.effective_state || 'unavailable';
  if (policy?.available && policy.state !== 'closed') {
    if (policy.closes_at && now >= Date.parse(policy.closes_at)) state = 'closed';
    else if (policy.opens_at) state = now >= Date.parse(policy.opens_at) ? 'open' : 'upcoming';
  }
  const label = policy?.label || 'This term';
  const canEnable = state === 'open' || state === 'upcoming';
  const waitingForData = state === 'open' && policy?.catalog_available === false;
  const active = Boolean(enabled && state === 'open' && !waitingForData);
  const status = !enabled ? 'paused' : active ? 'active' : state === 'upcoming' ? 'queued' : waitingForData ? 'waiting for course data' : state;
  const description = state === 'closed'
    ? `${label} tracking has closed. No seat checks or alerts will run.`
    : state === 'unavailable'
      ? 'Tracking settings are unavailable. Reload to try again.'
      : waitingForData ? 'Waiting for course data. Seat checks will begin after it is imported.'
      : state === 'upcoming'
        ? enabled ? 'Queued. Seat checks and alerts begin when this term opens.' : 'Queue this tracker now. Seat checks and alerts begin when this term opens.'
        : enabled ? 'Alerts are on for class seats and waitlist openings.' : 'Notify me when a class seat or waitlist place opens.';
  const next = state === 'upcoming' ? (policy.opens_at ? new Date(policy.opens_at).toLocaleString() : 'When the term opens')
    : state === 'closed' ? 'Term closed' : state === 'unavailable' ? 'Unavailable' : waitingForData ? 'Waiting for course data' : null;
  return { state, status, canEnable, active, description, next };
}
export { describe };
