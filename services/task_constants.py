"""Shared task identity and scheduling vocabulary."""

TASK_CALENDAR_ID = "local:tasks"
TASK_CALENDAR_NAME = "Tasks"
TASK_CALENDAR_COLOR = "#0ea5e9"
TASK_PRIORITIES = frozenset({"none", "low", "medium", "high"})
RECURRENCE_UNITS = frozenset({"day", "week", "month", "year"})
