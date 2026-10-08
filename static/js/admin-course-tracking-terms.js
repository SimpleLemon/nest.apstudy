(() => {
  const labels = { upcoming: 'Upcoming', open: 'Open', closed: 'Closed' };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function localTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function scheduleValue(value) {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || localTime(date.toISOString()) !== value) {
      throw new Error('Choose a valid local date and time. This time may fall in a daylight-saving clock change.');
    }
    return date.toISOString();
  }

  function termForm(term) {
    const id = `tracking-${term.term}`;
    const state = term.effective_state;
    return `<form class="admin-term-row" data-term="${escape(term.term)}">
      <div class="admin-term-summary">
        <div><h3>${escape(term.label)}</h3><span class="admin-badge ${state === 'open' ? '' : 'admin-badge--muted'}">${labels[state] || 'Unavailable'}</span></div>
        <p>${term.active_count || 0} active · ${term.waiting_count || 0} ${state === 'upcoming' ? 'queued' : 'suspended'} · ${term.paused_count || 0} paused</p>
        ${term.catalog_available ? '' : '<p>Course data unavailable. You can schedule now; seat checks wait for course data.</p>'}
      </div>
      <div class="admin-term-fields">
        <label for="${id}-state">Tracking state<select id="${id}-state" name="state">
          ${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === term.state ? 'selected' : ''} >${label}</option>`).join('')}
        </select></label>
        <label for="${id}-opens"><span>Opens at (optional)</span><input id="${id}-opens" name="opens_at" type="datetime-local" value="${localTime(term.opens_at)}" ${term.state === 'closed' ? 'disabled' : ''}></label>
        <label for="${id}-closes"><span>Closes at (optional)</span><input id="${id}-closes" name="closes_at" type="datetime-local" value="${localTime(term.closes_at)}" ${term.state === 'closed' ? 'disabled' : ''}></label>
        <button class="admin-button" type="submit">Save ${escape(term.label)}</button>
      </div>
      <p class="admin-term-updated">${term.updated_at ? `Last saved ${escape(new Date(term.updated_at).toLocaleString())} by ${escape(term.updated_by)}` : 'No schedule set.'}</p>
      <p data-term-notice role="status" class="admin-term-notice" hidden></p>
    </form>`;
  }

  window.initAdminTrackingTerms = function (root) {
    const panel = root.querySelector('[data-tracking-terms]');
    if (!panel || panel.dataset.initialized) return;
    panel.dataset.initialized = 'true';
    const rows = panel.querySelector('[data-term-rows]');
    const yearSelect = panel.querySelector('[data-term-year]');
    const notice = panel.querySelector('[data-terms-notice]');
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    panel.querySelector('[data-term-timezone]').textContent = `Schedule times use ${timezone}. They continue to apply after restarts.`;
    let terms = [];

    function render() {
      rows.innerHTML = terms.filter((term) => term.term.endsWith(`_${yearSelect.value}`)).map(termForm).join('');
    }

    async function load() {
      notice.textContent = 'Loading term settings…';
      try {
        const payload = await window.APStudyHttp.fetchJson('/admin/course-tracking/terms', { credentials: 'same-origin', jsonMode: 'required' });
        if (!Array.isArray(payload?.terms)) throw new Error('Invalid term settings response.');
        terms = payload.terms;
        const years = [...new Set(terms.map((term) => term.term.split('_')[1]))].sort().reverse();
        const selected = yearSelect.value || String(new Date().getFullYear());
        yearSelect.innerHTML = years.map((year) => `<option ${year === selected ? 'selected' : ''}>${year}</option>`).join('');
        render();
        notice.textContent = '';
      } catch (error) {
        notice.textContent = error.message;
      }
    }

    yearSelect.addEventListener('change', render);
    panel.querySelector('[data-terms-reload]').addEventListener('click', load);
    panel.querySelector('[data-add-year]').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = event.target.querySelector('input');
      const year = Number(input.value);
      if (!Number.isInteger(year) || year < 2000 || year > 2199) return;
      for (const season of ['Spring', 'Fall']) {
        const term = `${season}_${year}`;
        if (!terms.some((item) => item.term === term)) terms.push({ term, label: `${season} ${year}`, state: 'upcoming', effective_state: 'upcoming', revision: 0, catalog_available: false });
      }
      if (![...yearSelect.options].some((option) => option.value === String(year))) yearSelect.add(new Option(String(year), String(year)));
      yearSelect.value = String(year);
      input.value = '';
      render();
    });
    rows.addEventListener('change', (event) => {
      if (event.target.name !== 'state') return;
      const form = event.target.closest('form');
      form.querySelectorAll('input').forEach((input) => {
        input.disabled = event.target.value === 'closed';
        if (event.target.value === 'closed') input.value = '';
      });
    });
    rows.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target.closest('form[data-term]');
      if (!form || form.dataset.saving) return;
      const term = terms.find((item) => item.term === form.dataset.term);
      const status = form.querySelector('[data-term-notice]');
      const fields = form.elements;
      const controls = [...fields].map((element) => ({ element, disabled: element.disabled }));
      status.hidden = false;
      try {
        const body = { state: fields.state.value, opens_at: scheduleValue(fields.opens_at.value), closes_at: scheduleValue(fields.closes_at.value), expected_revision: term.revision };
        form.dataset.saving = 'true';
        controls.forEach(({ element }) => { element.disabled = true; });
        status.textContent = 'Saving…';
        const payload = await window.APStudyHttp.fetchJson(`/admin/course-tracking/terms/${encodeURIComponent(term.term)}/toggle`, {
          jsonMode: 'required',
          errorFactory: (payload) => Object.assign(new Error(payload?.error || 'Unable to save term settings.'), { policy: payload?.policy }),
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': document.getElementById('admin-csrf-token')?.value || '' },
          body: JSON.stringify(body),
        });
        if (!payload?.policy || typeof payload.policy !== 'object') throw new Error('Invalid term settings response.');
        Object.assign(term, payload.policy);
        const enabledCount = (term.active_count || 0) + (term.waiting_count || 0);
        term.active_count = term.polling_enabled ? enabledCount : 0;
        term.waiting_count = term.polling_enabled ? 0 : enabledCount;
        form.outerHTML = termForm(term);
        const saved = rows.querySelector(`[data-term="${term.term}"]`);
        saved.querySelector('[data-term-notice]').hidden = false;
        saved.querySelector('[data-term-notice]').textContent = `${term.label} saved. Tracking is ${labels[term.effective_state].toLowerCase()}.`;
        saved.querySelector('button').focus();
        root.dispatchEvent(new CustomEvent('admin-tracking:policy-saved', { bubbles: true, detail: term }));
      } catch (error) {
        if (error.status === 409 && error.policy) {
          Object.assign(term, error.policy);
          form.outerHTML = termForm(term);
          const refreshed = rows.querySelector(`[data-term="${term.term}"]`);
          refreshed.querySelector('[data-term-notice]').hidden = false;
          refreshed.querySelector('[data-term-notice]').textContent = error.message;
          refreshed.querySelector('select').focus();
        }
        status.textContent = error.message;
      } finally {
        delete form.dataset.saving;
        controls.forEach(({ element, disabled }) => { element.disabled = disabled; });
      }
    });
    void load();
  };
})();
