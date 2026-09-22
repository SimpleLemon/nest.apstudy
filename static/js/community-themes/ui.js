export const core = globalThis.APStudyTheme;
export function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function button(text, handler, primary = false) {
    const node = el('button', text, `theme-button${primary ? ' theme-primary' : ''}`);
    node.type = 'button';
    node.addEventListener('click', async () => {
        node.disabled = true;
        try { await handler(); } catch (error) { status(error.message, true); }
        finally { node.disabled = false; }
    });
    return node;
}
export function status(message, error = false) {
    const node = document.querySelector('#theme-status');
    node.textContent = message; node.dataset.error = String(error);
}
export async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(15000), headers: { Accept:'application/json', ...(body ? {'Content-Type':'application/json', 'X-CSRFToken':document.querySelector('meta[name=csrf-token]').content} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
    if (response.redirected || response.status === 401) throw Error('Sign in to Nest, then try again.');
    const value = await response.json().catch(() => null);
    if (!response.ok || !value?.ok) throw Error(value?.error?.message || (response.status === 403 ? 'Admin access is required.' : 'The request failed. Reload and try again.'));
    return value;
}
export function link(text, href, primary = false) {
    const node = el('a', text, `theme-button${primary ? ' theme-primary' : ''}`); node.href = href; return node;
}
export function preview(settings, mode = settings.dark_mode ? 'dark' : 'light') {
    const node = el('div', undefined, 'theme-preview');
    node.setAttribute('aria-label', `${mode} theme preview with illustrative course content`);
    const grid = el('div', undefined, 'theme-preview-grid'), aside = el('aside'), main = el('div', undefined, 'theme-preview-main');
    ['Canvas', 'Dashboard', 'Courses', 'Calendar'].forEach(text => aside.append(el('div', text)));
    main.append(el('h3', 'Dashboard'));
    const cards = el('div', undefined, 'theme-preview-cards');
    for (const name of ['Biology', 'Literature']) {
        const card = el('div', undefined, 'theme-preview-card');
        card.append(el('b', name), el('span', 'Next assignment · Friday'), el('em', 'View course')); cards.append(card);
    }
    main.append(cards, el('footer', 'Illustrative preview · your coursework stays private'));
    grid.append(aside, main); node.append(grid); paint(node, settings, mode); return node;
}
export function paint(node, settings, mode) {
    const palette = settings[`${mode}_preset`];
    if (!core.paletteValid(palette)) return;
    core.paletteKeys.forEach(key => node.style.setProperty(`--tp-${key}`, palette[key]));
    const families = {'':'system-ui','System UI':'system-ui','Public Sans':'"Public Sans",system-ui','Newsreader':'Newsreader,serif','IBM Plex Mono':'"IBM Plex Mono",monospace'};
    node.style.setProperty('--preview-font', families[settings.custom_font.family] || 'system-ui');
    node.style.setProperty('--tp-radius', `${settings.cardRoundness}px`);
    node.style.setProperty('--tp-padding', `${8 + settings.cardPadding / 2}px`);
    node.style.setProperty('--tp-gap', `${8 + settings.cardSpacing / 2}px`);
    node.dataset.condensed = String(settings.condensed_cards); node.dataset.wide = String(settings.wide_course_cards);
}
export function history(theme) {
    const section = el('details'); section.append(el('summary', 'Revision and moderation history'));
    const list = el('ol', undefined, 'theme-history');
    (theme.history || []).forEach(item => list.append(el('li', `Revision ${item.revision} · ${item.action}${item.actor_id ? ' by ' + item.actor_id : ''} · ${new Date(item.created_at).toLocaleString()}${item.reason ? ' — ' + item.reason : ''}`)));
    section.append(list); return section;
}
export async function copy(text) {
    try { await navigator.clipboard.writeText(text); status('Copied to clipboard.'); }
    catch { throw Error('Clipboard access failed. Use the download option or copy the address bar.'); }
}
export function download(documentValue) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(documentValue, null, 2)], {type:'application/json'}));
    const anchor = el('a'); anchor.href = url; anchor.download = 'apstudy-theme.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
