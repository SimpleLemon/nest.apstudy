import * as React from "react";

import {
    DEFAULT_LIST_NAMES,
    PRIORITY_OPTIONS,
    REPEAT_UNITS,
    createDefaultRecurrence,
    defaultRecurrenceEndDate,
    formatDeadline,
    formatRepeat,
    isRepeatingTaskCompleted,
    isoToLocalInput,
    localInputToIso,
    splitTasksByCompletion,
    sortedLists,
    todayDateString,
} from "./task-utils.js";

const h = React.createElement;

export function MaterialIcon({ name, className = "" }) {
    return h("span", { className: `material-symbols-outlined ${className}`, "aria-hidden": "true" }, name);
}

function cx(...parts) {
    return parts.filter(Boolean).join(" ");
}

function optionNodes(options) {
    return options.map((option) => h("option", { key: option.value, value: option.value }, option.label));
}

function iconButton({ icon, label, className = "", active = false, triggerKey = "", title = label, ...props }) {
    const triggerProps = triggerKey ? { "data-task-menu-trigger": triggerKey } : {};
    return h("button", {
        type: "button",
        className: cx("task-icon-button", className, active && "is-on"),
        "aria-label": label,
        title,
        ...triggerProps,
        ...props,
    }, h(MaterialIcon, { name: icon }));
}

function buttonWithIcon({ icon, children, className, ...props }) {
    return h("button", { type: "button", className, ...props },
        h(MaterialIcon, { name: icon }),
        h("span", null, children)
    );
}

function menuTrigger({ id, kind, className, label, onOpen, stopPropagation = false, getPosition = menuAnchorFromEvent }) {
    return iconButton({
        icon: "more_vert",
        label,
        className,
        triggerKey: `${kind}:${id}`,
        onClick: (event) => {
            if (stopPropagation) event.stopPropagation();
            onOpen(id, getPosition(event));
        },
    });
}

function railButton({ active, icon, label, count, onClick }) {
    return h("button", {
        type: "button",
        className: cx("task-rail-primary", active && "is-active"),
        onClick,
    },
        h(MaterialIcon, { name: icon }),
        h("span", null, label),
        h("strong", null, count)
    );
}

function useSortable(ref, options, dependencies) {
    React.useEffect(() => {
        if (!ref.current || typeof window.Sortable === "undefined") return undefined;
        const sortable = window.Sortable.create(ref.current, options());
        return () => sortable.destroy();
    }, dependencies);
}

function actionMenuItem(item, index, onClose) {
    if (item.separator) {
        return h("div", { key: `sep-${index}`, className: "task-action-menu-separator", role: "separator" });
    }
    return h("button", {
        key: `${item.label}-${index}`,
        type: "button",
        role: "menuitem",
        className: cx(item.danger && "is-danger", item.checked && "is-checked"),
        disabled: item.disabled,
        "aria-checked": item.checked ? "true" : undefined,
        onClick: () => {
            onClose();
            item.onClick?.();
        },
    },
        h(MaterialIcon, { name: item.checked ? "check" : item.icon || "radio_button_unchecked" }),
        h("span", null, item.label)
    );
}

function prioritySelect(value, onChange) {
    return h("select", { value, onChange: (event) => onChange(event.target.value) }, optionNodes(PRIORITY_OPTIONS));
}

function recurrenceFields(recurrence, onChange, { compact = false, endName = "repeat-end" } = {}) {
    const update = (updates) => onChange({ ...recurrence, ...updates });
    const onDate = Boolean(recurrence.endDate);
    const onDateValue = recurrence.endDate || defaultRecurrenceEndDate();

    return h("div", { className: cx("task-repeat-grid", compact && "task-repeat-grid-compact") },
        h("label", { className: "task-repeat-every-field" },
            h("span", null, "Every"),
            h("input", {
                type: "number",
                min: "1",
                max: "365",
                value: recurrence.every || 1,
                onChange: (event) => update({ every: Number(event.target.value || 1) }),
                "aria-label": compact ? "Repeat every" : undefined,
            })
        ),
        h("label", { className: "task-repeat-unit-field" },
            h("span", null, "Unit"),
            h("select", {
                value: recurrence.unit || "week",
                onChange: (event) => update({ unit: event.target.value }),
                "aria-label": compact ? "Repeat unit" : undefined,
            }, optionNodes(REPEAT_UNITS))
        ),
        h("label", { className: "task-repeat-start-field" },
            h("span", null, "Starts"),
            h("input", {
                type: "date",
                value: recurrence.startDate || todayDateString(),
                onChange: (event) => update({ startDate: event.target.value || todayDateString() }),
                "aria-label": compact ? "Repeat start date" : undefined,
            })
        ),
        h("fieldset", { className: "task-repeat-end-field" },
            h("legend", null, "End"),
            h("div", { className: "task-repeat-end-options" },
                h("label", { className: cx("task-repeat-end-option", !onDate && "is-selected") },
                    h("input", {
                        type: "radio",
                        name: endName,
                        checked: !onDate,
                        onChange: () => update({ endDate: null }),
                    }),
                    h("span", null, "Never")
                ),
                h("label", { className: cx("task-repeat-end-option", onDate && "is-selected") },
                    h("input", {
                        type: "radio",
                        name: endName,
                        checked: onDate,
                        onChange: () => update({ endDate: onDateValue }),
                    }),
                    h("span", null, "On"),
                    h("input", {
                        type: "date",
                        value: onDateValue,
                        disabled: !onDate,
                        onFocus: () => {
                            if (!onDate) update({ endDate: onDateValue });
                        },
                        onChange: (event) => update({ endDate: event.target.value || defaultRecurrenceEndDate() }),
                        "aria-label": "Repeat end date",
                    })
                )
            )
        )
    );
}

function RepeatMenuContent({ recurrence, onChange, onCancel, onDone }) {
    const endName = React.useId();
    return h("div", { className: "task-add-repeat-popover" },
        recurrenceFields(recurrence, onChange, { compact: true, endName }),
        h("div", { className: "task-add-popover-actions" },
            h("button", { type: "button", className: "task-secondary-button", onClick: onCancel }, "Cancel"),
            h("button", { type: "button", className: "task-primary-button", onClick: onDone }, "Done")
        )
    );
}

export function EmptyStarter({ onCreate }) {
    return h("section", { className: "task-empty-panel" },
        h("div", { className: "task-empty-icon" }, h(MaterialIcon, { name: "checklist" })),
        h("h2", null, "Start with a list"),
        h("p", null, "Create a named list for school, research, personal work, or anything else you want to keep moving."),
        h("div", { className: "task-empty-actions" },
            buttonWithIcon({ className: "task-primary-button", icon: "add", onClick: () => onCreate({ mode: "create" }), children: "Create new list" }),
            DEFAULT_LIST_NAMES.map((name) => h("button", { key: name, type: "button", onClick: () => onCreate({ mode: "quick", name }) }, name))
        )
    );
}

export function ActionMenu({ menu, onClose }) {
    const menuRef = React.useRef(null);
    const menuKey = menu ? `${menu.type || "menu"}:${menu.id || "none"}:${menu.nonce || 0}` : "";
    const [position, setPosition] = React.useState({ key: "", top: 0, left: 0, ready: false });

    React.useEffect(() => {
        if (!menu) return undefined;
        const onPointerDown = (event) => {
            if (menuRef.current?.contains(event.target)) return;
            if (event.target?.closest?.("[data-task-menu-trigger]")) return;
            onClose();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape") onClose();
        };
        const onScroll = () => onClose();
        const onResize = () => onClose();
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onResize);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
        };
    }, [menu, onClose]);

    React.useLayoutEffect(() => {
        if (!menu || !menuRef.current) return;
        const menuRect = menuRef.current.getBoundingClientRect();
        const anchor = menu.anchor || {
            top: menu.top || 0,
            bottom: menu.top || 0,
            left: menu.left || 0,
            right: menu.left || 0,
        };
        const gap = 6;
        const margin = 8;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let left = anchor.right - menuRect.width;
        if (left < margin && anchor.left + menuRect.width <= viewportWidth - margin) {
            left = anchor.left;
        }
        left = Math.max(margin, Math.min(viewportWidth - menuRect.width - margin, left));

        let top = anchor.bottom + gap;
        const aboveTop = anchor.top - menuRect.height - gap;
        if (top + menuRect.height > viewportHeight - margin && aboveTop >= margin) {
            top = aboveTop;
        }
        top = Math.max(margin, Math.min(viewportHeight - menuRect.height - margin, top));

        setPosition({ key: menuKey, top, left, ready: true });
    }, [menu, menuKey]);

    if (!menu) return null;
    const ready = position.key === menuKey && position.ready;
    return h("div", {
        ref: menuRef,
        className: "task-action-menu",
        role: "menu",
        style: {
            top: `${ready ? position.top : 0}px`,
            left: `${ready ? position.left : 0}px`,
            visibility: ready ? "visible" : "hidden",
        },
    },
        menu.title ? h("div", { className: "task-action-menu-title" }, menu.title) : null,
        menu.items.map((item, index) => actionMenuItem(item, index, onClose))
    );
}

function AddTaskPopover({ popover, onClose, children }) {
    const popoverRef = React.useRef(null);
    const popoverKey = popover ? `${popover.type}:${popover.nonce || 0}` : "";
    const [position, setPosition] = React.useState({ key: "", top: 0, left: 0, ready: false });

    React.useEffect(() => {
        if (!popover) return undefined;
        const onPointerDown = (event) => {
            if (popoverRef.current?.contains(event.target)) return;
            if (event.target?.closest?.("[data-task-add-popover-trigger]")) return;
            onClose();
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape") onClose();
        };
        const onScroll = () => onClose();
        const onResize = () => onClose();
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onResize);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
        };
    }, [popover, onClose]);

    React.useLayoutEffect(() => {
        if (!popover || !popoverRef.current) return;
        const popoverRect = popoverRef.current.getBoundingClientRect();
        const anchor = popover.anchor;
        const gap = 6;
        const margin = 8;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let left = anchor.left;
        if (left + popoverRect.width > viewportWidth - margin) {
            left = anchor.right - popoverRect.width;
        }
        left = Math.max(margin, Math.min(viewportWidth - popoverRect.width - margin, left));

        let top = anchor.bottom + gap;
        const aboveTop = anchor.top - popoverRect.height - gap;
        if (top + popoverRect.height > viewportHeight - margin && aboveTop >= margin) {
            top = aboveTop;
        }
        top = Math.max(margin, Math.min(viewportHeight - popoverRect.height - margin, top));
        setPosition({ key: popoverKey, top, left, ready: true });
    }, [popover, popoverKey, children]);

    if (!popover) return null;
    const ready = position.key === popoverKey && position.ready;
    return h("div", {
        ref: popoverRef,
        className: "task-add-popover",
        style: {
            top: `${ready ? position.top : 0}px`,
            left: `${ready ? position.left : 0}px`,
            visibility: ready ? "visible" : "hidden",
        },
    }, children);
}

export function ListEditorDialog({ dialog, onClose, onSubmit }) {
    const [name, setName] = React.useState("");
    const [description, setDescription] = React.useState("");

    React.useEffect(() => {
        setName(dialog?.list?.name || "");
        setDescription(dialog?.list?.description || "");
    }, [dialog?.id, dialog?.list?.name, dialog?.list?.description]);

    if (!dialog) return null;
    const creating = dialog.mode === "create";
    return h("div", { className: "task-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "task-list-dialog-title" },
        h("form", {
            className: "task-modal-panel",
            onSubmit: (event) => {
                event.preventDefault();
                const nextName = name.trim();
                if (!nextName) return;
                onSubmit({ name: nextName, description: description.trim() });
            },
        },
            h("header", { className: "task-modal-header" },
                h("div", null,
                    h("h2", { id: "task-list-dialog-title" }, creating ? "Create new list" : "Rename list"),
                    h("p", null, creating ? "Name it now; add context if it helps future you." : "Update the list name and optional description.")
                ),
                iconButton({ icon: "close", label: "Close", onClick: onClose })
            ),
            h("label", { className: "task-field" },
                h("span", null, "Name"),
                h("input", {
                    value: name,
                    maxLength: 120,
                    autoFocus: true,
                    onChange: (event) => setName(event.target.value),
                    placeholder: "School, research, personal..."
                })
            ),
            h("label", { className: "task-field" },
                h("span", null, "Description"),
                h("textarea", {
                    value: description,
                    maxLength: 1000,
                    onChange: (event) => setDescription(event.target.value),
                    placeholder: "Optional note for this list"
                })
            ),
            h("footer", { className: "task-modal-actions" },
                h("button", { type: "button", className: "task-secondary-button", onClick: onClose }, "Cancel"),
                buttonWithIcon({
                    type: "submit",
                    className: "task-primary-button",
                    disabled: !name.trim(),
                    icon: creating ? "add" : "check",
                    children: creating ? "Create list" : "Save",
                })
            )
        )
    );
}

function countIncomplete(tasks) {
    return tasks.reduce((count, task) => count + (isRepeatingTaskCompleted(task) ? 0 : 1), 0);
}

function menuAnchorFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
        anchor: {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
        },
    };
}

export function ListRail(props) {
    const {
        lists,
        selectedListId,
        setSelectedListId,
        tasksByList,
        reorderLists,
        updateList,
        toggleListVisibility,
        openListDialog,
        openListMenu,
    } = props;
    const railRef = React.useRef(null);
    const [listsOpen, setListsOpen] = React.useState(true);
    const orderedLists = React.useMemo(() => sortedLists(lists), [lists]);
    const visibleLists = orderedLists.filter((list) => !list.hidden);
    const visibleTasks = visibleLists.flatMap((list) => tasksByList.get(list.id) || []);
    const allIncomplete = countIncomplete(visibleTasks);
    const starredCount = visibleTasks.filter((task) => task.starred).length;

    useSortable(railRef, () => ({
            animation: 150,
            draggable: ".task-list-nav-item",
            handle: ".task-list-nav-content",
            filter: ".task-list-visibility, .task-list-row-menu",
            ghostClass: "task-sortable-ghost",
            chosenClass: "task-sortable-chosen",
            onEnd: () => {
                const ids = Array.from(railRef.current.querySelectorAll("[data-list-id]")).map((item) => item.getAttribute("data-list-id"));
                reorderLists(ids);
            },
        }), [orderedLists.map((list) => list.id).join("|"), reorderLists]);

    return h("aside", { className: "task-list-rail" },
        h("div", { className: "task-rail-main" },
            railButton({ active: selectedListId === "all", icon: "select_all", label: "All tasks", count: allIncomplete, onClick: () => setSelectedListId("all") }),
            railButton({ active: selectedListId === "starred", icon: "star", label: "Starred", count: starredCount, onClick: () => setSelectedListId("starred") })
        ),
        h("section", { className: "task-rail-section" },
            h("div", { className: "task-rail-section-header" },
                h("button", {
                    type: "button",
                    className: "task-rail-section-toggle",
                    onClick: () => setListsOpen((current) => !current),
                    "aria-expanded": listsOpen ? "true" : "false",
                },
                    h(MaterialIcon, { name: listsOpen ? "expand_more" : "chevron_right" }),
                    h("span", null, "Lists")
                ),
                buttonWithIcon({ className: "task-create-list-small", icon: "add", onClick: () => openListDialog({ mode: "create" }), children: "Create new list" })
            ),
            listsOpen ? h("div", { ref: railRef, className: "task-list-nav" },
                orderedLists.map((list) => {
                    const listTasks = tasksByList.get(list.id) || [];
                    const incompleteCount = countIncomplete(listTasks);
                    return h("div", {
                        key: list.id,
                        "data-list-id": list.id,
                        className: cx("task-list-nav-item", selectedListId === list.id && "is-active", list.hidden && "is-hidden-list"),
                    },
                        h("button", {
                            type: "button",
                            className: cx("task-list-visibility", !list.hidden && "is-checked"),
                            onClick: (event) => {
                                event.stopPropagation();
                                toggleListVisibility(list.id);
                            },
                            "aria-label": list.hidden ? `Show ${list.name}` : `Hide ${list.name}`,
                            "aria-pressed": list.hidden ? "false" : "true",
                        }, list.hidden ? null : h(MaterialIcon, { name: "check" })),
                        h("button", {
                            type: "button",
                            className: "task-list-nav-content",
                            onClick: () => setSelectedListId(list.id),
                        },
                            h("span", { className: "task-list-nav-text" },
                                h("span", { className: "task-list-nav-name" }, list.name),
                                list.description ? h("span", { className: "task-list-nav-description" }, list.description) : null
                            ),
                            h("strong", null, incompleteCount)
                        ),
                        menuTrigger({
                            id: list.id,
                            kind: "list",
                            className: "task-list-row-menu",
                            label: `Open options for ${list.name}`,
                            onOpen: openListMenu,
                            stopPropagation: true,
                        })
                    );
                })
            ) : null
        )
    );
}

export function TaskSection(props) {
    const {
        list,
        tasks,
        updateList,
        createTask,
        updateTask,
        deleteTask,
        completeTask,
        expandedTaskId,
        setExpandedTaskId,
        reorderTasks,
        highlightTaskId,
        openListMenu,
        openTaskMenu,
    } = props;
    const [nameDraft, setNameDraft] = React.useState(list.name);
    const [completedOpen, setCompletedOpen] = React.useState(false);
    const bodyRef = React.useRef(null);
    const taskGroups = React.useMemo(() => splitTasksByCompletion(tasks), [tasks]);
    const incompleteCount = taskGroups.active.length;
    const completedCount = taskGroups.completed.length;

    React.useEffect(() => {
        setNameDraft(list.name);
    }, [list.name]);

    useSortable(bodyRef, () => ({
            group: { name: "tasks", pull: true, put: true },
            animation: 150,
            draggable: ".task-row",
            handle: ".task-row-drag",
            ghostClass: "task-sortable-ghost",
            chosenClass: "task-sortable-chosen",
            onEnd: reorderTasks,
        }), [list.id, taskGroups.active.map((task) => task.id).join("|"), reorderTasks]);

    const commitName = () => {
        const next = nameDraft.trim() || "Untitled List";
        if (next !== list.name) updateList(list.id, { name: next });
        setNameDraft(next);
    };

    return h("article", { className: "task-list-section", "data-print-list-id": list.id },
        h("div", { className: "task-list-section-header" },
            iconButton({
                icon: list.collapsed ? "chevron_right" : "expand_more",
                label: list.collapsed ? "Expand list" : "Collapse list",
                className: "task-collapse-button",
                onClick: () => updateList(list.id, { collapsed: !list.collapsed }),
            }),
            h("div", { className: "task-list-heading" },
                h("input", {
                    className: "task-list-title-input",
                    value: nameDraft,
                    onChange: (event) => setNameDraft(event.target.value),
                    onBlur: commitName,
                    onKeyDown: (event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                    },
                    "aria-label": "List name",
                }),
                list.description ? h("p", { className: "task-list-section-description" }, list.description) : null
            ),
            h("span", { className: "task-list-count" }, `${incompleteCount} left`),
            menuTrigger({
                id: list.id,
                kind: "list",
                className: "task-list-options-button",
                label: "List options",
                onOpen: openListMenu,
            })
        ),
        !list.collapsed && h("div", { ref: bodyRef, className: "task-list-body", "data-task-list-body": "true", "data-list-id": list.id },
            taskGroups.active.length === 0 && completedCount === 0
                ? h("div", { className: "task-list-empty" }, "No tasks in this list yet.")
                : taskGroups.active.map((task) => h(TaskRow, {
                    key: task.id,
                    task,
                    isExpanded: expandedTaskId === task.id,
                    setExpandedTaskId,
                    updateTask,
                    deleteTask,
                    completeTask,
                    highlighted: highlightTaskId && task.id === highlightTaskId,
                    openTaskMenu,
                }))
        ),
        !list.collapsed && h(AddTaskForm, { listId: list.id, createTask }),
        !list.collapsed && completedCount > 0 ? h("section", { className: "task-completed-section" },
            h("button", {
                type: "button",
                className: "task-completed-toggle",
                onClick: () => setCompletedOpen((current) => !current),
                "aria-expanded": completedOpen ? "true" : "false",
            },
                h(MaterialIcon, { name: completedOpen ? "expand_more" : "chevron_right" }),
                h("span", null, "Completed"),
                h("strong", null, completedCount)
            ),
            completedOpen ? h("div", { className: "task-completed-list" },
                taskGroups.completed.map((task) => h(TaskRow, {
                    key: task.id,
                    task,
                    isExpanded: expandedTaskId === task.id,
                    setExpandedTaskId,
                    updateTask,
                    deleteTask,
                    completeTask,
                    highlighted: highlightTaskId && task.id === highlightTaskId,
                    openTaskMenu,
                    draggable: false,
                }))
            ) : null
        ) : null
    );
}

function TaskRow({ task, isExpanded, setExpandedTaskId, updateTask, completeTask, highlighted, openTaskMenu, draggable = true }) {
    const [titleDraft, setTitleDraft] = React.useState(task.title);
    const completed = isRepeatingTaskCompleted(task);
    React.useEffect(() => setTitleDraft(task.title), [task.title]);

    const commitTitle = () => {
        const next = titleDraft.trim();
        if (next && next !== task.title) updateTask(task.id, { title: next });
        if (!next) setTitleDraft(task.title);
    };

    return h("div", {
        className: cx("task-row", completed && "is-completed", highlighted && "is-highlighted"),
        "data-task-id": task.id,
    },
        h("div", { className: "task-row-main" },
            draggable ? h("span", { className: "task-row-drag", "aria-hidden": "true" }, h(MaterialIcon, { name: "drag_indicator" })) : h("span", { className: "task-row-drag-spacer", "aria-hidden": "true" }),
            h("button", {
                type: "button",
                className: cx("task-checkbox", completed && "is-checked"),
                onClick: () => completeTask(task, !completed),
                "aria-label": completed ? "Mark task incomplete" : "Complete task",
            }, completed ? h(MaterialIcon, { name: "check" }) : null),
            h("div", { className: "task-title-wrap" },
                h("input", {
                    className: "task-title-input",
                    value: titleDraft,
                    onChange: (event) => setTitleDraft(event.target.value),
                    onBlur: commitTitle,
                    onKeyDown: (event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                    },
                    "aria-label": "Task title",
                }),
                h("span", { className: "task-title-strike", "aria-hidden": "true" })
            ),
            h(PriorityBadge, { priority: task.priority }),
            task.deadline_at ? h("span", { className: "task-row-meta" }, h(MaterialIcon, { name: "schedule" }), formatDeadline(task.deadline_at)) : null,
            task.recurrence ? h("span", { className: "task-row-meta" }, h(MaterialIcon, { name: "repeat" }), formatRepeat(task.recurrence)) : null,
            h("button", {
                type: "button",
                className: cx("task-star-button", task.starred && "is-starred"),
                onClick: () => updateTask(task.id, { starred: !task.starred }),
                "aria-label": task.starred ? "Remove star" : "Star task",
                "aria-pressed": task.starred ? "true" : "false",
                title: task.starred ? "Remove star" : "Star task",
            }, h(MaterialIcon, { name: "star" })),
            menuTrigger({
                id: task.id,
                kind: "task",
                className: "task-row-menu-button",
                label: "Task options",
                onOpen: openTaskMenu,
                getPosition: (event) => ({
                    ...menuAnchorFromEvent(event),
                    configure: () => setExpandedTaskId(isExpanded ? "" : task.id),
                }),
            })
        ),
        isExpanded ? h(TaskDetails, { task, updateTask }) : null
    );
}

function PriorityBadge({ priority }) {
    if (!priority || priority === "none") return null;
    return h("span", { className: `task-priority task-priority-${priority}` },
        h(MaterialIcon, { name: priority === "high" ? "priority_high" : "flag" }),
        priority
    );
}

function TaskDetails({ task, updateTask }) {
    const [repeatPopover, setRepeatPopover] = React.useState(null);
    const [repeatDraft, setRepeatDraft] = React.useState(task.recurrence || createDefaultRecurrence());

    React.useEffect(() => {
        if (!repeatPopover) setRepeatDraft(task.recurrence || createDefaultRecurrence());
    }, [repeatPopover, task.recurrence]);

    const openRepeatPopover = (event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setRepeatDraft(task.recurrence || createDefaultRecurrence());
        setRepeatPopover((current) => current
            ? null
            : {
                type: "repeat",
                nonce: Date.now(),
                anchor: {
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                },
            });
    };

    const closeRepeatPopover = () => {
        setRepeatDraft(task.recurrence || createDefaultRecurrence());
        setRepeatPopover(null);
    };

    const clearRepeat = () => {
        updateTask(task.id, { recurrence: null });
        setRepeatDraft(createDefaultRecurrence());
        setRepeatPopover(null);
    };

    const saveRepeat = () => {
        updateTask(task.id, { recurrence: repeatDraft });
        setRepeatPopover(null);
    };

    return h("div", { className: "task-details" },
        h("label", null,
            h("span", null, "Priority"),
            prioritySelect(task.priority || "none", (priority) => updateTask(task.id, { priority }))
        ),
        h("label", null,
            h("span", null, "Deadline"),
            h("input", {
                type: "datetime-local",
                value: isoToLocalInput(task.deadline_at),
                onChange: (event) => updateTask(task.id, {
                    deadline_at: localInputToIso(event.target.value),
                    deadline_time: event.target.value ? event.target.value.slice(11, 16) : null,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                }),
            })
        ),
        h("div", { className: "task-detail-repeat-field" },
            h("span", null, "Repeat"),
            h("button", {
                type: "button",
                className: cx("task-add-control", task.recurrence && "is-active"),
                onClick: openRepeatPopover,
                "aria-expanded": repeatPopover ? "true" : "false",
                "data-task-add-popover-trigger": "repeat-detail",
            },
                h(MaterialIcon, { name: task.recurrence ? "repeat_on" : "repeat" }),
                h("span", null, task.recurrence ? formatRepeat(task.recurrence) : "Repeat")
            )
        ),
        h(AddTaskPopover, { popover: repeatPopover, onClose: closeRepeatPopover },
            h(RepeatMenuContent, {
                recurrence: repeatDraft,
                onChange: setRepeatDraft,
                onCancel: clearRepeat,
                onDone: saveRepeat,
            })
        )
    );
}

export function AddTaskForm({ listId, createTask }) {
    const [focused, setFocused] = React.useState(false);
    const [title, setTitle] = React.useState("");
    const [priority, setPriority] = React.useState("none");
    const [deadline, setDeadline] = React.useState("");
    const [repeatEnabled, setRepeatEnabled] = React.useState(false);
    const [recurrence, setRecurrence] = React.useState(createDefaultRecurrence);
    const [repeatDraft, setRepeatDraft] = React.useState(createDefaultRecurrence);
    const [popover, setPopover] = React.useState(null);
    const [saving, setSaving] = React.useState(false);
    const expanded = focused || title || deadline || repeatEnabled || priority !== "none" || Boolean(popover);

    const reset = () => {
        setTitle("");
        setPriority("none");
        setDeadline("");
        setRepeatEnabled(false);
        setRecurrence(createDefaultRecurrence());
        setRepeatDraft(createDefaultRecurrence());
        setPopover(null);
    };

    const openPopover = (type, event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        if (type === "repeat") {
            setRepeatDraft(repeatEnabled ? recurrence : createDefaultRecurrence());
        }
        setPopover((current) => current?.type === type
            ? null
            : {
                type,
                nonce: Date.now(),
                anchor: {
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                },
            });
    };

    const controlButton = ({ type, icon, label, active, value }) => h("button", {
        type: "button",
        className: cx("task-add-control", active && "is-active"),
        onClick: (event) => openPopover(type, event),
        "aria-label": label,
        "aria-expanded": popover?.type === type ? "true" : "false",
        "data-task-add-popover-trigger": type,
    },
        h(MaterialIcon, { name: icon }),
        h("span", null, value || label)
    );

    const popoverContent = () => {
        if (!popover) return null;
        if (popover.type === "due") {
            return h(React.Fragment, null,
                h("label", { className: "task-add-popover-field" },
                    h("span", null, "Due date"),
                    h("input", {
                        type: "datetime-local",
                        value: deadline,
                        onChange: (event) => setDeadline(event.target.value),
                        autoFocus: true,
                    })
                ),
                h("div", { className: "task-add-popover-actions" },
                    h("button", { type: "button", className: "task-secondary-button", onClick: () => setDeadline("") }, "Clear"),
                    h("button", { type: "button", className: "task-primary-button", onClick: () => setPopover(null) }, "Done")
                )
            );
        }
        if (popover.type === "priority") {
            return h("div", { className: "task-add-choice-list", role: "menu" },
                PRIORITY_OPTIONS.map((option) => h("button", {
                    key: option.value,
                    type: "button",
                    className: cx(priority === option.value && "is-selected"),
                    onClick: () => {
                        setPriority(option.value);
                        setPopover(null);
                    },
                    role: "menuitemradio",
                    "aria-checked": priority === option.value ? "true" : "false",
                },
                    h(MaterialIcon, { name: priority === option.value ? "check" : option.value === "none" ? "radio_button_unchecked" : "flag" }),
                    h("span", null, option.label)
                ))
            );
        }
        return h(RepeatMenuContent, {
            recurrence: repeatDraft,
            onChange: setRepeatDraft,
            onCancel: () => {
                setRepeatEnabled(false);
                setRecurrence(createDefaultRecurrence());
                setRepeatDraft(createDefaultRecurrence());
                setPopover(null);
            },
            onDone: () => {
                setRepeatEnabled(true);
                setRecurrence(repeatDraft);
                setPopover(null);
            },
        });
    };

    return h("form", {
        className: `task-add-form ${expanded ? "is-expanded" : ""}`,
        onFocus: () => setFocused(true),
        onBlur: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
                setFocused(false);
            }
        },
        onSubmit: async (event) => {
            event.preventDefault();
            if (!title.trim()) return;
            setSaving(true);
            try {
                await createTask(listId, {
                    title: title.trim(),
                    priority,
                    deadline_at: deadline,
                    recurrence: repeatEnabled ? recurrence : null,
                });
                reset();
            } catch (err) {
                console.warn("Task creation failed; app-level error banner was shown.", err);
            } finally {
                setSaving(false);
            }
        },
    },
        h("div", { className: "task-add-primary" },
            h(MaterialIcon, { name: "add_task" }),
            h("input", {
                value: title,
                onChange: (event) => setTitle(event.target.value),
                placeholder: "Add a task",
                disabled: saving,
            }),
            h("button", { type: "submit", disabled: saving || !title.trim() }, "Add")
        ),
        expanded ? h("div", { className: "task-add-entrybar" },
            controlButton({
                type: "due",
                icon: deadline ? "event_available" : "event",
                label: "Due date",
                active: Boolean(deadline),
                value: deadline ? formatDeadline(localInputToIso(deadline)) : "",
            }),
            controlButton({
                type: "priority",
                icon: priority !== "none" ? "flag" : "outlined_flag",
                label: "Priority",
                active: priority !== "none",
                value: priority !== "none" ? PRIORITY_OPTIONS.find((option) => option.value === priority)?.label : "",
            }),
            controlButton({
                type: "repeat",
                icon: repeatEnabled ? "repeat_on" : "repeat",
                label: "Repeat",
                active: repeatEnabled,
                value: repeatEnabled ? formatRepeat(recurrence) : "",
            })
        ) : null,
        h(AddTaskPopover, { popover, onClose: () => setPopover(null) }, popoverContent())
    );
}
