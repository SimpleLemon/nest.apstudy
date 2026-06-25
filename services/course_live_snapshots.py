import json
from datetime import datetime, timedelta, timezone

from appwrite.exception import AppwriteException

from services import database
from services.atlas_client import fetch_live_section_status


TABLE = "course_section_live_snapshots"
SNAPSHOT_TTL = timedelta(minutes=30)
LIVE_SECTION_FIELDS = {
    "enrollment_status",
    "enrollment_count",
    "seats_available",
    "enrollment_capacity",
    "waitlist_total",
    "waitlist_capacity",
    "is_cancelled",
    "schedule_display",
    "meetings",
    "date_range",
    "location",
    "instructor",
    "instructors",
    "schedule_type",
    "credit_hours",
    "requirement_designation",
    "requirements",
    "course_description",
    "course_notes",
    "campus",
    "campus_description",
    "grading_mode",
    "grading_mode_options",
    "instruction_method",
}


def utcnow():
    return datetime.now(timezone.utc)


def isoformat(value=None):
    value = value or utcnow()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def snapshot_is_fresh(snapshot, now=None):
    fetched_at = parse_datetime((snapshot or {}).get("fetched_at"))
    if not fetched_at:
        return False
    return (now or utcnow()) - fetched_at <= SNAPSHOT_TTL


def snapshot_payload(snapshot):
    raw = (snapshot or {}).get("payload_json") or "{}"
    if isinstance(raw, dict):
        return raw
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def get_snapshot(section_id):
    if not section_id:
        return None
    try:
        return database.get_row(TABLE, str(section_id), allow_missing=True)
    except AppwriteException:
        return None


def list_snapshots(section_ids):
    ids = [str(section_id) for section_id in section_ids or [] if str(section_id or "").strip()]
    if not ids:
        return {}
    try:
        response = database.list_rows(TABLE, [{"method": "equal", "attribute": "id", "values": ids}])
    except AppwriteException:
        return {}
    return {str(row.get("section_id") or row.get("id")): row for row in response.get("rows", [])}


def _nonempty(value):
    return value not in (None, "", [])


def merge_snapshot(section, snapshot, now=None):
    merged = dict(section or {})
    if not snapshot:
        merged["live_snapshot_available"] = False
        merged["live_stale"] = True
        return merged

    payload = snapshot_payload(snapshot)
    for key in LIVE_SECTION_FIELDS:
        value = payload.get(key)
        if _nonempty(value):
            merged[key] = value

    for key in (
        "enrollment_status",
        "enrollment_count",
        "seats_available",
        "enrollment_capacity",
        "waitlist_total",
        "waitlist_capacity",
        "is_cancelled",
    ):
        value = snapshot.get(key)
        if _nonempty(value):
            merged[key] = value

    merged["live_updated_at"] = snapshot.get("fetched_at")
    merged["live_snapshot_available"] = True
    merged["live_stale"] = not snapshot_is_fresh(snapshot, now=now)
    return merged


def merge_snapshots_into_sections(sections, now=None):
    rows = list(sections or [])
    snapshots = list_snapshots([row.get("id") or row.get("section_id") for row in rows])
    return [
        merge_snapshot(row, snapshots.get(str(row.get("id") or row.get("section_id"))), now=now)
        for row in rows
    ]


def _snapshot_row_from_section(section, fetched_at=None):
    fetched_at = fetched_at or isoformat()
    section_id = str(section.get("id") or section.get("section_id") or "")
    return {
        "section_id": section_id,
        "term": section.get("term") or "",
        "subject": str(section.get("subject") or "").upper(),
        "catalog": section.get("catalog_number") or section.get("catalog") or "",
        "crn": section.get("crn") or "",
        "section_number": section.get("section_number") or "",
        "enrollment_status": section.get("enrollment_status"),
        "enrollment_count": section.get("enrollment_count"),
        "seats_available": section.get("seats_available"),
        "enrollment_capacity": section.get("enrollment_capacity"),
        "waitlist_total": section.get("waitlist_total"),
        "waitlist_capacity": section.get("waitlist_capacity"),
        "is_cancelled": bool(section.get("is_cancelled", False)),
        "payload_json": json.dumps(section, separators=(",", ":"), sort_keys=True),
        "fetched_at": fetched_at,
        "updated_at": fetched_at,
    }


def upsert_snapshot(section, fetched_at=None):
    section_id = str((section or {}).get("id") or (section or {}).get("section_id") or "")
    if not section_id:
        raise AppwriteException("Live section is missing section id")
    data = _snapshot_row_from_section(section, fetched_at=fetched_at)
    return database.upsert_row(TABLE, row_id=section_id, data=data)


def _live_section_matches(local_section, live_section):
    if not local_section or not live_section:
        return False
    live_id = live_section.get("id") or live_section.get("section_id")
    local_id = local_section.get("id") or local_section.get("section_id")
    if live_id and local_id:
        return str(live_id) == str(local_id)
    return (
        str(live_section.get("term") or "") == str(local_section.get("term") or "")
        and str(live_section.get("subject") or "").upper() == str(local_section.get("subject") or "").upper()
        and str(live_section.get("catalog_number") or live_section.get("catalog") or "").upper()
        == str(local_section.get("catalog_number") or local_section.get("catalog") or "").upper()
        and str(live_section.get("crn") or "") == str(local_section.get("crn") or "")
        and str(live_section.get("section_number") or "") == str(local_section.get("section_number") or "")
    )


def refresh_section_snapshot(section, *, force=False, now=None):
    now = now or utcnow()
    section_id = str((section or {}).get("id") or (section or {}).get("section_id") or "")
    existing = get_snapshot(section_id)
    if existing and not force and snapshot_is_fresh(existing, now=now):
        return merge_snapshot(section, existing, now=now), None, existing.get("fetched_at"), False

    result = fetch_live_section_status(
        section.get("term"),
        section.get("subject"),
        section.get("catalog_number") or section.get("catalog"),
        crn=section.get("crn"),
        section_number=section.get("section_number"),
    )
    if "error" in result:
        merged = merge_snapshot(section, existing, now=now) if existing else merge_snapshot(section, None, now=now)
        return merged, result["error"], existing.get("fetched_at") if existing else None, True

    live_section = result.get("section")
    if not _live_section_matches(section, live_section):
        merged = merge_snapshot(section, existing, now=now) if existing else merge_snapshot(section, None, now=now)
        return merged, "Atlas live response did not match this section.", existing.get("fetched_at") if existing else None, True

    fetched_at = isoformat(now)
    snapshot = upsert_snapshot(live_section, fetched_at=fetched_at)
    return merge_snapshot(section, snapshot, now=now), None, fetched_at, False
