function catalogStatusText(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'Saved Atlas catalog · Refresh date unavailable';
  const status = String(metadata.status || '').toLowerCase();
  const labels = {
    missing: 'Atlas catalog not yet available',
    failed: 'Atlas refresh failed · Showing saved catalog',
    unavailable: 'Atlas refresh unavailable · Showing saved catalog',
    stale: 'Showing older saved Atlas catalog',
    partial: 'Partial Atlas catalog',
    legacy: 'Saved Atlas catalog · Coverage unverified',
    'legacy/unverified': 'Saved Atlas catalog · Coverage unverified',
    unverified: 'Saved Atlas catalog · Coverage unverified',
    refreshing: 'Atlas catalog refresh in progress',
    complete: 'Atlas undergraduate catalog',
  };
  const label = labels[status] || 'Saved Atlas catalog';
  const date = metadata.last_successful_refresh ? new Date(metadata.last_successful_refresh) : null;
  const updated = date && !Number.isNaN(date.getTime())
    ? `Updated ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
    : 'Refresh date unavailable';
  return [label, metadata.tentative ? 'Tentative schedule' : null, updated].filter(Boolean).join(' · ');
}

function renderCatalogStatus(state) {
  const target = document.getElementById('courses-catalog-status');
  if (!target) return;
  target.textContent = catalogStatusText(state.termMetadata?.[state.selectedTerm]);
}

export { catalogStatusText, renderCatalogStatus };
