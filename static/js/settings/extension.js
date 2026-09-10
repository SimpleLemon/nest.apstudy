/* Independent of the profile and ICS form hydration. */
(function () {
  'use strict';
  const host = document.getElementById('extension-connection-accounts');
  const status = document.getElementById('extension-connection-status');
  const refresh = document.getElementById('extension-connection-refresh');
  if (!host || !status || !refresh) return;
  let generation = 0;
  let busy = false;
  const drafts = new Map();
  let lastData = '';
  const readScopes = ['full_history_upload', 'ongoing_read', 'shares_ics_inclusion'];
  const writeScopes = [
    ['personal_events_write', 'Edit personal events', 'calendar_two_way_writeback'],
    ['planner_items_write', 'Edit planner tasks', 'calendar_two_way_writeback'],
    ['selected_item_mirroring', 'Mirror individually selected items', 'calendar_mirroring'],
  ];
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action) {
    const node = element('button', text, 'settings-button settings-button-secondary');
    node.type = 'button';
    node.addEventListener('click', async () => {
      if (busy) return;
      busy = true; node.disabled = true;
      const sourceRef = node.closest(".extension-account")?.dataset.source;
      try { await action(); }
      catch (error) { status.textContent = error.message; }
      finally {
        busy = false; node.disabled = false;
        if (!node.isConnected) {
          const group = Array.from(host.querySelectorAll('.extension-account')).find(item => item.dataset.source === sourceRef);
          const restored = Array.from(group?.querySelectorAll('button') || []).find(item => item.textContent === text);
          (restored || refresh).focus({ preventScroll: true });
        }
      }
    });
    return node;
  }
  async function request(path, body, method = 'GET') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(response.status === 401 ? 'Sign in to Nest again, then refresh connection.' : data.error?.message || 'Connection could not be updated. Refresh and try again.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Nest took too long to respond. Refresh connection to try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function consent(source, version, scopes, action) {
    await request(`/api/extension/connection/${encodeURIComponent(source.source_ref)}/consent`, { version, scopes, action }, 'PUT');
    if (version === 2) drafts.delete(source.source_ref);
    await load(true);
  }
  function renderConflict(source, item, container) {
    const row = element('div', undefined, 'extension-conflict');
    row.append(element('p', `${item.event_ref} · ${String(item.state).replaceAll('_', ' ')}`, 'settings-help-text'));
    if (item.state === 'conflict') row.append(button('Review conflict', async () => {
      const path = `/api/extension/calendar/sources/${encodeURIComponent(source.source_ref)}/writebacks/${encodeURIComponent(item.id)}`;
      const { conflict } = await request(`${path}/conflict`);
      const view = element('dl');
      for (const [label, snapshot] of [['Canvas version', conflict.canvasSnapshot], ['Nest version', conflict.nestSnapshot]]) {
        view.append(element('dt', label));
        const fields = ['title', 'description', 'start', 'end', 'is_all_day', 'deadline_at', 'completed', 'deleted'];
        const text = snapshot ? fields.filter(key => snapshot[key] !== undefined && snapshot[key] !== null).map(key => `${key.replaceAll('_', ' ')}: ${snapshot[key]}`).join('\n') : 'Open Canvas and refresh the extension to retrieve this version.';
        view.append(element('dd', text));
      }
      const actions = element('div', undefined, 'extension-conflict-actions');
      for (const [choice, label] of [['keep_canvas', 'Keep Canvas'], ['keep_nest', 'Keep Nest']]) {
        const action = button(label, async () => {
          await request(`${path}/resolve`, { choice, expected_revision: conflict.expected_revision }, 'POST');
          await load(true);
        });
        action.disabled = !conflict.canvasSnapshot || (choice === 'keep_nest' && (conflict.writeback?.operation === 'create' || conflict.canvasSnapshot.deleted));
        actions.append(action);
      }
      row.replaceChildren(element('p', item.event_ref), view, actions);
      actions.querySelector('button')?.focus();
    }));
    container.append(row);
  }
  function render(data) {
    const fragment = document.createDocumentFragment();
    if (!data.sources?.length) fragment.append(element('p', 'No Canvas accounts connected. Open APStudyCanvas on Canvas, then choose Account & calendar to connect.', 'settings-help-text'));
    for (const source of data.sources || []) {
      const group = element('section', undefined, 'extension-account');
      group.dataset.source = source.source_ref;
      group.append(element('h4', source.label || 'Canvas account'));
      group.append(element('p', `Sync: ${String(source.sync_state || 'idle').replaceAll('_', ' ')}${source.last_sync_completed_at ? ` · Last completed ${new Date(source.last_sync_completed_at).toLocaleString()}` : ''}${source.last_error_code ? ` · ${source.last_error_code.replaceAll('_', ' ')}` : ''}`, 'settings-help-text'));
      const read = source.access?.['1'];
      group.append(element('p', 'Read access includes assignment history and ongoing updates. Imported items can appear in your shared calendars and ICS feeds. Revoking access stops pending work and retains personal copies.', 'settings-help-text'));
      const readButton = button(read?.granted ? 'Revoke read access' : 'Allow history and ongoing reads', () => consent(source, 1, readScopes, read?.granted ? 'revoke' : 'grant'));
      readButton.disabled = !read?.granted && data.capabilities?.calendar_upload !== true;
      group.append(readButton);
      const writes = element('div');
      const selected = [];
      for (const [scope, label, capability] of writeScopes) {
        const row = element('div', undefined, 'extension-access');
        const field = element('label');
        const input = element('input'); input.type = 'checkbox'; input.value = scope;
        input.checked = drafts.has(source.source_ref) ? drafts.get(source.source_ref).includes(scope) : Boolean(source.access?.['2']?.granted && source.access['2'].scopes.includes(scope));
        input.disabled = data.capabilities?.[capability] !== true;
        input.addEventListener('change', () => {
          drafts.set(source.source_ref, selected.filter(field => field.checked).map(field => field.value));
        });
        selected.push(input);
        field.append(input, element('span', label + (input.disabled ? ' — unavailable on this server' : '')));
        row.append(field); writes.append(row);
      }
      writes.append(button('Save write access', async () => {
        const scopes = selected.filter(input => input.checked && !input.disabled).map(input => input.value);
        await consent(source, 2, scopes, scopes.length ? 'grant' : 'revoke');
      }));
      group.append(writes, element('p', 'Choose individual mirrors in the extension. Keep Canvas open to process queued changes. Course assignments remain read-only.', 'settings-help-text'));
      const activity = source.activity || [];
      group.append(element('h4', 'Activity & conflicts'));
      if (!activity.length) group.append(element('p', 'No pending or recent writes.', 'settings-help-text'));
      activity.forEach(item => renderConflict(source, item, group));
      fragment.append(group);
    }
    host.replaceChildren(fragment);
  }
  async function load(force = false) {
    const current = ++generation;
    status.textContent = 'Checking connected accounts…';
    refresh.disabled = true;
    try {
      const data = await request('/api/extension/connection');
      if (current !== generation) return;
      const serialized = JSON.stringify({ sources: data.sources, capabilities: data.capabilities });
      if (force || lastData !== serialized || !host.childNodes.length) {
        // Do not discard an access editor or conflict choice on focus refresh.
        if (force || !host.contains(document.activeElement)) { render(data); lastData = serialized; }
      }
      status.textContent = drafts.size ? 'Connection refreshed. Your unsaved access choices are preserved.' : 'Connected to Nest. Account status is up to date.';
    } catch (error) { if (current === generation) status.textContent = error.message; }
    finally { if (current === generation) refresh.disabled = false; }
  }
  refresh.addEventListener('click', () => { if (!busy) load(true); });
  window.addEventListener('focus', () => { if (!busy) load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) load(); });
  load();
}());
