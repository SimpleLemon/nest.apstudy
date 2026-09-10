// A selected personal item owns this editor; refreshed data never silently submits a choice.
(function () {
    let active = null;
    const personalRef = event => {
        const value = String(event?.event_ref || (event?.task_id ? `task:${event.task_id}` : ""));
        return /^(user|task):[A-Za-z0-9._-]{1,150}$/.test(value) && event?.source !== "simulated" ? value : null;
    };
    function close() { active?.close(); }
    function open({ event, opener, deletion = false } = {}) {
        const eventRef = personalRef(event);
        const adapter = window.APStudyCalendarDataAdapter;
        if (!eventRef || !adapter?.loadMirrors || !adapter?.changeMirror) return false;
        close();
        const abort = new AbortController();
        const dialog = document.createElement("dialog");
        dialog.className = "calendar-event-dialog calendar-mirror-dialog";
        dialog.setAttribute("aria-label", "Canvas copies");
        dialog.innerHTML = `<form method="dialog" class="calendar-event-form">
            <div class="calendar-event-header"><h3 class="calendar-event-title">Canvas copies</h3><button class="calendar-event-button calendar-event-button-secondary" value="close">Close</button></div>
            <p data-title></p>
            <p>Only this item is selected. Copies use the chosen account’s personal calendar or planner notes. Course assignments cannot be mirrored.</p>
            <label class="calendar-event-field">Canvas account<select data-account aria-describedby="mirror-destination"></select></label>
            <p id="mirror-destination" data-destination></p>
            <p data-status role="status" aria-live="polite"></p>
            <div class="calendar-mirror-actions"><button type="button" data-action="mirror" class="calendar-event-button calendar-event-button-primary">Mirror to Canvas</button><button type="button" data-action="unlink" class="calendar-event-button calendar-event-button-secondary">Unlink, keep copies</button><button type="button" data-refresh class="calendar-event-button calendar-event-button-secondary">Refresh</button></div>
            <button type="button" data-show-delete class="calendar-event-button calendar-event-button-secondary">Deletion options…</button><div data-delete-controls><p>Delete only the Nest item to keep every Canvas copy. Delete both copies to remove this Nest item after Canvas confirms deletion. Newer Nest edits are preserved for review.</p>
            <label class="calendar-mirror-confirm"><input type="checkbox" data-confirm> I want to delete the selected item.</label>
            <div class="calendar-mirror-actions"><button type="button" data-action="delete_local" class="calendar-event-button calendar-event-button-secondary">Delete Nest copy only</button><button type="button" data-action="delete_both" class="calendar-event-button calendar-event-button-secondary">Delete both copies</button></div></div>
        </form>`;
        const q = selector => dialog.querySelector(selector);
        q('[data-title]').textContent = String(event.title || "Personal item");
        q('[data-delete-controls]').hidden = !deletion;
        let model = null, busy = false, writeAvailable = false;
        function render() {
            const choice = model?.sources.find(item => item.source_ref === q('[data-account]').value);
            q('[data-account]').disabled = busy || !model?.sources.length;
            q('[data-refresh]').disabled = busy;
            q('[data-destination]').textContent = choice ? `${choice.label} · ${choice.destination} · ${String(choice.state).replaceAll('_', ' ')}` : 'No connected Canvas accounts. Add an account in settings.';
            for (const button of dialog.querySelectorAll('[data-action]')) {
                const action = button.dataset.action;
                const confirmed = q('[data-confirm]').checked;
                button.disabled = busy || !model || (action === 'delete_local' ? !confirmed : !choice
                    || (action === 'unlink' ? !choice.linked && !choice.pending_id
                        : !writeAvailable || !choice.allowed || !!choice.pending_id || (action === 'mirror' ? choice.linked : !confirmed || !choice.linked)));
            }
        }
        async function bounded(operation) {
            const requestAbort = new AbortController();
            const cancel = () => requestAbort.abort();
            abort.signal.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(cancel, 12000);
            try { return await operation(requestAbort.signal); }
            finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); }
        }
        async function refresh(message = '') {
            const selected = q('[data-account]').value;
            busy = true; render(); q('[data-status]').textContent = 'Checking this item’s Canvas copies…';
            try {
                const result = await bounded(signal => adapter.loadMirrors({ eventRef, signal }));
                if (abort.signal.aborted) return;
                const body = result.payload || result;
                if (!body.item || body.item.event_ref !== eventRef || !Array.isArray(body.item.sources) || !body.item.expected_revision) throw new Error('invalid response');
                model = body.item;
                writeAvailable = body.capabilities?.calendar_two_way_writeback === true && body.capabilities?.calendar_mirroring === true;
                q('[data-title]').textContent = model.title;
                q('[data-account]').replaceChildren();
                for (const source of model.sources) {
                    const option = document.createElement('option'); option.value = source.source_ref; option.textContent = source.label; q('[data-account]').append(option);
                }
                if (model.sources.some(item => item.source_ref === selected)) q('[data-account]').value = selected;
                q('[data-status]').textContent = message || (writeAvailable ? 'Choose an account and review its copy status.' : 'Creating or deleting Canvas copies is not available for this session. Existing copies can still be unlinked.');
            } catch (_) {
                if (!abort.signal.aborted) { model = null; q('[data-status]').textContent = 'Could not load this item. Check your Nest connection, then refresh.'; }
            } finally { if (!abort.signal.aborted) { busy = false; render(); } }
        }
        async function change(action) {
            if (busy || !model) return;
            const payload = { event_ref: eventRef, source_ref: q('[data-account]').value, action, expected_revision: model.expected_revision };
            busy = true; render(); q('[data-status]').textContent = 'Saving your choice…';
            try {
                const result = await bounded(signal => adapter.changeMirror({ payload, signal }));
                if (abort.signal.aborted) return;
                const body = result.payload || result;
                if (body.ok === false || !body.result?.state) throw new Error('save failed');
                if (body.result.state === 'deleted_local') { window.loadCalendarData?.(); close(); return; }
                q('[data-confirm]').checked = false;
                await refresh(body.result.state === 'unlinked' ? 'Unlinked. Both copies are retained.' : 'Queued. Keep the extension running with this Canvas account signed in. Refresh to check progress.');
            } catch (_) {
                if (!abort.signal.aborted) await refresh('The choice was not confirmed. Review the refreshed item before trying again.');
            } finally { if (!abort.signal.aborted) { busy = false; render(); const target = q(`[data-action="${action}"]`); (target?.disabled ? q("[data-refresh]") : target)?.focus(); } }
        }
        dialog.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (button && !button.disabled) void change(button.dataset.action);
            if (event.target.closest('[data-refresh]')) void refresh();
            if (event.target.closest('[data-show-delete]')) { q('[data-delete-controls]').hidden = false; q('[data-confirm]').focus(); }
        });
        dialog.addEventListener('change', render);
        dialog.addEventListener('close', () => {
            abort.abort(); dialog.remove(); if (active?.dialog === dialog) active = null;
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        }, { once: true });
        active = { dialog, close: () => dialog.close() };
        document.body.append(dialog); dialog.showModal(); void refresh();
        return true;
    }
    window.APStudyCalendarMirrors = { open, close, personalRef };
}());
