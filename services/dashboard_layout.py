"""Dashboard layout normalization, validation, and persistence."""

import json
import logging
from datetime import datetime, timezone
from typing import Callable

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from services.row_utils import row_id
from services.database import Queries, RowMapping

logger = logging.getLogger(__name__)

DASHBOARD_TILE_IDS = ("calendar", "tasks", "files", "notes", "messages", "courses")
DEFAULT_DASHBOARD_TILE_ORDER = ("calendar", "tasks", "files", "notes", "messages", "courses")
DASHBOARD_DEFAULT_TILE_SIZES = {
    "calendar": "standard",
    "tasks": "standard",
    "files": "standard",
    "notes": "standard",
    "messages": "standard",
    "courses": "wide",
}
DASHBOARD_ALLOWED_TILE_SIZES = {
    "calendar": ("standard", "tall", "wide"),
    "tasks": ("standard", "tall", "wide"),
    "files": ("standard", "tall", "wide"),
    "notes": ("standard", "tall", "wide"),
    "messages": ("standard", "tall", "wide"),
    "courses": ("standard", "wide"),
}
DASHBOARD_LAYOUT_VERSION = 4
DASHBOARD_CALENDAR_VIEWS = ("month", "week", "upcoming")
DASHBOARD_DEFAULT_CALENDAR_VIEW = "month"
DASHBOARD_TILE_LIMIT = 12
DASHBOARD_DUPLICATE_TILE_LIMIT = 4
DASHBOARD_DUPLICATE_TILE_TYPES = {"calendar", "tasks"}
DASHBOARD_ITEM_LIMITS = (3, 5, 8)
DASHBOARD_DENSITIES = ("compact", "comfortable")
DASHBOARD_CALENDAR_UPCOMING_DAYS = (7, 14, 30)
DASHBOARD_TASK_DEADLINE_DAYS = (7, 30)
DASHBOARD_TASK_PRIORITIES = ("high", "medium", "low", "none")
DASHBOARD_TITLE_MAX_LENGTH = 60


def _default_tile_size(tile_id):
    return DASHBOARD_DEFAULT_TILE_SIZES.get(tile_id, "standard")


def _layout_version(parsed):
    if isinstance(parsed, dict):
        try:
            return int(parsed.get("version") or 2)
        except (TypeError, ValueError):
            return 2
    if isinstance(parsed, list):
        return 1
    return 2


def _normalize_tile_size(tile_id, size):
    normalized = str(size or "").strip().lower()
    if normalized in {"compact", "medium"}:
        normalized = "standard"
    elif normalized == "large":
        normalized = "wide"
    if normalized not in DASHBOARD_ALLOWED_TILE_SIZES.get(tile_id, ()):
        return _default_tile_size(tile_id)
    return normalized


def _normalize_calendar_view(view):
    normalized = str(view or DASHBOARD_DEFAULT_CALENDAR_VIEW).strip().lower()
    return normalized if normalized in DASHBOARD_CALENDAR_VIEWS else DASHBOARD_DEFAULT_CALENDAR_VIEW


def _normalize_task_list_ids(raw_list_ids, available_list_ids=None):
    if not isinstance(raw_list_ids, list):
        return []
    available = set(str(item) for item in available_list_ids) if available_list_ids is not None else None
    normalized = []
    for item in raw_list_ids:
        list_id = str(item or "").strip()
        if not list_id or list_id in normalized:
            continue
        if available is not None and list_id not in available:
            continue
        normalized.append(list_id)
    return normalized


def _legacy_instance_id(tile_id):
    return f"legacy-{tile_id}"


def _normalized_choice(value, allowed, default):
    normalized = str(value or default).strip().lower()
    return normalized if normalized in allowed else default


def _normalized_item_limit(value):
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = 5
    return normalized if normalized in DASHBOARD_ITEM_LIMITS else 5


def _layout_tile_payload(
    tile_id,
    size=None,
    view=None,
    task_list_ids=None,
    *,
    instance_id=None,
    title=None,
    density=None,
    item_limit=None,
    upcoming_days=None,
    deadline_days=None,
    include_overdue=None,
    include_undated=None,
    priorities=None,
    starred_only=None,
):
    payload = {
        "instance_id": str(instance_id or _legacy_instance_id(tile_id)).strip(),
        "type": tile_id,
        "size": _normalize_tile_size(tile_id, size),
        "density": _normalized_choice(density, DASHBOARD_DENSITIES, "comfortable"),
        "item_limit": _normalized_item_limit(item_limit),
    }
    normalized_title = str(title or "").strip()[:DASHBOARD_TITLE_MAX_LENGTH]
    if normalized_title:
        payload["title"] = normalized_title
    if tile_id == "calendar":
        payload["view"] = _normalize_calendar_view(view)
        payload["upcoming_days"] = int(upcoming_days) if upcoming_days in DASHBOARD_CALENDAR_UPCOMING_DAYS else 7
    if tile_id == "tasks":
        list_ids = _normalize_task_list_ids(task_list_ids)
        if list_ids:
            payload["task_list_ids"] = list_ids
        payload["deadline_days"] = int(deadline_days) if deadline_days in DASHBOARD_TASK_DEADLINE_DAYS else 30
        payload["include_overdue"] = True if include_overdue is None else bool(include_overdue)
        payload["include_undated"] = True if include_undated is None else bool(include_undated)
        normalized_priorities = [
            priority for priority in DASHBOARD_TASK_PRIORITIES
            if priority in {str(item or "").strip().lower() for item in (priorities or DASHBOARD_TASK_PRIORITIES)}
        ]
        payload["priorities"] = normalized_priorities or list(DASHBOARD_TASK_PRIORITIES)
        payload["starred_only"] = bool(starred_only)
    return payload


def _coerce_layout(raw_value):
    if isinstance(raw_value, (dict, list)):
        parsed = raw_value
    else:
        try:
            parsed = json.loads(raw_value or "[]")
        except (TypeError, ValueError):
            parsed = {}

    version = _layout_version(parsed)
    source_tiles = []
    if isinstance(parsed, dict):
        source_tiles = parsed.get("tiles") if isinstance(parsed.get("tiles"), list) else []
    elif isinstance(parsed, list):
        source_tiles = parsed

    tiles = []
    seen_instances = set()
    seen_legacy_types = set()
    for item in source_tiles:
        if isinstance(item, dict):
            tile_id = str(item.get("type") or item.get("id") or "").strip()
            instance_id = str(item.get("instance_id") or (item.get("id") if item.get("type") else "") or _legacy_instance_id(tile_id)).strip()
            size = item.get("size")
            view = item.get("view")
            task_list_ids = item.get("task_list_ids")
        else:
            tile_id = str(item or "").strip()
            instance_id = _legacy_instance_id(tile_id)
            size = None
            view = None
            task_list_ids = None
        if tile_id not in DASHBOARD_TILE_IDS or instance_id in seen_instances:
            continue
        if version < DASHBOARD_LAYOUT_VERSION and tile_id in seen_legacy_types:
            continue
        tiles.append(_layout_tile_payload(
            tile_id,
            size,
            view,
            task_list_ids,
            instance_id=instance_id,
            title=item.get("title") if isinstance(item, dict) else None,
            density=item.get("density") if isinstance(item, dict) else None,
            item_limit=item.get("item_limit") if isinstance(item, dict) else None,
            upcoming_days=item.get("upcoming_days") if isinstance(item, dict) else None,
            deadline_days=item.get("deadline_days") if isinstance(item, dict) else None,
            include_overdue=item.get("include_overdue") if isinstance(item, dict) else None,
            include_undated=item.get("include_undated") if isinstance(item, dict) else None,
            priorities=item.get("priorities") if isinstance(item, dict) else None,
            starred_only=item.get("starred_only") if isinstance(item, dict) else None,
        ))
        seen_instances.add(instance_id)
        seen_legacy_types.add(tile_id)
    quote_visible = parsed.get("daily_quote_visible") if isinstance(parsed, dict) else None
    return {"version": version, "daily_quote_visible": quote_visible if isinstance(quote_visible, bool) else None, "tiles": tiles}


def _coerce_layout_order(raw_value):
    return [tile["type"] for tile in _coerce_layout(raw_value)["tiles"]]


def _ordered_tile_layout(saved_layout, available_tile_ids):
    available = [tile_id for tile_id in available_tile_ids if tile_id in DASHBOARD_TILE_IDS]
    version = int(saved_layout.get("version") or 2) if isinstance(saved_layout, dict) else 2
    saved_tiles = saved_layout.get("tiles") if isinstance(saved_layout, dict) else []
    ordered = []
    seen = set()
    for item in saved_tiles:
        tile_id = str(item.get("type") or item.get("id") or "").strip() if isinstance(item, dict) else ""
        instance_id = str(item.get("instance_id") or _legacy_instance_id(tile_id)).strip() if isinstance(item, dict) else ""
        if tile_id not in available or instance_id in seen:
            continue
        ordered.append(_layout_tile_payload(
            tile_id,
            item.get("size"),
            item.get("view"),
            item.get("task_list_ids"),
            instance_id=instance_id,
            title=item.get("title"),
            density=item.get("density"),
            item_limit=item.get("item_limit"),
            upcoming_days=item.get("upcoming_days"),
            deadline_days=item.get("deadline_days"),
            include_overdue=item.get("include_overdue"),
            include_undated=item.get("include_undated"),
            priorities=item.get("priorities"),
            starred_only=item.get("starred_only"),
        ))
        seen.add(instance_id)
    if version >= 3:
        return ordered
    seen_types = {tile["type"] for tile in ordered}
    for tile_id in DEFAULT_DASHBOARD_TILE_ORDER:
        if tile_id in available and tile_id not in seen_types:
            ordered.append(_layout_tile_payload(tile_id))
            seen_types.add(tile_id)
    for tile_id in available:
        if tile_id not in seen_types:
            ordered.append(_layout_tile_payload(tile_id))
            seen_types.add(tile_id)
    return ordered


def _validated_tile_size(tile_id, raw_size):
    if raw_size is None or str(raw_size).strip() == "":
        return _default_tile_size(tile_id)
    normalized = str(raw_size).strip().lower()
    if normalized in {"compact", "medium"}:
        normalized = "standard"
    elif normalized == "large":
        normalized = "wide"
    if normalized not in DASHBOARD_ALLOWED_TILE_SIZES.get(tile_id, ()):
        return None
    return normalized


def _validated_calendar_view(raw_view):
    if raw_view is None or str(raw_view).strip() == "":
        return DASHBOARD_DEFAULT_CALENDAR_VIEW
    normalized = str(raw_view).strip().lower()
    return normalized if normalized in DASHBOARD_CALENDAR_VIEWS else None


class _LayoutValidationError(Exception):
    """A rejected layout field, including task ownership lookup failures."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _validate_tile_identity(item, layout_version, seen_instances, type_counts):
    if isinstance(item, dict):
        tile_id = str(item.get("type") or item.get("id") or "").strip()
        instance_id = str(
            item.get("instance_id")
            or (item.get("id") if item.get("type") else "")
            or _legacy_instance_id(tile_id)
        ).strip()
    else:
        tile_id = str(item or "").strip()
        instance_id = _legacy_instance_id(tile_id)
        item = {}
    if tile_id not in DASHBOARD_TILE_IDS:
        raise _LayoutValidationError(f"Unknown dashboard tile: {tile_id or 'blank'}.")
    if (
        not instance_id
        or len(instance_id) > 80
        or not all(character.isalnum() or character in "-_:." for character in instance_id)
    ):
        raise _LayoutValidationError(
            f"Invalid dashboard tile instance: {instance_id or 'blank'}."
        )
    if instance_id in seen_instances:
        raise _LayoutValidationError(f"Duplicate dashboard tile instance: {instance_id}.")
    type_counts[tile_id] = type_counts.get(tile_id, 0) + 1
    if type_counts[tile_id] > 1 and (
        layout_version < DASHBOARD_LAYOUT_VERSION
        or tile_id not in DASHBOARD_DUPLICATE_TILE_TYPES
    ):
        raise _LayoutValidationError(f"Duplicate dashboard tile: {tile_id}.")
    if type_counts[tile_id] > DASHBOARD_DUPLICATE_TILE_LIMIT:
        raise _LayoutValidationError(
            f"Dashboard supports at most {DASHBOARD_DUPLICATE_TILE_LIMIT} {tile_id} tiles."
        )
    return tile_id, instance_id, item


def _validate_tile_appearance(tile_id, instance_id, item):
    raw_size = item.get("size")
    size = _validated_tile_size(tile_id, raw_size)
    if size is None:
        raise _LayoutValidationError(
            f"Invalid size '{raw_size or 'blank'}' for dashboard tile: {tile_id}."
        )
    raw_title = item.get("title")
    if raw_title is not None and not isinstance(raw_title, str):
        raise _LayoutValidationError("Dashboard tile titles must be text.")
    title = str(raw_title or "").strip()
    if len(title) > DASHBOARD_TITLE_MAX_LENGTH:
        raise _LayoutValidationError(
            f"Dashboard tile titles must be {DASHBOARD_TITLE_MAX_LENGTH} characters or fewer."
        )
    try:
        item_limit = int(item.get("item_limit", 5))
    except (TypeError, ValueError):
        item_limit = None
    if item_limit not in DASHBOARD_ITEM_LIMITS:
        raise _LayoutValidationError("Dashboard tile item_limit must be 3, 5, or 8.")
    density = str(item.get("density", "comfortable")).strip().lower()
    if density not in DASHBOARD_DENSITIES:
        raise _LayoutValidationError("Dashboard tile density must be compact or comfortable.")
    tile_payload = {
        "instance_id": instance_id,
        "type": tile_id,
        "size": size,
        "density": density,
        "item_limit": item_limit,
    }
    if title:
        tile_payload["title"] = title
    return tile_payload


def _validate_calendar_settings(item):
    raw_view = item.get("view")
    view = _validated_calendar_view(raw_view)
    if view is None:
        raise _LayoutValidationError(f"Invalid calendar view '{raw_view or 'blank'}'.")
    upcoming_days = item.get("upcoming_days", 7)
    if upcoming_days not in DASHBOARD_CALENDAR_UPCOMING_DAYS:
        raise _LayoutValidationError("Calendar upcoming_days must be 7, 14, or 30.")
    return {"view": view, "upcoming_days": upcoming_days}


class _TaskListFilters:
    """Validate filters against task lists loaded at most once per layout."""

    def __init__(self, user_id, list_rows_all_fn):
        self.user_id = user_id
        self.list_rows_all_fn = list_rows_all_fn
        self.owned_ids = None

    def validate(self, raw_list_ids):
        if raw_list_ids is None:
            return []
        if not isinstance(raw_list_ids, list):
            raise _LayoutValidationError("Task list filters must be a list.")
        if not raw_list_ids:
            return []
        if self.owned_ids is None:
            try:
                self.owned_ids = {
                    row_id(row)
                    for row in self.list_rows_all_fn(
                        COLLECTIONS.get("task_lists", "task_lists"),
                        [Query.equal("user_id", [self.user_id])],
                    )
                }
            except AppwriteException:
                logger.exception("Failed to validate dashboard task list filters")
                raise _LayoutValidationError("Unable to validate task list filters.", 500)
        list_ids = _normalize_task_list_ids(raw_list_ids, self.owned_ids)
        normalized_input_ids = {
            str(item or "").strip() for item in raw_list_ids if str(item or "").strip()
        }
        if len(list_ids) != len(normalized_input_ids):
            raise _LayoutValidationError("Task list filters must belong to your account.")
        if not list_ids:
            raise _LayoutValidationError("Select at least one task list or choose All.")
        return list_ids


def _validate_task_settings(item):
    deadline_days = item.get("deadline_days", 30)
    if deadline_days not in DASHBOARD_TASK_DEADLINE_DAYS:
        raise _LayoutValidationError("Task deadline_days must be 7 or 30.")
    raw_priorities = item.get("priorities", list(DASHBOARD_TASK_PRIORITIES))
    if not isinstance(raw_priorities, list):
        raise _LayoutValidationError("Task priorities must be a list.")
    priorities = []
    for raw_priority in raw_priorities:
        priority = str(raw_priority or "").strip().lower()
        if priority not in DASHBOARD_TASK_PRIORITIES:
            raise _LayoutValidationError(f"Unknown task priority: {priority or 'blank'}.")
        if priority not in priorities:
            priorities.append(priority)
    if not priorities:
        raise _LayoutValidationError("Select at least one task priority.")
    for boolean_field in ("include_overdue", "include_undated", "starred_only"):
        if boolean_field in item and not isinstance(item[boolean_field], bool):
            raise _LayoutValidationError(f"{boolean_field} must be true or false.")
    return {
        "deadline_days": deadline_days,
        "include_overdue": item.get("include_overdue", True),
        "include_undated": item.get("include_undated", True),
        "priorities": priorities,
        "starred_only": item.get("starred_only", False),
    }


def _validate_dashboard_tiles(raw_tiles, layout_version, task_list_filters):
    normalized_tiles = []
    seen_instances = set()
    type_counts = {}
    for item in raw_tiles:
        tile_id, instance_id, item = _validate_tile_identity(
            item, layout_version, seen_instances, type_counts,
        )
        tile_payload = _validate_tile_appearance(tile_id, instance_id, item)
        if tile_id == "calendar":
            tile_payload.update(_validate_calendar_settings(item))
        if tile_id == "tasks":
            list_ids = task_list_filters.validate(item.get("task_list_ids"))
            if list_ids:
                tile_payload["task_list_ids"] = list_ids
            tile_payload.update(_validate_task_settings(item))
        normalized_tiles.append(tile_payload)
        seen_instances.add(instance_id)
    return normalized_tiles


def save_dashboard_layout(
    user_id: str,
    payload: RowMapping,
    *,
    list_rows_all_fn: Callable[[str, Queries], list[RowMapping]],
    ensure_user_settings_fn: Callable[[str], RowMapping],
    update_row_fn: Callable[[str, str, RowMapping], RowMapping],
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> tuple[RowMapping, int]:
    """Validate and persist a layout, returning data and a transport-neutral status."""
    raw_layout = payload.get(
        "dashboard_layout",
        payload.get("tile_layout", payload.get("layout")),
    )
    if raw_layout is None:
        raw_layout = payload.get("tiles")
    if raw_layout is None:
        raw_layout = payload.get("tile_order", payload.get("order"))
    if not isinstance(raw_layout, (dict, list)):
        return {"error": "tile_layout must be an object or list."}, 400

    raw_tiles = (
        raw_layout.get("tiles")
        if isinstance(raw_layout, dict)
        else raw_layout
    )
    if not isinstance(raw_tiles, list):
        return {"error": "tile_layout tiles must be a list."}, 400
    if len(raw_tiles) > DASHBOARD_TILE_LIMIT:
        return {
            "error": (
                "Dashboard layouts support at most "
                f"{DASHBOARD_TILE_LIMIT} tiles."
            )
        }, 400

    layout_version = _layout_version(raw_layout)
    raw_quote_visible = (
        raw_layout.get("daily_quote_visible")
        if isinstance(raw_layout, dict)
        else True
    )
    if raw_quote_visible is not None and not isinstance(
        raw_quote_visible,
        bool,
    ):
        return {
            "error": "daily_quote_visible must be true or false."
        }, 400
    daily_quote_visible = (
        True if raw_quote_visible is None else raw_quote_visible
    )

    try:
        normalized_tiles = _validate_dashboard_tiles(
            raw_tiles,
            layout_version,
            _TaskListFilters(user_id, list_rows_all_fn),
        )
    except _LayoutValidationError as exc:
        return {"error": str(exc)}, exc.status

    normalized = {
        "version": DASHBOARD_LAYOUT_VERSION,
        "daily_quote_visible": daily_quote_visible,
        "tiles": normalized_tiles,
    }

    try:
        settings = ensure_user_settings_fn(user_id)
        settings = update_row_fn(
            COLLECTIONS["user_settings"],
            row_id(settings),
            {
                "dashboard_layout_json": json.dumps(
                    normalized,
                    separators=(",", ":"),
                ),
                "updated_at": format_datetime(
                    now_fn()
                ),
            },
        )
    except AppwriteException:
        logger.exception("Failed to save dashboard layout")
        return {
            "error": "Unable to save dashboard layout."
        }, 500

    saved_layout = _coerce_layout(settings.get("dashboard_layout_json"))
    return {
        "status": "ok",
        "dashboard_layout": saved_layout,
        "tile_layout": saved_layout["tiles"],
        "tile_order": [tile["type"] for tile in saved_layout["tiles"]],
    }, 200
