import { normalizeRange, clamp } from "./admin-analytics-model.js";
function initAnalyticsRangeDropdown(root, { defaultRange = "30d", onChange } = {}) {
  let dropdown = root.matches?.("[data-analytics-range-dropdown], [data-analytics-detail-range-dropdown]") ? root : null;
  if (!dropdown) {
    dropdown = root.querySelector("[data-analytics-range-dropdown]")
      || root.querySelector("[data-analytics-detail-range-dropdown]");
  }
  if (!dropdown) return null;

  const trigger = dropdown.querySelector("[data-analytics-range-trigger]");
  const menu = dropdown.querySelector("[data-analytics-range-menu]");
  const labelEl = dropdown.querySelector("[data-analytics-range-label]");
  const options = Array.from(dropdown.querySelectorAll("[data-analytics-range]"));
  let activeRange = normalizeRange(defaultRange);
  let open = false;
  let focusedIndex = -1;

  const updateMenuPlacement = () => {
    if (!trigger || !menu || menu.hidden) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 240;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const shouldFlip = spaceBelow < menuHeight + 12 && spaceAbove > spaceBelow;
    dropdown.classList.toggle("is-flipped", shouldFlip);
  };

  const syncActiveDescendant = () => {
    const focused = options[focusedIndex];
    if (focused?.id) {
      trigger?.setAttribute("aria-activedescendant", focused.id);
    } else {
      trigger?.removeAttribute("aria-activedescendant");
    }
  };

  const focusOption = (index) => {
    if (!options.length) return;
    focusedIndex = clamp(index, 0, options.length - 1);
    options[focusedIndex]?.focus();
    syncActiveDescendant();
  };

  const setOpen = (next) => {
    const willOpen = Boolean(next);
    if (willOpen === open) return;
    open = willOpen;
    dropdown.classList.toggle("is-open", open);
    if (menu) menu.hidden = !open;
    trigger?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      focusedIndex = Math.max(0, options.findIndex((option) => option.dataset.analyticsRange === activeRange));
      requestAnimationFrame(() => {
        updateMenuPlacement();
        focusOption(focusedIndex);
      });
      window.addEventListener("resize", updateMenuPlacement);
    } else {
      focusedIndex = -1;
      trigger?.removeAttribute("aria-activedescendant");
      dropdown.classList.remove("is-flipped");
      window.removeEventListener("resize", updateMenuPlacement);
      trigger?.focus();
    }
  };

  const syncSelection = () => {
    options.forEach((option) => {
      const selected = option.dataset.analyticsRange === activeRange;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
    });
    const activeOption = options.find((option) => option.dataset.analyticsRange === activeRange);
    if (labelEl && activeOption) labelEl.textContent = activeOption.textContent.trim();
  };

  const selectRange = (range) => {
    const nextRange = normalizeRange(range, defaultRange);
    if (nextRange === activeRange) {
      setOpen(false);
      return;
    }
    activeRange = nextRange;
    syncSelection();
    setOpen(false);
    onChange?.(activeRange);
  };

  trigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!open);
  });

  menu?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  options.forEach((option, index) => {
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      selectRange(option.dataset.analyticsRange);
    });
    option.addEventListener("focus", () => {
      focusedIndex = index;
      syncActiveDescendant();
    });
  });

  const handleDocumentClick = (event) => {
    if (!open) return;
    if (!dropdown.contains(event.target)) setOpen(false);
  };

  const handleDocumentKeydown = (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(focusedIndex < 0 ? 0 : focusedIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(focusedIndex < 0 ? options.length - 1 : focusedIndex - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const active = document.activeElement;
      if (active && options.includes(active)) {
        event.preventDefault();
        selectRange(active.dataset.analyticsRange);
      }
    }
  };

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);

  if (menu) menu.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  dropdown.classList.remove("is-open", "is-flipped");
  syncSelection();

  return {
    destroy() {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeydown);
      window.removeEventListener("resize", updateMenuPlacement);
    },
    getActiveRange: () => activeRange,
    isOpen: () => open,
    selectRange,
    setActiveRange(range) {
      activeRange = normalizeRange(range, defaultRange);
      syncSelection();
    },
    setOpen,
    updateMenuPlacement,
  };
}

export { initAnalyticsRangeDropdown };
