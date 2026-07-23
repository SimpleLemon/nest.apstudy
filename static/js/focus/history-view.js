function formatCompletedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export function renderHistory(list, history) {
  if (!list) return;
  const items = history.slice(0, 8).map((entry) => {
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
    return item;
  });
  list.replaceChildren(...items);
}
