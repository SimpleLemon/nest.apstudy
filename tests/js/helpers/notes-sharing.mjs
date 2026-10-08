import fs from 'node:fs';
import vm from 'node:vm';
import { createParsedDOM } from './parsed-dom.mjs';

export const settleSharing = () => new Promise(resolve => setImmediate(resolve));
export const sharingRecord = (resourceType = 'note', resourceId = 'note/1', changes = {}) => ({
    resource_type: resourceType, resource_id: resourceId, revision: 1, public: false,
    share_url: `https://nest.example/shared/${resourceId}`,
    users: [{ id: 'user-a', name: 'Ada', role: 'viewer' }],
    pending_invitations: [{ email: 'friend@example.org', role: 'reviewer' }], inherited: [], ...changes,
});

export function sharingHarness() {
    const { window, document } = createParsedDOM();
    const requests = [], toasts = [], actions = [], timers = new Map();
    let nextTimer = 0;
    window.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    window.APStudyToast = { show: toast => toasts.push(toast) };
    window.APStudyUndo = { stage(options) {
        const action = {
            committed: false,
            undo() { options.restore(); options.onUndo?.(); },
            commit() { this.committed = true; options.onCommit?.(); },
        };
        actions.push(action);
        return action;
    } };
    const setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
    const clearTimeout = id => timers.delete(id);
    const context = vm.createContext({ window, document, navigator: { clipboard: { writeText: async () => {} } },
        URL, Error, AbortController, setTimeout, clearTimeout });
    const load = name => vm.runInContext(fs.readFileSync(`static/js/${name}`, 'utf8'), context, { filename: name });
    load('core/escaping.js');
    load('core/ui-primitives.js');
    load('core/http.js');
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
    load('notes/sharing.js');
    return {
        window, document, requests, toasts, actions, sharing: window.APStudyNotesSharing,
        modal: () => document.body.querySelector('.notes-modal'),
        change(control, value) { control.value = value; control.dispatchEvent(new window.Event('change', { bubbles: true })); },
        search(control, value) { control.value = value; control.dispatchEvent(new window.Event('input', { bubbles: true })); },
        runTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach(callback => { void callback(); }); },
        async respond(index, payload, status = 200, contentType = 'application/json') {
            requests[index].resolve(new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'Content-Type': contentType } }));
            await settleSharing();
        },
    };
}

export async function openSharing(harness, resourceType = 'note', resourceId = 'note/1', onSaved) {
    const opening = harness.sharing.open({ resourceType, resourceId, resourceTitle: 'Course work', onSaved });
    await harness.respond(harness.requests.length - 1, sharingRecord(resourceType, resourceId));
    await opening;
    return harness.modal();
}
