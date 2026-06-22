import * as React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1';
import { Command } from 'https://esm.sh/cmdk@1.1.1?deps=react@18.3.1,react-dom@18.3.1';

const h = React.createElement;

export const COMMAND_PALETTE_PAGES = [
  {
    name: 'Dashboard',
    route: '/dashboard',
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
    route: '/tasks',
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
    name: 'Set theme to Obsidian Dark',
    theme: 'obsidian-dark',
    keywords: ['dark', 'theme', 'appearance', 'obsidian'],
  },
  {
    name: 'Set theme to Nest Dark',
    theme: 'nest-dark',
    keywords: ['dark', 'theme', 'appearance', 'nest', 'gold', 'navy'],
  },
  {
    name: 'Set theme to Parchment Light',
    theme: 'parchment-light',
    keywords: ['light', 'theme', 'appearance', 'parchment'],
  },
  {
    name: 'Set theme to Nest Light',
    theme: 'nest-light',
    keywords: ['light', 'theme', 'appearance', 'nest', 'blue', 'gold'],
  },
  {
    name: 'Set theme to auto',
    theme: 'system-match',
    keywords: ['auto', 'system', 'theme', 'appearance', 'preference'],
  },
];

const THEME_STORAGE_KEY = 'apstudy-theme';
const PENDING_THEME_STORAGE_KEY = 'apstudy-theme-pending';
const PENDING_THEME_UPDATED_KEY = 'apstudy-theme-updated-at';
const INTERFACE_THEMES = [
  'obsidian-dark',
  'parchment-light',
  'system-match',
  'nest-light',
  'nest-dark',
];
const THEME_TO_INTERFACE_THEME = {
  dark: 'obsidian-dark',
  light: 'parchment-light',
  system: 'system-match',
};
const DARK_THEMES = ['obsidian-dark', 'nest-dark'];

let root = null;
let setOpenState = null;
let currentOpen = false;
let activeThemeSaveController = null;

function resolveInterfaceTheme(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (INTERFACE_THEMES.includes(normalized)) {
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

function normalizeRoutePath(route) {
  try {
    const url = new URL(route, window.location.origin);
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch (error) {
    return String(route || '').replace(/\/+$/, '') || '/';
  }
}

function isCurrentRoute(route) {
  const targetPath = normalizeRoutePath(route);
  const currentPath = normalizeRoutePath(window.location.pathname || '/');
  return targetPath === currentPath;
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
    const isDark = interfaceTheme === 'system-match'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : DARK_THEMES.includes(interfaceTheme);
    document.documentElement.classList.toggle('dark', isDark);
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
        const isDark = persistedTheme === 'system-match'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : DARK_THEMES.includes(persistedTheme);
        document.documentElement.classList.toggle('dark', isDark);
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
      'h2',
      { className: 'apstudy-visually-hidden' },
      'Command palette',
    ),
    h(
      'p',
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
            if (isCurrentRoute(item.route)) {
              close();
              return;
            }
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
      h(
        'button',
        {
          type: 'button',
          className: 'apstudy-command-palette-close',
          onClick: close,
        },
        h('kbd', null, 'Esc'),
        ' to close',
      ),
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
  const materialIcons = {
    dashboard: 'dashboard',
    calendar: 'calendar_today',
    notes: 'article',
    task: 'check_circle',
    files: 'folder',
    school: 'school',
    settings: 'settings',
    discord: 'forum',
    help: 'help',
    swap: 'swap_horiz',
    message: 'chat_bubble',
  };

  return h(
    'span',
    { className: 'material-symbols-outlined', 'aria-hidden': 'true' },
    materialIcons[name] || materialIcons.message,
  );
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
