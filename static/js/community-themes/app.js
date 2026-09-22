import {core,el,button,api,status,preview,link,copy,download} from './ui.js';
import {mountEditor} from './editor.js';
import {review} from './admin.js';
const app=document.querySelector('#theme-app'), host=document.querySelector('#theme-content'), more=document.querySelector('#theme-more');
const view=app.dataset.view;let offset=0,generation=0;
function entry(theme){
    const doc=core.validate(theme.document),item=el('article',undefined,'theme-entry'),body=el('div',undefined,'theme-entry-copy');
    item.append(preview(doc.settings));body.append(el('h2',doc.name),el('p',`By ${doc.creator}${theme.status?' · '+theme.status:''}`,'theme-meta'),el('p',doc.description||'A Canvas appearance theme.','theme-note'));
    if(doc.tags.length)body.append(el('p',doc.tags.join(' · '),'theme-meta'));
    if(theme.remixOf)body.append(el('p',`Remixed from ${theme.remixOf.name} · revision ${theme.remixOf.revision}`,'theme-meta'));
    const actions=el('div',undefined,'theme-actions');
    if(view==='admin')actions.append(button('Review revision',()=>review(theme.id)));
    else if(view==='mine')actions.append(link('Open draft',`/themes/${theme.id}/edit`));
    else actions.append(link('Preview theme',`/themes/${theme.id}`),link('Remix',`/themes/new?remix=${theme.id}`));
    body.append(actions);item.append(body);return item;
}
async function load(reset=true){
    const token=++generation;if(reset){offset=0;host.replaceChildren(el('p','Loading…'));}more.disabled=true;host.setAttribute('aria-busy','true');
    try{
        const query=new URLSearchParams({offset:String(offset)});const q=document.querySelector('#theme-query')?.value.trim();if(q)query.set('q',q);
        const filter=document.querySelector('#theme-filter')?.value;const tag=document.querySelector('#theme-tag')?.value;if(tag)query.set('tag',tag);if(filter&&filter!=='reports')query.set('status',filter);
        const endpoint=view==='admin'?(filter==='reports'?'/api/admin/themes/reports':'/api/admin/themes'):view==='mine'?'/api/themes/mine':'/api/themes';
        const data=await api(endpoint+'?'+query);if(token!==generation)return;
        let grid=host.querySelector('.theme-grid');if(reset||!grid){grid=el('div',undefined,'theme-grid');host.replaceChildren(grid);}
        if(data.counts){const counts=document.querySelector('#theme-counts');counts.replaceChildren(...['pending','approved','draft','rejected','unpublished'].map(k=>el('span',`${k}: ${data.counts[k]||0}`)),el('span',`Open reports: ${data.openReports}`));}
        for(const theme of data.items){if(filter==='reports'){const item=el('article',undefined,'theme-entry-copy');item.append(el('h2',`Report #${theme.id}`),el('p',theme.reason),button('Review reported theme',()=>review(theme.theme_id)));grid.append(item);}else grid.append(entry(theme));}
        if(!grid.children.length){const empty=el('div',undefined,'theme-empty');empty.append(el('h2',view==='admin'?'Nothing to review':view==='mine'?'Your theme library is empty':'No published themes yet'),el('p',q||tag?'No themes match these filters.':view==='gallery'?'Be the first to submit a theme. It will appear here after admin approval.':'Themes will appear here as they are saved or submitted.'));if(view!=='admin')empty.append(link('Create theme','/themes/new',true));host.replaceChildren(empty);}
        offset+=data.items.length;more.hidden=!data.hasMore;if(view!=='admin')status('');
    }catch(error){if(token!==generation)return;status(error.message,true);if(reset)host.replaceChildren(button('Retry',()=>load(true)));}
    finally{if(token===generation){more.disabled=false;host.setAttribute('aria-busy','false');}}
}
async function detail(){
    const {theme}=await api(`/api/themes/${app.dataset.themeId}`),doc=core.validate(theme.document);host.replaceChildren(el('h2',doc.name),el('p',`By ${doc.creator} · approved revision ${theme.revision}`,'theme-meta'),el('p',doc.description));
    if(theme.remixOf)host.append(el('p',`Remixed from ${theme.remixOf.name} by ${theme.remixOf.creator}, revision ${theme.remixOf.revision}.`,'theme-meta'));
    const modes=el('div',undefined,'theme-review-previews');for(const mode of ['light','dark']){const panel=el('div');panel.append(el('h3',mode+' preview'),preview(doc.settings,mode));modes.append(panel);}host.append(modes);
    const actions=el('div',undefined,'theme-actions');actions.append(link('Remix this theme',`/themes/new?remix=${theme.id}`,true),button('Copy share link',()=>copy(new URL(theme.sharePath,location.origin).href)),button('Copy Canvas settings',()=>copy(JSON.stringify({...doc.settings,device_dark:false,auto_dark:false}))),button('Download theme',()=>download(doc)));host.append(actions,el('p','To apply: open APStudyCanvas → Themes → Community themes and paste this share link, or paste the copied Canvas settings into Import settings. Previewing here never changes your Canvas preferences.','theme-note'));
    const report=el('details');report.append(el('summary','Report this theme'));const label=el('label','What should an admin review?'),reason=el('textarea');reason.minLength=5;reason.maxLength=1000;label.append(reason);report.append(label,button('Send report',async()=>{await api(`/api/themes/${theme.id}/report`,'POST',{reason:reason.value});reason.value='';status('Report sent to admins.');}));host.append(report);host.setAttribute('aria-busy','false');
}
for(const tag of core.tags){const option=el('option',tag);option.value=tag;document.querySelector('#theme-tag')?.append(option);}
document.querySelector('#theme-search')?.addEventListener('submit',event=>{event.preventDefault();void load(true);});more.addEventListener('click',()=>void load(false));
try{if(view==='editor')await mountEditor(host,app.dataset.themeId);else if(view==='detail')await detail();else await load();}catch(error){host.replaceChildren(el('p','This theme could not be loaded.'),button('Retry',()=>location.reload()));status(error.message,true);host.setAttribute('aria-busy','false');}
