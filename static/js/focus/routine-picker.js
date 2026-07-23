const CREATE_ACTION_ID = 'create-new-setup';

export function createRoutinePicker({
  root,
  input,
  createPanel,
  existingActions,
  nameInput,
  onSelect,
  onCreateNew,
} = {}) {
  if (!root || !input) return null;

  const trigger = root.querySelector('[data-focus-combobox-trigger]');
  const menu = root.querySelector('[data-focus-combobox-menu]');
  const labelNode = root.querySelector('[data-focus-combobox-label]');
  const listNode = root.querySelector('[data-focus-combobox-list]');
  if (!trigger || !menu || !labelNode || !listNode) return null;

  let routines = [];
  let isOpen = false;
  let activeIndex = -1;
  let createMode = false;

  function close() {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    listNode.querySelectorAll('.is-focused').forEach((node) => node.classList.remove('is-focused'));
  }

  function open() {
    isOpen = true;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function syncLabel(value) {
    const routine = routines.find((item) => String(item.id) === String(value));
    if (createMode || !value) {
      labelNode.textContent = createMode ? 'Create new setup' : 'Select setup';
      labelNode.classList.add('focus-combobox-placeholder');
      return;
    }
    labelNode.textContent = routine?.name || 'Saved setup';
    labelNode.classList.remove('focus-combobox-placeholder');
  }

  function showCreateMode({ notify = false } = {}) {
    createMode = true;
    if (createPanel) createPanel.hidden = false;
    if (existingActions) existingActions.hidden = true;
    input.value = '';
    syncLabel('');
    listNode.querySelectorAll('[data-value]').forEach((button) => {
      button.setAttribute('aria-selected', 'false');
    });
    if (notify) onCreateNew?.();
    window.setTimeout(() => nameInput?.focus(), 0);
  }

  function applySelection(value) {
    const normalized = String(value || '').trim();
    createMode = false;
    input.value = normalized;
    if (createPanel) createPanel.hidden = true;
    if (existingActions) existingActions.hidden = !normalized;
    listNode.querySelectorAll('[data-value]').forEach((button) => {
      button.setAttribute('aria-selected', button.dataset.value === normalized ? 'true' : 'false');
    });
    syncLabel(normalized);
  }

  function renderOptions() {
    listNode.replaceChildren();
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'focus-combobox-option focus-combobox-quick-action';
    createButton.setAttribute('role', 'option');
    createButton.dataset.quickAction = CREATE_ACTION_ID;
    createButton.textContent = 'Create new setup';
    listNode.append(createButton);

    routines.forEach((routine) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'focus-combobox-option';
      button.setAttribute('role', 'option');
      button.dataset.value = routine.id;
      button.textContent = routine.name;
      button.setAttribute('aria-selected', String(input.value) === String(routine.id) ? 'true' : 'false');
      listNode.append(button);
    });
  }

  function selectValue(value) {
    applySelection(value);
    close();
    onSelect?.(String(value || '').trim());
  }

  function visibleOptions() {
    return [...listNode.querySelectorAll('.focus-combobox-option')].filter((button) => !button.hidden);
  }

  function moveActive(delta) {
    const visible = visibleOptions();
    if (!visible.length) return;
    activeIndex = (activeIndex + delta + visible.length) % visible.length;
    visible.forEach((button, index) => button.classList.toggle('is-focused', index === activeIndex));
    visible[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function activateFocused() {
    const visible = visibleOptions();
    if (activeIndex < 0 || activeIndex >= visible.length) return;
    const button = visible[activeIndex];
    if (button.dataset.quickAction === CREATE_ACTION_ID) {
      close();
      showCreateMode({ notify: true });
      return;
    }
    selectValue(button.dataset.value || '');
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    toggle();
  });

  menu.addEventListener('click', (event) => {
    const quickButton = event.target.closest('[data-quick-action]');
    if (quickButton) {
      event.preventDefault();
      close();
      showCreateMode({ notify: true });
      return;
    }
    const optionButton = event.target.closest('[data-value]');
    if (!optionButton) return;
    event.preventDefault();
    selectValue(optionButton.dataset.value || '');
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) open();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen) open();
      else activateFocused();
    } else if (event.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) {
      close();
      trigger.focus({ preventScroll: true });
    }
  });

  return {
    close,
    enterCreateMode(options) {
      showCreateMode(options);
    },
    getValue() {
      return String(input.value || '').trim();
    },
    isCreateMode() {
      return createMode;
    },
    setRoutines(nextRoutines = [], selectedId = '') {
      routines = Array.isArray(nextRoutines) ? nextRoutines : [];
      renderOptions();
      const current = String(selectedId || input.value || '').trim();
      if (current && routines.some((routine) => String(routine.id) === current)) {
        applySelection(current);
        return;
      }
      if (!routines.length) {
        showCreateMode({ notify: false });
        return;
      }
      applySelection('');
    },
    setValue(value) {
      if (!value) {
        applySelection('');
        return;
      }
      applySelection(value);
    },
  };
}
