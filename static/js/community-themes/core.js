/* Shared portable theme contract and palette conversion. Also shipped by Nest. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.APStudyTheme = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const paletteKeys = ['background-0', 'background-1', 'background-2', 'text-0', 'text-1', 'text-2', 'links', 'borders', 'sidebar', 'sidebar-text'];
    const tags = ['minimal', 'colorful', 'study', 'nature', 'pastel', 'dark', 'light', 'other'];
    const fonts = ['', 'System UI', 'Public Sans', 'Newsreader', 'IBM Plex Mono'];
    const ranges = { cardRoundness: [0, 50], cardImageRoundness: [0, 48], cardPadding: [0, 40], cardSpacing: [0, 40] };
    const booleans = ['dark_mode', 'light_palette_enabled', 'wide_course_cards', 'condensed_cards', 'disable_color_overlay', 'customCardStyles'];
    const settingsKeys = [...Object.keys(ranges), ...booleans, 'light_preset', 'dark_preset', 'custom_font'];
    const clone = value => JSON.parse(JSON.stringify(value));
    const plain = value => value && typeof value === 'object' && !Array.isArray(value);
    function paletteValid(palette) {
        return plain(palette) && Object.keys(palette).length === paletteKeys.length && paletteKeys.every(k => /^#[\da-f]{6}$/i.test(palette[k]));
    }
    function luminance(hex) {
        const rgb = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    }
    function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
    function hsl(hex) {
        const [r, g, b] = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, l = (max + min) / 2;
        let h = 0;
        if (delta) h = max === r ? ((g - b) / delta + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / delta + 2) / 6 : ((r - g) / delta + 4) / 6;
        return [h, delta ? delta / (1 - Math.abs(2 * l - 1)) : 0, l];
    }
    function tint(hex, lightness, saturation = 1) {
        const [h, s] = hsl(hex), a = Math.min(s * saturation, .8) * Math.min(lightness, 1 - lightness);
        const channel = n => { const k = (n + h * 12) % 12; return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
        return '#' + channel(0) + channel(8) + channel(4);
    }
    function convert(palette, mode) {
        if (!paletteValid(palette) || !['light', 'dark'].includes(mode)) throw Error('Invalid palette.');
        const dark = mode === 'dark', output = {};
        const lightness = dark ? [.07, .11, .16, .96, .9, .78, .76, .4, .1, .96] : [.97, .99, .93, .08, .16, .28, .29, .57, .95, .08];
        paletteKeys.forEach((key, i) => { output[key] = tint(palette[key], lightness[i], key === 'links' ? 1 : .6); });
        const backgrounds = ['background-0', 'background-1', 'background-2'].map(k => output[k]);
        ['text-0', 'text-1', 'text-2', 'links', 'sidebar-text'].forEach(key => {
            const surfaces = key === 'sidebar-text' ? [output.sidebar] : backgrounds;
            for (let step = 0; step <= 100 && surfaces.some(bg => contrast(output[key], bg) < 4.5); step++) {
                output[key] = tint(palette[key], dark ? Math.min(1, lightness[paletteKeys.indexOf(key)] + step / 100) : Math.max(0, lightness[paletteKeys.indexOf(key)] - step / 100));
            }
        });
        return output;
    }
    function contrastWarnings(palette) {
        if (!paletteValid(palette)) return ['Invalid palette'];
        const warnings = [];
        ['text-0', 'text-1', 'text-2', 'links'].forEach(key => {
            if (['background-0', 'background-1', 'background-2'].some(bg => contrast(palette[key], palette[bg]) < 4.5)) warnings.push(key);
        });
        if (contrast(palette['sidebar-text'], palette.sidebar) < 4.5) warnings.push('sidebar-text');
        return warnings;
    }
    function defaults() {
        const dark = { 'background-0': '#161616', 'background-1': '#1e1e1e', 'background-2': '#262626', 'text-0': '#f5f5f5', 'text-1': '#e2e2e2', 'text-2': '#ababab', links: '#56caf0', borders: '#3c3c3c', sidebar: '#1e1e1e', 'sidebar-text': '#f5f5f5' };
        return { version: 1, name: '', description: '', creator: '', tags: [], settings: { light_preset: convert(dark, 'light'), dark_preset: dark, custom_font: { family: '', link: '' }, dark_mode: false, light_palette_enabled: true, wide_course_cards: false, condensed_cards: false, disable_color_overlay: false, customCardStyles: true, cardRoundness: 5, cardImageRoundness: 0, cardPadding: 0, cardSpacing: 0 } };
    }
    function validate(value) {
        if (!plain(value) || Object.keys(value).sort().join() !== ['version','name','description','creator','tags','settings'].sort().join() || value.version !== 1) throw Error('Use a version 1 APStudy theme document.');
        for (const [key, min, max] of [['name',1,80],['description',0,1000],['creator',1,60]]) if (typeof value[key] !== 'string' || value[key].trim().length < min || value[key].trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value[key])) throw Error(`Check the ${key}.`);
        if (!Array.isArray(value.tags) || value.tags.length > 4 || new Set(value.tags).size !== value.tags.length || value.tags.some(t => !tags.includes(t))) throw Error('Choose up to four supported tags.');
        const settings = value.settings;
        if (!plain(settings) || Object.keys(settings).sort().join() !== settingsKeys.slice().sort().join()) throw Error('Unsupported theme settings.');
        if (!paletteValid(settings.light_preset) || !paletteValid(settings.dark_preset)) throw Error('Use six-digit hex colors for all palette fields.');
        if (settings.light_palette_enabled !== true || settings.customCardStyles !== true) throw Error('Public themes must enable their palettes and card styling.');
        if (booleans.some(k => typeof settings[k] !== 'boolean') || Object.entries(ranges).some(([k,[min,max]]) => !Number.isInteger(settings[k]) || settings[k] < min || settings[k] > max)) throw Error('Invalid layout settings.');
        if (!plain(settings.custom_font) || Object.keys(settings.custom_font).sort().join() !== 'family,link' || !fonts.includes(settings.custom_font.family) || settings.custom_font.link !== '') throw Error('Use a packaged font.');
        return clone(value);
    }
    // Only portable appearance preferences are copied from a full settings backup.
    function fromSettings(settings) {
        if (!plain(settings)) throw Error('Paste an APStudyCanvas settings object.');
        const result = defaults();
        settingsKeys.forEach(key => { if (Object.hasOwn(settings, key)) result.settings[key] = clone(settings[key]); });
        result.settings.light_palette_enabled = true;
        result.settings.customCardStyles = true;
        validate({ ...result, name: 'Import', creator: 'Import' });
        return result;
    }
    return Object.freeze({ paletteKeys, tags, fonts, ranges, settingsKeys, paletteValid, luminance, contrast, contrastWarnings, convert, defaults, validate, fromSettings });
}));
