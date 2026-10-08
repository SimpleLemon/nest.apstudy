"""Versioned public theme contract. Never accept arbitrary CSS or user records."""
import json
import re

PALETTE_KEYS = ('background-0', 'background-1', 'background-2', 'text-0', 'text-1', 'text-2', 'links', 'borders', 'sidebar', 'sidebar-text')
TAGS = ('minimal', 'colorful', 'study', 'nature', 'pastel', 'dark', 'light', 'other')
FONTS = ('', 'System UI', 'Public Sans', 'Newsreader', 'IBM Plex Mono')
RANGES = {'cardRoundness': (0, 50), 'cardImageRoundness': (0, 48), 'cardPadding': (0, 40), 'cardSpacing': (0, 40)}
BOOLS = ('dark_mode', 'light_palette_enabled', 'wide_course_cards', 'condensed_cards', 'disable_color_overlay', 'customCardStyles')
SETTINGS = set(RANGES) | set(BOOLS) | {'light_preset', 'dark_preset', 'custom_font'}

class ThemeError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def text(value, label, minimum=0, maximum=500):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum or any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise ThemeError(f'{label} must contain {minimum}–{maximum} characters.')
    return value.strip()

def validate_document(value):
    if not isinstance(value, dict) or set(value) != {'version', 'name', 'description', 'creator', 'tags', 'settings'} or type(value.get('version')) is not int or value['version'] != 1:
        raise ThemeError('Use a version 1 APStudy theme document.')
    if len(json.dumps(value)) > 20000:
        raise ThemeError('Theme document is too large.', 413)
    result = {'version': 1, 'name': text(value['name'], 'Name', 1, 80), 'description': text(value['description'], 'Description', 0, 1000), 'creator': text(value['creator'], 'Public creator name', 1, 60)}
    tags = value['tags']
    if not isinstance(tags, list) or len(tags) > 4 or any(not isinstance(t, str) or t not in TAGS for t in tags) or len(set(tags)) != len(tags):
        raise ThemeError('Choose up to four supported tags.')
    result['tags'] = tags
    settings = value['settings']
    if not isinstance(settings, dict) or set(settings) != SETTINGS:
        raise ThemeError('Theme settings must contain only the supported appearance fields.')
    for key in ('light_preset', 'dark_preset'):
        palette = settings[key]
        if not isinstance(palette, dict) or set(palette) != set(PALETTE_KEYS) or any(not isinstance(c, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', c) for c in palette.values()):
            raise ThemeError('Palettes require ten six-digit hex colors.')
    if settings['light_palette_enabled'] is not True or settings['customCardStyles'] is not True:
        raise ThemeError('Public themes must enable their palettes and card styling.')
    for key in BOOLS:
        if type(settings[key]) is not bool:
            raise ThemeError(f'{key} must be a boolean.')
    for key, (low, high) in RANGES.items():
        if type(settings[key]) is not int or not low <= settings[key] <= high:
            raise ThemeError(f'{key} must be between {low} and {high}.')
    font = settings['custom_font']
    if not isinstance(font, dict) or set(font) != {'family', 'link'} or font['family'] not in FONTS or font['link'] != '':
        raise ThemeError('Choose a packaged font. External font links are not supported.')
    result['settings'] = settings
    return result
