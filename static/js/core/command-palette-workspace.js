import * as React from 'https://esm.sh/react@18.3.1';
import { Command } from 'https://esm.sh/cmdk@1.1.1?deps=react@18.3.1,react-dom@18.3.1';
import { WORKSPACE_SEARCH_GROUPS, formatSearchTimestamp } from './command-palette-search.js';

const h = React.createElement;

export function renderWorkspaceResults({
  groups,
  coursesEnabled,
  searchStatus,
  unavailableCategories,
  commandRows,
  onOpenResult,
  renderIcon,
}) {
  const content = [];
  if (searchStatus === 'loading') {
    content.push(h('div', { className: 'apstudy-command-palette-status', key: 'loading' },
      h('span', { className: 'apstudy-command-palette-spinner', 'aria-hidden': 'true' }),
      h('span', null, 'Searching your workspace…')));
  }
  if (searchStatus === 'error') {
    content.push(h('div', { className: 'apstudy-command-palette-status is-error', key: 'error' },
      h('span', { className: 'material-symbols-outlined', 'aria-hidden': 'true' }, 'cloud_off'),
      h('span', null, 'Workspace results are unavailable. Commands still work.')));
  }
  if (unavailableCategories.length) {
    content.push(h('div', { className: 'apstudy-command-palette-status is-warning', key: 'partial' },
      h('span', { className: 'material-symbols-outlined', 'aria-hidden': 'true' }, 'info'),
      h('span', null, `Some ${unavailableCategories.join(', ')} results could not be loaded.`)));
  }

  for (const group of WORKSPACE_SEARCH_GROUPS) {
    if (group.key === 'courses' && !coursesEnabled) continue;
    const items = groups[group.key] || [];
    if (!items.length) continue;
    content.push(h(Command.Group, { heading: group.label, key: group.key },
      items.map((result) => h(SearchResultRow, {
        key: `${group.key}-${result.id}`,
        result,
        onSelect: () => onOpenResult(result),
        renderIcon,
      }))));
  }

  if (commandRows.length) {
    content.push(h(Command.Group, { heading: 'Commands', key: 'commands' }, commandRows));
  }

  const hasResults = Object.values(groups).some((items) => items.length) || commandRows.length;
  if (searchStatus === 'ready' && !hasResults) {
    content.push(h('div', { className: 'apstudy-command-palette-empty', key: 'empty' },
      h('strong', null, 'Nothing matched this search.'),
      h('span', null, 'Try a file name, note title, event, person, or course.')));
  }
  return content;
}

function SearchResultRow({ result, onSelect, renderIcon }) {
  const metadata = [result.secondary, result.snippet && result.snippet !== result.secondary ? result.snippet : '']
    .filter(Boolean)
    .join(' · ');
  const timestamp = formatSearchTimestamp(result);
  const icon = result.avatar_url
    ? h('img', { src: result.avatar_url, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
    : renderIcon(result.icon);
  return h(
    Command.Item,
    {
      className: 'apstudy-command-palette-item apstudy-command-palette-result',
      keywords: [result.secondary, result.snippet].filter(Boolean),
      value: `${result.category}:${result.id}:${result.title}`,
      onSelect,
    },
    h('span', { className: 'apstudy-command-palette-item-icon', 'aria-hidden': 'true' }, icon),
    h('span', { className: 'apstudy-command-palette-result-copy' },
      h('span', { className: 'apstudy-command-palette-item-label' }, result.title),
      h('span', { className: 'apstudy-command-palette-item-meta' }, metadata || 'Open result')),
    timestamp ? h('span', { className: 'apstudy-command-palette-item-time' }, timestamp) : null,
  );
}
