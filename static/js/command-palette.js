import * as React from 'https://esm.sh/react@18.3.1?dev';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client?dev&deps=react@18.3.1';
import { Command } from 'https://esm.sh/cmdk@1.1.1?dev&deps=react@18.3.1,react-dom@18.3.1';
import * as Dialog from 'https://esm.sh/@radix-ui/react-dialog@1.1.15?dev&deps=react@18.3.1,react-dom@18.3.1';

const h = React.createElement;

export const COMMAND_PALETTE_PAGES = [
  {
    name: 'Dashboard',
    route: '/calendar',
    icon: 'dashboard',
    keywords: ['home', 'overview', 'calendar', 'assignments', 'courses'],
  },
  {
    name: 'Calendar',
    route: '/calendar',
    icon: 'calendar',
    keywords: ['schedule', 'events', 'week', 'month', 'classes'],
  },
  {
    name: 'Courses',
    route: '/courses',
    icon: 'school',
    keywords: ['emory', 'classes', 'atlas', 'registration', 'seats'],
  },
  {
    name: 'Notes',
    route: '/notes',
    icon: 'notes',
    keywords: ['documents', 'study', 'notebook', 'editor', 'writing'],
  },
  {
    name: 'Tasks',
    route: '/task',
    icon: 'task',
    keywords: ['todo', 'to-do', 'deadline', 'repeat', 'checklist'],
  },
  {
    name: 'Files',
    route: '/files',
    icon: 'files',
    keywords: ['uploads', 'documents', 'share', 'storage', 'downloads'],
  },
  {
    name: 'Chat',
    route: '/chat',
    icon: 'message',
    keywords: ['ai', 'assistant', 'ask', 'conversation', 'help'],
  },
  {
    name: 'Settings',
    route: '/settings',
    icon: 'settings',
    keywords: ['preferences', 'account', 'profile', 'theme', 'appearance'],
  },
];

const HELP_ITEMS = [
  {
    name: 'Join Discord community',
    icon: 'discord',
    href: 'https://discord.com/invite/XaxgdsZ4Ht',
    keywords: ['community', 'discord', 'server', 'support'],
  },
  {
    name: 'Send feedback',
    icon: 'message',
    href: 'mailto:derekchenusa@gmail.com',
    keywords: ['feedback', 'email', 'suggestion', 'message'],
  },
  {
    name: 'Contact support',
    icon: 'help',
    href: 'mailto:derekchenusa@gmail.com',
    keywords: ['support', 'help', 'question', 'contact', 'email'],
  },
];

const THEME_ITEMS = [
  {
    name: 'Set theme to light',
    theme: 'light',
    keywords: ['light', 'theme', 'appearance', 'parchment'],
  },
  {
    name: 'Set theme to dark',
    theme: 'dark',
    keywords: ['dark', 'theme', 'appearance', 'obsidian'],
  },
  {
    name: 'Set theme to auto',
    theme: 'system',
    keywords: ['auto', 'system', 'theme', 'appearance', 'preference'],
  },
];

const THEME_STORAGE_KEY = 'apstudy-theme';
const PENDING_THEME_STORAGE_KEY = 'apstudy-theme-pending';
const PENDING_THEME_UPDATED_KEY = 'apstudy-theme-updated-at';
const THEME_TO_INTERFACE_THEME = {
  dark: 'obsidian-dark',
  light: 'parchment-light',
  system: 'system-match',
};
const INTERFACE_THEME_TO_THEME = {
  'obsidian-dark': 'dark',
  'nest-dark': 'dark',
  'parchment-light': 'light',
  'nest-light': 'light',
  'system-match': 'system',
};

let root = null;
let setOpenState = null;
let currentOpen = false;
let activeThemeSaveController = null;

function resolveInterfaceTheme(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (INTERFACE_THEME_TO_THEME[normalized]) {
    return normalized;
  }
  if (THEME_TO_INTERFACE_THEME[normalized]) {
    return THEME_TO_INTERFACE_THEME[normalized];
  }
  return THEME_TO_INTERFACE_THEME.dark;
}

function warnThemeStorageFailure(action, error) {
  console.warn(`Unable to ${action}; theme switching will continue visually.`, error);
}

function storePendingTheme(interfaceTheme) {
  try {
    localStorage.setItem(PENDING_THEME_STORAGE_KEY, interfaceTheme);
    localStorage.setItem(PENDING_THEME_UPDATED_KEY, String(Date.now()));
  } catch (error) {
    warnThemeStorageFailure('store pending theme preference', error);
  }
}

function clearPendingTheme() {
  try {
    localStorage.removeItem(PENDING_THEME_STORAGE_KEY);
    localStorage.removeItem(PENDING_THEME_UPDATED_KEY);
  } catch (error) {
    warnThemeStorageFailure('clear pending theme preference', error);
  }
}

function ensureMounted() {
  if (root) return;

  const mount = document.createElement('div');
  mount.id = 'apstudy-command-palette-root';
  document.body.appendChild(mount);
  root = createRoot(mount);
  root.render(h(CommandPaletteApp));
}

function setPaletteOpen(nextOpen) {
  currentOpen = Boolean(nextOpen);
  ensureMounted();

  if (typeof setOpenState === 'function') {
    setOpenState(currentOpen);
  }
}

function openExternalLink(href) {
  const opened = window.open(href, '_blank', 'noopener,noreferrer');
  if (!opened) {
    window.location.href = href;
  }
}

function navigateTo(route) {
  window.location.assign(route);
}

async function persistTheme(interfaceTheme) {
  if (!interfaceTheme) {
    return null;
  }

  if (activeThemeSaveController) {
    activeThemeSaveController.abort();
  }

  const controller = new AbortController();
  activeThemeSaveController = controller;

  try {
    const response = await fetch('/settings/api/interface-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface_theme: interfaceTheme }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error('Theme preference was not saved.');
    }

    const payload = await response.json().catch(() => null);
    if (activeThemeSaveController === controller) {
      activeThemeSaveController = null;
    }
    return payload || { interface_theme: interfaceTheme };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return null;
    }
    if (activeThemeSaveController === controller) {
      activeThemeSaveController = null;
    }
    console.warn('Unable to persist command palette theme preference.', error);
    return null;
  }
}

function setTheme(theme) {
  let interfaceTheme = '';
  if (typeof window.APSTUDY_SET_THEME_PREFERENCE === 'function') {
    interfaceTheme = window.APSTUDY_SET_THEME_PREFERENCE(theme);
  }

  if (!interfaceTheme) {
    interfaceTheme = resolveInterfaceTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, interfaceTheme);
    } catch (error) {
      warnThemeStorageFailure('store local theme preference', error);
    }
    document.documentElement.setAttribute('data-theme', interfaceTheme);
    document.documentElement.classList.toggle('dark', interfaceTheme === 'obsidian-dark');
  }

  storePendingTheme(interfaceTheme);
  void persistTheme(interfaceTheme).then((payload) => {
    if (!payload) {
      return;
    }
    clearPendingTheme();
    const persistedTheme = resolveInterfaceTheme(payload.interface_theme || interfaceTheme);
    if (persistedTheme !== interfaceTheme) {
      if (typeof window.APSTUDY_SET_THEME_PREFERENCE === 'function') {
        window.APSTUDY_SET_THEME_PREFERENCE(persistedTheme);
      } else {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, persistedTheme);
        } catch (error) {
          warnThemeStorageFailure('store persisted theme preference', error);
        }
        document.documentElement.setAttribute('data-theme', persistedTheme);
        document.documentElement.classList.toggle('dark', persistedTheme === 'obsidian-dark');
      }
    }
  });
}

function CommandPaletteApp() {
  const [open, setOpen] = React.useState(currentOpen);
  const [search, setSearch] = React.useState('');

  setOpenState = setOpen;
  currentOpen = open;

  React.useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  const close = React.useCallback(() => {
    currentOpen = false;
    setOpen(false);
  }, []);

  return h(
    Command.Dialog,
    {
      label: 'Command palette',
      loop: true,
      className: 'apstudy-command-palette',
      open,
      onOpenChange: (nextOpen) => {
        currentOpen = Boolean(nextOpen);
        setOpen(Boolean(nextOpen));
      },
    },
    h(
      Dialog.Title,
      { className: 'apstudy-visually-hidden' },
      'Command palette',
    ),
    h(
      Dialog.Description,
      { className: 'apstudy-visually-hidden' },
      'Search navigation, help links, and theme commands.',
    ),
    h(
      'div',
      { className: 'apstudy-command-palette-input-row' },
      h(Command.Input, {
        'aria-label': 'Search commands',
        autoFocus: true,
        placeholder: 'Search...',
        value: search,
        onValueChange: setSearch,
      }),
    ),
    h(
      Command.List,
      { className: 'apstudy-command-palette-list' },
      h(
        Command.Empty,
        { className: 'apstudy-command-palette-empty' },
        h('strong', null, 'No results found.'),
        h('span', null, "Try searching for 'settings' or 'theme'."),
      ),
      h(
        Command.Group,
        { heading: 'NAVIGATION' },
        COMMAND_PALETTE_PAGES.map((item) => h(CommandRow, {
          key: `navigation-${item.name}-${item.route}`,
          icon: item.icon,
          label: item.name,
          value: item.name,
          keywords: item.keywords,
          onSelect: () => {
            close();
            navigateTo(item.route);
          },
        })),
      ),
      h(
        Command.Group,
        { heading: 'HELP' },
        HELP_ITEMS.map((item) => h(CommandRow, {
          key: `help-${item.name}`,
          icon: item.icon,
          label: item.name,
          value: item.name,
          keywords: item.keywords,
          onSelect: () => {
            close();
            openExternalLink(item.href);
          },
        })),
      ),
      h(
        Command.Group,
        { heading: 'MISC' },
        THEME_ITEMS.map((item) => h(CommandRow, {
          key: `theme-${item.theme}`,
          icon: 'swap',
          label: item.name,
          value: item.name,
          keywords: item.keywords,
          onSelect: () => {
            close();
            setTheme(item.theme);
          },
        })),
      ),
    ),
    h(
      'div',
      { className: 'apstudy-command-palette-footer' },
      h('span', null, h('kbd', null, 'Enter'), ' to select'),
      h('span', null, h('kbd', null, 'Esc'), ' to close'),
    ),
  );
}

function CommandRow({ icon, label, value, keywords, onSelect }) {
  return h(
    Command.Item,
    {
      className: 'apstudy-command-palette-item',
      keywords,
      value,
      onSelect,
    },
    h('span', { className: 'apstudy-command-palette-item-icon', 'aria-hidden': 'true' }, renderIcon(icon)),
    h('span', { className: 'apstudy-command-palette-item-label' }, label),
  );
}

function renderIcon(name) {
  const iconProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false',
  };

  switch (name) {
    case 'dashboard':
      return h('svg', iconProps,
        h('path', { d: 'M3 11.5 12 4l9 7.5' }),
        h('path', { d: 'M5 10.5V20h14v-9.5' }),
        h('path', { d: 'M9 20v-6h6v6' }),
      );
    case 'calendar':
      return h('svg', iconProps,
        h('path', { d: 'M8 2v4' }),
        h('path', { d: 'M16 2v4' }),
        h('rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }),
        h('path', { d: 'M3 10h18' }),
      );
    case 'notes':
      return h('svg', iconProps,
        h('path', { d: 'M6 3h9l3 3v15H6z' }),
        h('path', { d: 'M14 3v4h4' }),
        h('path', { d: 'M9 13h6' }),
        h('path', { d: 'M9 17h4' }),
      );
    case 'task':
      return h('svg', iconProps,
        h('path', { d: 'M9 11l2 2 4-5' }),
        h('path', { d: 'M5 6h7' }),
        h('path', { d: 'M5 18h10' }),
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
      );
    case 'files':
      return h('svg', iconProps,
        h('path', { d: 'M4 20h16V8h-8l-2-4H4z' }),
        h('path', { d: 'M4 8h16' }),
      );
    case 'school':
      return h('svg', iconProps,
        h('path', { d: 'm3 8 9-4 9 4-9 4-9-4Z' }),
        h('path', { d: 'M7 10.5v4.2c1.3 1.1 3 1.7 5 1.7s3.7-.6 5-1.7v-4.2' }),
        h('path', { d: 'M21 8v6' }),
      );
    case 'settings':
      return h('svg', iconProps,
        h('path', { d: 'M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z' }),
        h('path', { d: 'M19.4 15a1.8 1.8 0 0 0 .36 1.98l.03.03a2.2 2.2 0 1 1-3.11 3.11l-.03-.03a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.5a2.2 2.2 0 1 1-4.4 0v-.12a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-1.98.36l-.03.03a2.2 2.2 0 1 1-3.11-3.11l.03-.03A1.8 1.8 0 0 0 3.4 15a1.8 1.8 0 0 0-1.65-1.09H1.5a2.2 2.2 0 1 1 0-4.4h.25A1.8 1.8 0 0 0 3.4 8.42a1.8 1.8 0 0 0-.36-1.98l-.03-.03A2.2 2.2 0 1 1 6.12 3.3l.03.03a1.8 1.8 0 0 0 1.98.36 1.8 1.8 0 0 0 1.09-1.65V1.8a2.2 2.2 0 1 1 4.4 0v.24a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 1.98-.36l.03-.03a2.2 2.2 0 1 1 3.11 3.11l-.03.03a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.09h.25a2.2 2.2 0 1 1 0 4.4h-.25A1.8 1.8 0 0 0 19.4 15Z' }),
      );
    case 'discord':
      return h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', focusable: 'false' },
        h('path', { d: 'M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a13.78 13.78 0 0 0-.63 1.28 18.4 18.4 0 0 0-5.46 0 12.3 12.3 0 0 0-.64-1.28 19.74 19.74 0 0 0-4.96 1.57C.53 9.01-.32 13.54.1 18a19.9 19.9 0 0 0 6.08 3.08 14.7 14.7 0 0 0 1.3-2.11 12.84 12.84 0 0 1-2.04-.98c.17-.13.34-.26.5-.4a14.15 14.15 0 0 0 12.12 0c.16.14.33.27.5.4-.65.39-1.33.72-2.04.98.37.74.8 1.45 1.3 2.1A19.83 19.83 0 0 0 23.9 18c.5-5.17-.84-9.65-3.58-13.63ZM8.02 15.24c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.96 0c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42s2.18 1.1 2.16 2.42c0 1.34-.95 2.42-2.16 2.42Z' }),
      );
    case 'help':
      return h('svg', iconProps,
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M9.8 9a2.4 2.4 0 0 1 4.55 1.08c0 1.7-2.35 1.94-2.35 3.42' }),
        h('path', { d: 'M12 17h.01' }),
      );
    case 'swap':
      return h('svg', iconProps,
        h('path', { d: 'M7 7h11l-3-3' }),
        h('path', { d: 'M17 17H6l3 3' }),
      );
    case 'message':
    default:
      return h('svg', iconProps,
        h('path', { d: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z' }),
      );
  }
}

export const commandPalette = {
  open() {
    setPaletteOpen(true);
  },
  close() {
    setPaletteOpen(false);
  },
  toggle() {
    setPaletteOpen(!currentOpen);
  },
};

window.APSTUDY_COMMAND_PALETTE = commandPalette;
