import * as React from 'react';

const h = React.createElement;
const PaletteContext = React.createContext(null);

function Dialog({ open, onOpenChange, label, className, children }) {
  const container = React.useRef(null);
  const input = React.useRef(null);
  const items = React.useRef(new Map());
  const selected = React.useRef(null);
  const listId = React.useId();
  const descriptionId = `${listId}-description`;
  const select = React.useCallback((id, scroll = false) => {
    selected.current = id;
    for (const [key, item] of items.current) {
      item.node.setAttribute('aria-selected', String(key === id));
    }
    if (id) input.current?.setAttribute('aria-activedescendant', id);
    else input.current?.removeAttribute('aria-activedescendant');
    if (scroll) items.current.get(id)?.node.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const syncSelection = React.useCallback(() => {
    const rows = container.current?.querySelectorAll('[role="option"]') || [];
    const ids = Array.from(rows, (row) => row.id);
    select(ids.includes(selected.current) ? selected.current : ids[0] || null);
    return ids;
  }, [select]);
  const controls = React.useMemo(() => ({ input, items, select, syncSelection, listId }), [select, syncSelection, listId]);

  React.useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const mount = container.current.closest('#apstudy-command-palette-root');
    const siblings = Array.from(document.body.children)
      .filter((element) => element !== mount && !element.contains(mount));
    const previousState = siblings.map((element) => ({
      element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const { element } of previousState) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    const keepFocusInside = (event) => {
      if (!container.current?.contains(event.target)) input.current?.focus();
    };
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of previousState) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      selected.current = null;
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, [open]);

  function onKeyDown(event) {
    if (event.isComposing || event.nativeEvent?.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(container.current.querySelectorAll('input, button, a[href], [tabindex="0"]'))
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    } else if (event.target === input.current) {
      const ids = syncSelection();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!ids.length) return;
        const index = ids.indexOf(selected.current);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length;
        select(ids[next], true);
      } else if (event.key === 'Enter' && selected.current) {
        event.preventDefault();
        items.current.get(selected.current)?.onSelect();
      }
    }
  }

  if (!open) return null;
  return h(PaletteContext.Provider, { value: controls },
    h('div', { 'cmdk-overlay': '', 'data-state': 'open', 'aria-hidden': 'true', onPointerDown: (event) => { event.preventDefault(); onOpenChange(false); } }),
    h('div', {
      ref: container, 'cmdk-dialog': '', 'data-state': 'open', role: 'dialog',
      'aria-modal': 'true', 'aria-label': label, 'aria-describedby': descriptionId,
      onKeyDown,
    }, h('div', { className, 'cmdk-root': '' },
      h('p', { id: descriptionId, className: 'apstudy-visually-hidden' },
        'Search files, notes, events, messages, courses, and commands.'), children)));
}

function Input({ onValueChange, ...props }) {
  const { input, listId } = React.useContext(PaletteContext);
  return h('input', {
    ...props, ref: input, 'cmdk-input': '', role: 'combobox',
    'aria-label': 'Command palette', 'aria-expanded': 'true', 'aria-controls': listId,
    'aria-autocomplete': 'list', autoComplete: 'off', spellCheck: false,
    onChange: (event) => onValueChange(event.target.value),
  });
}

function List({ children, ...props }) {
  const { listId, syncSelection } = React.useContext(PaletteContext);
  React.useLayoutEffect(() => { syncSelection(); }, [children, syncSelection]);
  return h('div', { ...props, id: listId, 'cmdk-list': '', role: 'listbox', 'aria-label': 'Search results' }, children);
}

function Group({ heading, children }) {
  const id = React.useId();
  return h('div', { 'cmdk-group': '', role: 'group', 'aria-labelledby': id },
    h('div', { id, 'cmdk-group-heading': '', 'aria-hidden': 'true' }, heading), children);
}

function Item({ value, onSelect, children, className }) {
  const { items, select } = React.useContext(PaletteContext);
  const id = React.useId();
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    items.current.set(id, { node: ref.current, onSelect });
    return () => { items.current.delete(id); };
  }, [id, items, onSelect]);
  return h('div', {
    ref, id, className, 'cmdk-item': '', 'data-value': value, role: 'option', 'aria-selected': 'false',
    onPointerMove: () => select(id), onPointerDown: (event) => event.preventDefault(),
    onClick: onSelect,
  }, children);
}

// Attribute names retain the existing palette's CSS contract.
export const Command = { Dialog, Input, List, Group, Item };
