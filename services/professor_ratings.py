"""Read-only, cache-only professor summaries; request paths never contact RMP."""
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

from services.professor_rating_identity import SCHOOLS, normalized_name, professor_id, profile_url, search_url, section_instructors

SNAPSHOT_PATH = Path(__file__).resolve().parents[1] / "data/rmp/ratings.json"
_STATUSES = {"matched", "unmatched", "ambiguous", "unrated", "unavailable"}
_cache_lock = Lock()
_cache = {"signature": None, "ratings": {}}


def read_snapshot(path=SNAPSHOT_PATH):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and data.get("schema_version") == 1 and isinstance(data.get("ratings"), dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _ratings_index():
    try:
        stat = SNAPSHOT_PATH.stat()
        signature = (str(SNAPSHOT_PATH), stat.st_mtime_ns, stat.st_size, stat.st_ino)
    except OSError:
        return {}
    with _cache_lock:
        if _cache["signature"] != signature:
            _cache.update(signature=signature, ratings=read_snapshot(SNAPSHOT_PATH).get("ratings", {}))
        return _cache["ratings"]


def _number(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and minimum <= value <= maximum else None


def public_entry(identity, stored=None, now=None):
    stored = stored if isinstance(stored, dict) else {}
    raw_status = stored.get("status")
    valid_status = isinstance(raw_status, str) and raw_status in _STATUSES
    status = "ambiguous" if identity.get("atlas_id_conflict") else raw_status if valid_status else "unavailable"
    # A cached numeric summary must retain its verified identity even after a failed refresh.
    verified = valid_status and stored.get("verified") is True and status in {"matched", "unrated", "unavailable"}
    same_identity = (stored.get("instructor_key") == identity["instructor_key"]
                     and normalized_name(stored.get("name")) == normalized_name(identity["name"]))
    target_school = professor_id(stored.get("school_id"))
    label = stored.get("override_label")
    reviewed_cross_school = (stored.get("cross_school_override") is True
                             and isinstance(label, str) and bool(label.strip()))
    same_school = bool(target_school) and ((target_school in SCHOOLS.values()
                  and target_school == identity["school_id"]) or reviewed_cross_school)
    url = profile_url(stored.get("professor_id")) if verified and same_identity and same_school else None
    fetched_at = stored.get("fetched_at") if url else None
    age_stale = bool(url and not fetched_at)
    if fetched_at:
        try:
            fetched = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
            age_stale = (now or datetime.now(timezone.utc)) - fetched > timedelta(days=30)
        except (ValueError, TypeError, AttributeError, OverflowError):
            fetched_at, age_stale = None, True
    result = {**identity, "professor_id": stored.get("professor_id") if url else None,
              "profile_url": url, "search_url": search_url(identity["name"], identity["school_id"]),
              "overall_rating": _number(stored.get("overall_rating"), 0, 5) if url else None,
              "difficulty": _number(stored.get("difficulty"), 0, 5) if url else None,
              "rating_count": _number(stored.get("rating_count"), 0, 10000000)
              if url and type(stored.get("rating_count")) is int else None,
              "fetched_at": fetched_at, "status": status,
              "stale": bool(stored.get("stale")) or age_stale}
    if url:
        result["school_id"] = target_school
    if status in {"matched", "unrated"} and not url:
        result["status"] = "unavailable"
    if stored.get("override_label"):
        result["override_label"] = str(stored["override_label"])
    return result


def enrich_sections_with_professor_ratings(sections):
    """Return new section dictionaries, preserving the authoritative roster."""
    index = _ratings_index()
    return [{**section, "professor_ratings": [public_entry(identity, index.get(identity["instructor_key"]))
             for identity in section_instructors(section)]} for section in sections]
