import * as React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1';
import { Command } from 'https://esm.sh/cmdk@1.1.1?deps=react@18.3.1,react-dom@18.3.1';
import {
  COMMAND_SEARCH_DEBOUNCE_MS,
  COMMAND_SEARCH_MIN_LENGTH,
  emptyWorkspaceGroups,
  fetchWorkspaceSearch,
} from './command-palette-search.js';
import { renderWorkspaceResults } from './command-palette-workspace.js';

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
    icon: 'calendar_month',
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
    name: 'Focus Mode',
    route: '/focus',
    icon: 'dark_mode',
    keywords: ['timer', 'pomodoro', 'study', 'spotify', 'break'],
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
    icon: 'forum',
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
  if (!window.APStudyNavigation?.go?.(route)) {
    window.location.assign(route);
  }
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
  const [workspaceGroups, setWorkspaceGroups] = React.useState(emptyWorkspaceGroups);
  const [coursesEnabled, setCoursesEnabled] = React.useState(false);
  const [unavailableCategories, setUnavailableCategories] = React.useState([]);
  const [searchStatus, setSearchStatus] = React.useState('idle');
  const requestSequence = React.useRef(0);

  setOpenState = setOpen;
  currentOpen = open;

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setWorkspaceGroups(emptyWorkspaceGroups());
      setUnavailableCategories([]);
      setSearchStatus('idle');
    }
  }, [open]);

  React.useEffect(() => {
    const query = search.trim();
    if (!open || query.length < COMMAND_SEARCH_MIN_LENGTH) {
      requestSequence.current += 1;
      setWorkspaceGroups(emptyWorkspaceGroups());
      setUnavailableCategories([]);
      setSearchStatus('idle');
      return undefined;
    }

    const controller = new AbortController();
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setWorkspaceGroups(emptyWorkspaceGroups());
    setUnavailableCategories([]);
    setSearchStatus('loading');
    const timer = window.setTimeout(() => {
      fetchWorkspaceSearch(query, { signal: controller.signal })
        .then((payload) => {
          if (requestSequence.current !== sequence) return;
          setWorkspaceGroups(payload.groups);
          setCoursesEnabled(payload.coursesEnabled);
          setUnavailableCategories(payload.unavailableCategories);
          setSearchStatus('ready');
        })
        .catch((error) => {
          if (error?.name === 'AbortError' || requestSequence.current !== sequence) return;
          setWorkspaceGroups(emptyWorkspaceGroups());
          setUnavailableCategories([]);
          setSearchStatus('error');
        });
    }, COMMAND_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, search]);

  const close = React.useCallback(() => {
    currentOpen = false;
    setOpen(false);
  }, []);

  const workspaceMode = search.trim().length >= COMMAND_SEARCH_MIN_LENGTH;
  const matchingCommands = workspaceMode ? getMatchingCommands(search) : [];
  const resultCount = Object.values(workspaceGroups).reduce((total, items) => total + items.length, 0);
  const liveMessage = searchStatus === 'loading'
    ? 'Searching your workspace.'
    : searchStatus === 'ready'
      ? `${resultCount} workspace result${resultCount === 1 ? '' : 's'} found.`
      : searchStatus === 'error'
        ? 'Workspace search is unavailable.'
        : '';

  return h(
    Command.Dialog,
    {
      label: 'Command palette',
      loop: true,
      shouldFilter: !workspaceMode,
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
      'Search files, notes, events, messages, courses, and commands.',
    ),
    h(
      'div',
      { className: 'apstudy-command-palette-input-row' },
      h(Command.Input, {
        'aria-label': 'Search anything in Nest',
        autoFocus: true,
        placeholder: 'Search anything in Nest',
        value: search,
        onValueChange: setSearch,
      }),
    ),
    h('p', { className: 'apstudy-visually-hidden', 'aria-live': 'polite' }, liveMessage),
    h(
      Command.List,
      { className: 'apstudy-command-palette-list' },
      workspaceMode
        ? renderWorkspaceResults({
          groups: workspaceGroups,
          coursesEnabled,
          searchStatus,
          unavailableCategories,
          commandRows: matchingCommands.map((item) => item.render(close)),
          onOpenResult: (result) => {
            close();
            navigateTo(result.href);
          },
          renderIcon,
        })
        : renderDefaultCommands(close),
    ),
    h(
      'div',
      { className: 'apstudy-command-palette-footer' },
      h('span', null, h('kbd', null, '↑↓'), ' navigate'),
      h('span', null, h('kbd', null, 'Enter'), ' open'),
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

function renderDefaultCommands(close) {
  return [
    h(Command.Empty, { className: 'apstudy-command-palette-empty', key: 'empty' },
      h('strong', null, 'No commands found.'),
      h('span', null, "Try searching for 'settings' or 'theme'.")),
    h(Command.Group, { heading: 'Navigation', key: 'navigation' },
      COMMAND_PALETTE_PAGES.map((item) => renderPageCommand(item, close))),
    h(Command.Group, { heading: 'Help', key: 'help' },
      HELP_ITEMS.map((item) => renderHelpCommand(item, close))),
    h(Command.Group, { heading: 'Appearance', key: 'appearance' },
      THEME_ITEMS.map((item) => renderThemeCommand(item, close))),
  ];
}

function commandMatches(item, query) {
  const haystack = [item.name, ...(item.keywords || [])].join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every((token) => haystack.includes(token));
}

function getMatchingCommands(query) {
  return [
    ...COMMAND_PALETTE_PAGES.map((item) => ({ ...item, render: (close) => renderPageCommand(item, close) })),
    ...HELP_ITEMS.map((item) => ({ ...item, render: (close) => renderHelpCommand(item, close) })),
    ...THEME_ITEMS.map((item) => ({ ...item, render: (close) => renderThemeCommand(item, close) })),
  ].filter((item) => commandMatches(item, query));
}

function renderPageCommand(item, close) {
  return h(CommandRow, {
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
  });
}

function renderHelpCommand(item, close) {
  return h(CommandRow, {
    key: `help-${item.name}`,
    icon: item.icon,
    label: item.name,
    value: item.name,
    keywords: item.keywords,
    onSelect: () => {
      close();
      openExternalLink(item.href);
    },
  });
}

function renderThemeCommand(item, close) {
  return h(CommandRow, {
    key: `theme-${item.theme}`,
    icon: 'swap_vert',
    label: item.name,
    value: item.name,
    keywords: item.keywords,
    onSelect: () => {
      close();
      setTheme(item.theme);
    },
  });
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
    calendar_month: 'calendar_month',
    calendar_today: 'calendar_today',
    notes: 'article',
    article: 'article',
    task: 'check_circle',
    files: 'folder',
    folder: 'folder',
    description: 'description',
    school: 'school',
    settings: 'settings',
    discord: 'forum',
    forum: 'forum',
    help: 'help',
    swap: 'swap_horiz',
    swap_vert: 'swap_vert',
    message: 'chat_bubble',
    chat_bubble: 'chat_bubble',
    dark_mode: 'dark_mode',
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
