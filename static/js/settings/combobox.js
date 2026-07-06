(function registerSettingsCombobox(global) {
  const CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-combobox-chevron" aria-hidden="true"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg>';

  const mountedComboboxes = new Set();

  function normalizeSearchTerm(value) {
    return String(value || '').trim().toLowerCase();
  }

  function mountSettingsCombobox({
    root,
    input,
    placeholder = 'Select option',
    searchable = false,
    options = [],
    quickActions = [],
    resolveQuickActionValue,
    onSelect,
  }) {
    if (!root || !input) {
      return null;
    }

    let trigger = root.querySelector('[data-settings-combobox-trigger]');
    let menu = root.querySelector('[data-settings-combobox-menu]');
    let labelNode = root.querySelector('[data-settings-combobox-label]');
    let searchInput = root.querySelector('[data-settings-combobox-search]');
    let listNode = root.querySelector('[data-settings-combobox-list]');

    if (!trigger) {
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'settings-combobox-trigger';
      trigger.setAttribute('data-settings-combobox-trigger', '');
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      labelNode = document.createElement('span');
      labelNode.setAttribute('data-settings-combobox-label', '');
      labelNode.className = 'settings-combobox-placeholder';
      labelNode.textContent = placeholder;
      trigger.append(labelNode);
      trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);
      root.append(trigger);
    }

    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'settings-combobox-menu';
      menu.setAttribute('data-settings-combobox-menu', '');
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;
      root.append(menu);
    }

    if (!labelNode) {
      labelNode = trigger.querySelector('[data-settings-combobox-label]');
    }

    if (searchable && !searchInput) {
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'settings-combobox-search';
      searchInput.setAttribute('data-settings-combobox-search', '');
      searchInput.setAttribute('aria-label', 'Search options');
      searchInput.placeholder = 'Search…';
      menu.append(searchInput);
    }

    if (!listNode) {
      listNode = document.createElement('div');
      listNode.className = 'settings-combobox-list';
      listNode.setAttribute('data-settings-combobox-list', '');
      menu.append(listNode);
    }

    const optionButtons = [];
    const optionMap = new Map();

    function renderOptions(nextOptions) {
      listNode.innerHTML = '';
      optionButtons.length = 0;
      optionMap.clear();

      quickActions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-combobox-option settings-combobox-quick-action';
        button.setAttribute('role', 'option');
        button.setAttribute('data-quick-action', action.id || action.label);
        button.textContent = action.label;
        listNode.append(button);
      });

      nextOptions.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-combobox-option';
        button.setAttribute('role', 'option');
        button.dataset.value = option.value;
        button.textContent = option.label;
        listNode.append(button);
        optionButtons.push(button);
        optionMap.set(option.value, option);
      });
    }

    if (options.length) {
      renderOptions(options);
    } else {
      listNode.querySelectorAll('.settings-combobox-option[data-value]').forEach((button) => {
        const value = button.dataset.value || '';
        const label = button.textContent.trim();
        optionButtons.push(button);
        optionMap.set(value, { value, label });
      });
    }

    let activeIndex = -1;
    let isOpen = false;
    let searchTerm = '';

    function visibleOptions() {
      return optionButtons.filter((button) => !button.hidden);
    }

    function optionLabel(value) {
      const option = optionMap.get(value);
      return option ? option.label : value;
    }

    function syncLabel(value) {
      const normalized = String(value || '').trim();
      if (!labelNode) {
        return;
      }
      if (!normalized) {
        labelNode.textContent = placeholder;
        labelNode.classList.add('settings-combobox-placeholder');
        return;
      }
      labelNode.textContent = optionLabel(normalized) || normalized;
      labelNode.classList.remove('settings-combobox-placeholder');
    }

    function syncSelection(value) {
      const normalized = String(value || '').trim();
      optionButtons.forEach((button) => {
        const selected = (button.dataset.value || '') === normalized;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      syncLabel(normalized);
    }

    function setValue(value) {
      const normalized = String(value || '').trim();
      input.value = normalized;
      syncSelection(normalized);
    }

    function getValue() {
      return String(input.value || '').trim();
    }

    function close() {
      if (!isOpen) {
        return;
      }
      isOpen = false;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      activeIndex = -1;
      if (searchInput) {
        searchInput.value = '';
        searchTerm = '';
        applyFilter('');
      }
    }

    function open() {
      mountedComboboxes.forEach((combobox) => {
        if (combobox !== api && typeof combobox.close === 'function') {
          combobox.close();
        }
      });
      isOpen = true;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      if (searchable && searchInput) {
        searchInput.focus({ preventScroll: true });
      }
    }

    function toggle() {
      if (isOpen) {
        close();
      } else {
        open();
      }
    }

    function applyFilter(term) {
      searchTerm = normalizeSearchTerm(term);
      optionButtons.forEach((button) => {
        const label = button.textContent.trim().toLowerCase();
        const value = String(button.dataset.value || '').toLowerCase();
        const matches = !searchTerm || label.includes(searchTerm) || value.includes(searchTerm);
        button.hidden = !matches;
      });
      activeIndex = -1;
    }

    function selectValue(value) {
      setValue(value);
      close();
      if (typeof onSelect === 'function') {
        onSelect(value);
      }
    }

    function moveActive(delta) {
      const visible = visibleOptions();
      if (!visible.length) {
        return;
      }
      activeIndex = (activeIndex + delta + visible.length) % visible.length;
      visible.forEach((button, index) => {
        button.classList.toggle('is-focused', index === activeIndex);
      });
      visible[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function selectActive() {
      const visible = visibleOptions();
      if (activeIndex < 0 || activeIndex >= visible.length) {
        return;
      }
      const button = visible[activeIndex];
      if (button.dataset.quickAction) {
        const action = quickActions.find((item) => (item.id || item.label) === button.dataset.quickAction);
        if (action && typeof resolveQuickActionValue === 'function') {
          const resolved = resolveQuickActionValue(action);
          if (resolved) {
            selectValue(resolved);
          }
        }
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
        const action = quickActions.find((item) => (item.id || item.label) === quickButton.dataset.quickAction);
        if (action && typeof resolveQuickActionValue === 'function') {
          const resolved = resolveQuickActionValue(action);
          if (resolved) {
            selectValue(resolved);
          }
        }
        return;
      }
      const optionButton = event.target.closest('[data-value]');
      if (!optionButton || optionButton.hidden) {
        return;
      }
      event.preventDefault();
      selectValue(optionButton.dataset.value || '');
    });

    searchInput?.addEventListener('input', (event) => {
      applyFilter(event.target.value);
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        selectActive();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger.focus({ preventScroll: true });
      }
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) {
          open();
        }
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!isOpen) {
          open();
        } else {
          selectActive();
        }
      } else if (event.key === 'Escape') {
        close();
      }
    });

    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        close();
        trigger.focus({ preventScroll: true });
      }
    });

    const api = {
      root,
      input,
      close,
      open,
      setValue,
      getValue,
      setOptions(nextOptions) {
        renderOptions(nextOptions);
        syncSelection(getValue());
      },
    };

    mountedComboboxes.add(api);
    syncSelection(getValue());

    return api;
  }

  global.APStudySettingsCombobox = {
    mountSettingsCombobox,
  };
})(window);
