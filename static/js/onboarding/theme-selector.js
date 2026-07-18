const THEME_INPUT_SELECTOR = "[data-theme-input]";

function themeInputs(root) {
    return Array.from(root?.querySelectorAll?.(THEME_INPUT_SELECTOR) || []);
}

function syncThemeCards(inputs, selectedValue) {
    inputs.forEach((input) => {
        const selected = input.value === selectedValue;
        input.checked = selected;
        const card = input.closest?.(".theme-card");
        card?.classList?.toggle("is-selected", selected);
        card?.querySelector?.(".theme-check")?.classList?.toggle("hidden", !selected);
    });
}

export function createThemeSelector(root, { initialTheme = "", onSelect = () => {} } = {}) {
    const inputs = themeInputs(root);
    if (!root || !inputs.length) return null;

    let selectedValue = inputs.some((input) => input.value === initialTheme)
        ? initialTheme
        : inputs.find((input) => input.checked)?.value || inputs[0].value;

    const select = (value, { focus = false, notify = false } = {}) => {
        const nextInput = inputs.find((input) => input.value === value);
        if (!nextInput) return false;
        const changed = selectedValue !== nextInput.value;
        selectedValue = nextInput.value;
        syncThemeCards(inputs, selectedValue);
        if (focus) nextInput.focus({ preventScroll: true });
        if (notify && changed) onSelect(selectedValue);
        return true;
    };

    const onChange = (event) => {
        const input = event.target?.closest?.(THEME_INPUT_SELECTOR);
        if (!input || !root.contains(input) || !input.checked) return;
        select(input.value, { notify: true });
    };

    const onKeyDown = (event) => {
        const input = event.target?.closest?.(THEME_INPUT_SELECTOR);
        if (!input || !root.contains(input)) return;
        const currentIndex = inputs.indexOf(input);
        if (currentIndex < 0) return;

        let nextIndex = currentIndex;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            nextIndex = (currentIndex + 1) % inputs.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            nextIndex = (currentIndex - 1 + inputs.length) % inputs.length;
        } else if (event.key === "Home") {
            nextIndex = 0;
        } else if (event.key === "End") {
            nextIndex = inputs.length - 1;
        } else if (event.key !== " " && event.key !== "Spacebar") {
            return;
        }

        event.preventDefault();
        select(inputs[nextIndex].value, { focus: true, notify: true });
    };

    root.addEventListener("change", onChange);
    root.addEventListener("keydown", onKeyDown);
    select(selectedValue);

    return {
        select,
        value: () => selectedValue,
        destroy() {
            root.removeEventListener("change", onChange);
            root.removeEventListener("keydown", onKeyDown);
        },
    };
}
