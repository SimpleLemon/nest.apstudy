import {core, el, button, api, status, preview, paint, link, history, download} from './ui.js';

export async function mountEditor(host, id) {
    let theme = id ? (await api(`/api/themes/${id}/draft`)).theme : null;
    const parent = new URLSearchParams(location.search).get('remix');
    let doc = theme?.document || core.defaults(), parentRevision = null;
    if (!id && parent) {
        if (!/^[a-f0-9]{32}$/.test(parent)) throw Error('Invalid remix link.');
        const source = (await api(`/api/themes/${parent}`)).theme;
        doc = structuredClone(source.document); parentRevision = source.revision;
        doc.name = `${doc.name.slice(0,70)} remix`; doc.creator = '';
    }
    let dirty = false, busy = false, mode = doc.settings.dark_mode ? 'dark' : 'light';
    const beforeUnload = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    host.addEventListener('input', () => { dirty = true; });
    document.querySelector('.theme-header nav')?.addEventListener('click', event => {
        if (event.target.closest('a') && dirty && !confirm('Leave this unsaved theme draft?')) event.preventDefault();
    });
    function draw() {
        const layout = el('div', undefined, 'theme-editor'), form = el('form'), panel = el('div', undefined, 'theme-preview-panel');
        form.addEventListener('submit', e => e.preventDefault());
        const state = el('p', theme ? `Revision ${theme.revision} · ${theme.status}${theme.publishedRevision ? ' · approved revision ' + theme.publishedRevision + ' is public' : ' · private'}` : 'New private draft · nothing is published until approval', 'theme-note');
        form.append(state);
        function field(label, key, kind='input', max=80) {
            const wrapper = el('label', label), input = el(kind); input.value = doc[key]; input.maxLength = max; input.required = key !== 'description';
            input.addEventListener('input', () => { doc[key] = input.value; }); wrapper.append(input); form.append(wrapper);
        }
        field('Theme name', 'name'); field('Public creator name', 'creator', 'input', 60); field('Description', 'description', 'textarea', 1000);
        const tags = el('fieldset'); tags.append(el('legend','Categories · choose up to four'));
        const tagRow = el('div', undefined, 'theme-actions');
        core.tags.forEach(tag => { const label = el('label',tag), check = el('input'); check.type='checkbox'; check.checked=doc.tags.includes(tag); check.addEventListener('change',()=>{doc.tags=check.checked?[...doc.tags,tag]:doc.tags.filter(x=>x!==tag);dirty=true;});label.prepend(check);tagRow.append(label); }); tags.append(tagRow); form.append(tags);
        const modeLabel = el('label','Default appearance'), modeSelect = el('select');
        for (const value of ['light','dark']) { const option = el('option',value);option.value=value;modeSelect.append(option); }
        modeSelect.value=doc.settings.dark_mode?'dark':'light';
        modeSelect.addEventListener('change',()=>{doc.settings.dark_mode=modeSelect.value==='dark';dirty=true;});modeLabel.append(modeSelect);form.append(modeLabel);
        const palette = el('fieldset');palette.append(el('legend',`${mode === 'light' ? 'Light' : 'Dark'} palette`));
        const colors = el('div',undefined,'theme-palette');
        const live = preview(doc.settings,mode), warnings = el('p',undefined,'theme-note');
        function updatePreview() { paint(live,doc.settings,mode); const issues=core.contrastWarnings(doc.settings[mode+'_preset']);warnings.textContent=issues.length?'Below 4.5:1 text contrast: '+issues.join(', '):'Text colors meet 4.5:1 against the preview surfaces.'; }
        core.paletteKeys.forEach(key=>{
            const label=el('label',key.replaceAll('-',' '),'theme-color'), picker=el('input'), hex=el('input');picker.type='color';hex.type='text';hex.maxLength=7;hex.pattern='#[0-9a-fA-F]{6}';
            picker.value=hex.value=doc.settings[mode+'_preset'][key];
            picker.setAttribute('aria-label',key+' color');hex.setAttribute('aria-label',key+' hex value');
            picker.addEventListener('input',()=>{hex.value=picker.value;doc.settings[mode+'_preset'][key]=picker.value;updatePreview();});
            hex.addEventListener('input',()=>{if(/^#[\da-f]{6}$/i.test(hex.value)){picker.value=hex.value;doc.settings[mode+'_preset'][key]=hex.value;updatePreview();}});
            label.append(picker,hex);colors.append(label);
        });palette.append(colors);form.append(palette);
        const appearance=el('fieldset');appearance.append(el('legend','Typography and cards'));
        const fontLabel=el('label','Canvas font'),font=el('select');core.fonts.forEach(f=>{const option=el('option',f||'Canvas default');option.value=f;font.append(option);});font.value=doc.settings.custom_font.family;
        font.addEventListener('change',()=>{doc.settings.custom_font={family:font.value,link:''};dirty=true;updatePreview();});fontLabel.append(font);appearance.append(fontLabel);
        const sizes=el('div',undefined,'theme-palette');
        for(const [key,[min,max]] of Object.entries(core.ranges)){const label=el('label',({cardRoundness:'Card corners',cardImageRoundness:'Image corners',cardPadding:'Card padding',cardSpacing:'Card spacing'})[key]+' (px)'),input=el('input');input.type='number';input.min=min;input.max=max;input.step=1;input.value=doc.settings[key];input.addEventListener('input',()=>{doc.settings[key]=Number(input.value);updatePreview();});label.append(input);sizes.append(label);}
        appearance.append(sizes);
        for(const [key,title] of [['wide_course_cards','Wide course cards'],['condensed_cards','Condensed course cards'],['disable_color_overlay','Remove course color overlays']]){const label=el('label',title),check=el('input');check.type='checkbox';check.checked=doc.settings[key];check.addEventListener('change',()=>{doc.settings[key]=check.checked;dirty=true;updatePreview();});label.prepend(check);appearance.append(label);}
        form.append(appearance);
        const imported=el('details');imported.append(el('summary','Start from an APStudyCanvas export'));
        imported.append(el('p','Paste a settings backup or theme document. Only supported colors, packaged fonts, and card layout are copied. Course data, GIFs, custom CSS, accounts, and tasks are excluded.','theme-note'));
        const importLabel=el('label','Settings or theme JSON'),input=el('textarea');input.rows=5;input.maxLength=200000;importLabel.append(input);imported.append(importLabel,button('Import appearance',()=>{
            const value=JSON.parse(input.value);const next=value.version===1?core.validate(value):core.fromSettings(value);
            if(dirty&&!confirm('Replace the current appearance draft with this import?'))return;
            doc={...doc,settings:next.settings};mode=core.luminance(doc.settings.dark_mode?doc.settings.dark_preset['background-0']:doc.settings.light_preset['background-0'])<.179?'dark':'light';doc.settings.dark_mode=mode==='dark';dirty=true;draw();status('Appearance imported into your private draft.');
        }));form.append(imported);
        const actions=el('div',undefined,'theme-actions');
        async function save() {
            if(busy)return; if(!form.reportValidity())throw Error('Check the highlighted fields.');
            const value=core.validate(doc);busy=true;form.inert=true;
            try {theme=(await api(id?`/api/themes/${id}`:'/api/themes',id?'PUT':'POST',{document:value,...(id?{expectedRevision:theme.revision}:parent?{remixOf:parent,remixRevision:parentRevision}:{})})).theme;id=theme.id;dirty=false;window.history.replaceState(null,'',`/themes/${id}/edit`);draw();status('Private draft saved.');}
            finally {busy=false;form.inert=false;}
        }
        actions.append(button('Save draft',save,true),button('Submit for approval',async()=>{
            if(busy)return;
            if(dirty||!id){await save();if(dirty||!id)return;}
            theme=(await api(`/api/themes/${id}/submit`,'POST',{expectedRevision:theme.revision})).theme;draw();status('Submitted. An admin must approve this revision before it appears publicly.');
        }),button('Download theme',()=>download(core.validate(doc))));
        if(theme?.status==='pending'){
            form.inert=true;
            panel.append(button('Withdraw to edit',async()=>{theme=(await api(`/api/themes/${id}/withdraw`,'POST',{expectedRevision:theme.revision})).theme;draw();status('Submission withdrawn. You can edit your draft.');}));
        }
        if(theme?.status==='approved')actions.children[1].disabled=true;
        form.append(actions);if(theme)form.append(history(theme));
        const tabs=el('div',undefined,'theme-actions');
        for(const next of ['light','dark']){const tab=button(`Preview ${next}`,()=>{mode=next;draw();});tab.setAttribute('aria-pressed',String(mode===next));tabs.append(tab);}
        panel.append(tabs,live,warnings,button(`Generate ${mode==='light'?'dark':'light'} palette from ${mode}`,()=>{
            if(theme?.status==='pending')throw Error('Withdraw the submission before changing its palette.');
            const target=mode==='light'?'dark':'light';if(!confirm(`Replace the ${target} palette with an automatic conversion?`))return;
            doc.settings[target+'_preset']=core.convert(doc.settings[mode+'_preset'],target);mode=target;dirty=true;draw();status(`${target} palette generated. Review it before saving.`);
        }),el('p','Preview uses illustrative courses. Conversion preserves hue and adjusts surfaces and text for readable contrast. Nothing changes in Canvas until you apply a theme.','theme-note'));
        if(parent||theme?.remixOf)panel.append(el('p',`Remix of ${theme?.remixOf?.name||'the linked approved theme'}. Attribution is preserved automatically.`,'theme-note'));
        if(theme?.publishedRevision)panel.append(link('View approved version',`/themes/${id}`));
        layout.append(form,panel);host.replaceChildren(layout);updatePreview();
    }
    draw();host.setAttribute('aria-busy','false');
}
