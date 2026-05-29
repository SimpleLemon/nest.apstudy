import * as React from "react";
import { AddTaskPopover } from "./task-popover.js";

import {
    PRIORITY_OPTIONS,
    REPEAT_UNITS,
    createDefaultRecurrence,
    defaultRecurrenceEndDate,
    formatDeadline,
    formatRepeat,
    isRepeatingTaskCompleted,
    isoToLocalInput,
    localInputToIso,
    todayDateString,
} from "./task-utils.js";

const h = React.createElement;

function cx(...parts) {
    return parts.filter(Boolean).join(" ");
}

function MaterialIcon({ name, className = "" }) {
    return h("span", { className: `material-symbols-outlined ${className}`, "aria-hidden": "true" }, name);
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

function menuTrigger({ id, kind, className, label, onOpen, getPosition = menuAnchorFromEvent }) {
    return iconButton({
        icon: "more_vert",
        label,
        className,
        triggerKey: `${kind}:${id}`,
        onClick: (event) => onOpen(id, getPosition(event)),
    });
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

export function TaskRow({ task, isExpanded, setExpandedTaskId, updateTask, completeTask, highlighted, openTaskMenu, draggable = true }) {
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
