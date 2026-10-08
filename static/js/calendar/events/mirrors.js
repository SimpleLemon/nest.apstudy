import { createCalendarDataAdapter } from "../adapter.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

// A selected personal item owns this editor; refreshed data never silently submits a choice.
export function createCalendarMirrors({ document, view = document.defaultView || globalThis, adapter, reload, lifecycle }) {
    adapter = createCalendarDataAdapter(adapter || {}, { window: view });
    let active = null;
    const personalRef = event => {
        const value = String(event?.event_ref || (event?.task_id ? `task:${event.task_id}` : ""));
        return /^(user|task):[A-Za-z0-9._-]{1,150}$/.test(value) && event?.source !== "simulated" ? value : null;
    };
    function close() { active?.close(); }
    function open({ event, opener, deletion = false } = {}) {
        const eventRef = personalRef(event);
        if (!eventRef || !adapter?.loadMirrors || !adapter?.changeMirror) return false;
        close();
        const abort = lifecycle.trackAbortController();
        const dialog = document.createElement("dialog");
        dialog.className = "calendar-event-dialog calendar-mirror-dialog";
        dialog.setAttribute("aria-label", "Canvas copies");
        let closed = false;
        const session = { dialog, close: closeSession };
        const isCurrent = () => !closed && !abort.signal.aborted && active === session && dialog.open;
        function cleanup() {
            if (closed) return;
            closed = true;
            const owned = active === session;
            if (owned) active = null;
            abort.abort();
            lifecycle.releaseAbortController(abort);
            dialog.remove();
            if (owned && opener?.isConnected) opener.focus({ preventScroll: true });
        }
        function closeSession() {
            cleanup();
            if (dialog.open) dialog.close();
        }
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
            const requestAbort = lifecycle.trackAbortController();
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                lifecycle.clearTimeout(timer);
                lifecycle.releaseAbortController(requestAbort);
                abort.signal.removeEventListener('abort', cancel);
            };
            const cancel = () => { requestAbort.abort(); release(); };
            const timer = lifecycle.setTimeout(cancel, 12000);
            abort.signal.addEventListener('abort', cancel, { once: true });
            try {
                const result = await operation(requestAbort.signal);
                if (requestAbort.signal.aborted) throw new (view.DOMException || globalThis.DOMException)('Mirror request cancelled', 'AbortError');
                return result;
            } finally { release(); }
        }
        async function refresh(message = '') {
            if (!isCurrent()) return;
            const selected = q('[data-account]').value;
            busy = true; render(); q('[data-status]').textContent = 'Checking this item’s Canvas copies…';
            try {
                const result = await bounded(signal => adapter.loadMirrors({ eventRef, signal }));
                if (!isCurrent()) return;
                if (!result.ok) throw new Error('request failed');
                const body = result.payload;
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
            } catch {
                if (isCurrent()) { model = null; q('[data-status]').textContent = 'Could not load this item. Check your Nest connection, then refresh.'; }
            } finally { if (isCurrent()) { busy = false; render(); } }
        }
        async function change(action) {
            if (busy || !model || !isCurrent()) return;
            const payload = { event_ref: eventRef, source_ref: q('[data-account]').value, action, expected_revision: model.expected_revision };
            busy = true; render(); q('[data-status]').textContent = 'Saving your choice…';
            try {
                const result = await bounded(signal => adapter.changeMirror({ payload, signal }));
                if (!isCurrent()) return;
                if (!result.ok) throw new Error('request failed');
                const body = result.payload;
                if (body.ok === false || !body.result?.state) throw new Error('save failed');
                if (body.result.state === 'deleted_local') { session.close(); reload(); return; }
                q('[data-confirm]').checked = false;
                await refresh(body.result.state === 'unlinked' ? 'Unlinked. Both copies are retained.' : 'Queued. Keep the extension running with this Canvas account signed in. Refresh to check progress.');
            } catch {
                if (isCurrent()) {
                    q('[data-confirm]').checked = false;
                    await refresh('The choice was not confirmed. Review the refreshed item before trying again.');
                }
            } finally { if (isCurrent()) { busy = false; render(); const target = q(`[data-action="${action}"]`); (target?.disabled ? q("[data-refresh]") : target)?.focus(); } }
        }
        dialog.addEventListener('click', event => {
            if (!isCurrent()) return;
            const button = event.target.closest('[data-action]');
            if (button && !button.disabled) void change(button.dataset.action);
            if (event.target.closest('[data-refresh]')) void refresh();
            if (event.target.closest('[data-show-delete]')) { q('[data-delete-controls]').hidden = false; q('[data-confirm]').focus(); }
        });
        dialog.addEventListener('change', render);
        dialog.addEventListener('cancel', event => { event.preventDefault(); session.close(); });
        dialog.addEventListener('submit', event => {
            if (event.target.matches('form[method="dialog"]')) { event.preventDefault(); session.close(); }
        });
        dialog.addEventListener('close', cleanup, { once: true });
        active = session;
        document.body.append(dialog); dialog.showModal(); void refresh();
        return true;
    }
    lifecycle.addCleanup(close);
    return { open, close, personalRef };
}
