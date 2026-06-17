"""
services/atlas_client.py

Reads scraped Atlas course data from disk and returns structured dicts.
Data lives in atlas-data/{term}/{SUBJECT}/{catalog}.json, written by
the one-time bulk scraper (atlasMainScraper.js) [3] [4].

All functions return plain Python dicts/lists suitable for JSON serialization.
The blueprint layer (atlas_api.py) handles Flask response formatting.
"""

import os
import re
import json
import requests
from datetime import datetime, timedelta
from threading import Lock

# Resolve project root from services/.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COURSE_DATA_ROOT = _PROJECT_ROOT

TERM_DIR_PATTERN = re.compile(r"^[A-Za-z]+_\d{4}$")
TERM_SEASON_ORDER = {
    "Spring": 1,
    "Summer": 2,
    "Fall": 3,
    "Winter": 4,
}
ATLAS_BASE_URL = "https://atlas.emory.edu/api/"
ATLAS_TERM_SRCDB = {
    "Spring_2026": "5261",
    "Fall_2026": "5269",
}
ATLAS_REQUIRED_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://atlas.emory.edu",
    "Referer": "https://atlas.emory.edu/",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}
ATLAS_DAY_MAP = {
    "0": "Mon",
    "1": "Tue",
    "2": "Wed",
    "3": "Thu",
    "4": "Fri",
    "5": "Sat",
    "6": "Sun",
}
ENROLLMENT_STATUS_MAP = {"O": "Open", "C": "Closed", "W": "Waitlist"}
SEATS_AVAILABLE_KEYS = (
    "seats_available",
    "seatsAvailable",
    "available_seats",
    "availableSeats",
    "seats_avail",
    "seatsAvail",
    "avail",
    "open_seats",
    "openSeats",
)
CAPACITY_KEYS = (
    "capacity",
    "max_enrl",
    "maxEnrollment",
    "seats_capacity",
    "seatsCapacity",
    "section_capacity",
    "sectionCapacity",
)
LOCATION_KEYS = ("location", "loc", "room", "building", "bldg_room", "bldgRoom")
COURSE_DESCRIPTION_KEYS = (
    "course_description",
    "description",
    "catalog_description",
    "desc",
)
REQUIREMENT_KEYS = ("requirement_designation", "requirement", "ger", "attributes")
CAMPUS_KEYS = (
    "campus",
    "campus_description",
    "campusDescription",
    "campus_descr",
    "campusDescr",
)
CAMPUS_FILTER_ALIASES = {
    "atlanta": {"atlanta", "main", "emory", "emory university", "atlanta campus", "main campus"},
    "oxford": {"oxford", "emory oxford", "emory university-oxford", "oxford college"},
}
OXFORD_SUBJECT_PREFIXES = ("OX",)

# ── In-memory cache ──────────────────────────────────────────────────────────
# Directory listings change only on re-scrape, so caching them avoids
# repeated os.listdir calls. Cache is invalidated after TTL expires
# or manually via invalidate_cache().

_cache = {}
_cache_lock = Lock()
_CACHE_TTL = timedelta(minutes=30)


def _cache_get(key):
    """Return cached value if it exists and has not expired, else None."""
    with _cache_lock:
        entry = _cache.get(key)
        if entry and datetime.utcnow() - entry["ts"] < _CACHE_TTL:
            return entry["data"]
        return None


def _cache_set(key, data):
    """Store a value in the cache with a current timestamp."""
    with _cache_lock:
        _cache[key] = {"data": data, "ts": datetime.utcnow()}


def invalidate_cache():
    """Clear the entire cache. Call after a re-scrape."""
    with _cache_lock:
        _cache.clear()


# ── Path helpers ─────────────────────────────────────────────────────────────

def _term_path(term):
    """Return the absolute path to a term's data directory."""
    return os.path.join(COURSE_DATA_ROOT, term)


def _term_sort_key(term_name):
    """Sort terms by year descending, then seasonal order descending."""
    try:
        season, year_str = term_name.split("_", 1)
        year = int(year_str)
    except (ValueError, AttributeError):
        return (0, 0, term_name)

    season_rank = TERM_SEASON_ORDER.get(season, 0)
    return (year, season_rank, term_name)


def _discover_terms_uncached():
    """Discover top-level term directories like Fall_2026."""
    if not os.path.isdir(COURSE_DATA_ROOT):
        return []

    terms = []
    for entry in os.listdir(COURSE_DATA_ROOT):
        if entry.startswith("."):
            continue
        full_path = os.path.join(COURSE_DATA_ROOT, entry)
        if not os.path.isdir(full_path):
            continue
        if TERM_DIR_PATTERN.match(entry):
            terms.append(entry)

    return sorted(terms, key=_term_sort_key, reverse=True)


def _discover_terms():
    cache_key = "terms"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    terms = _discover_terms_uncached()
    _cache_set(cache_key, terms)
    return terms


def _default_term():
    terms = _discover_terms()
    return terms[0] if terms else None


def get_default_term():
    """Return a best-effort default term for legacy callers."""
    return _default_term() or "Fall_2026"


# Backward-compatible export used by existing imports in settings blueprint.
DEFAULT_TERM = get_default_term()


def _validate_term(term):
    """
    Validate and return the term string.
    Returns None if the term is not in the allowed set.
    """
    if term not in _discover_terms():
        return None
    return term


def _safe_path(base, *parts):
    """
    Join path components and verify the result stays within the base directory.
    Returns the resolved path, or None if traversal is detected.
    """
    joined = os.path.join(base, *parts)
    resolved = os.path.realpath(joined)
    if not resolved.startswith(os.path.realpath(base)):
        return None
    return resolved


def _coerce_int(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        match = re.search(r"-?\d+", str(value))
        return int(match.group(0)) if match else None


def _first_int(mapping, keys):
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        parsed = _coerce_int(mapping.get(key))
        if parsed is not None:
            return parsed
    return None


def _normalize_query_text(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _compact_query_text(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _safe_limit(value, default=100, maximum=500):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(parsed, maximum))


def _safe_offset(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def _first_value(mapping, keys):
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        value = mapping.get(key)
        if value not in (None, "", []):
            return value
    return None


def _normalize_campus_value(value, subject=None):
    raw = str(value or "").strip()
    lowered = raw.lower()
    if "oxford" in lowered:
        return "Oxford"
    if lowered in CAMPUS_FILTER_ALIASES["atlanta"] or "atlanta" in lowered or "main" in lowered:
        return "Atlanta"
    if str(subject or "").upper().startswith(OXFORD_SUBJECT_PREFIXES):
        return "Oxford"
    return raw or None


def _campus_matches(section, campus):
    normalized = str(campus or "").strip().lower()
    if not normalized or normalized == "all":
        return True
    canonical = "oxford" if "oxford" in normalized else "atlanta" if normalized in CAMPUS_FILTER_ALIASES["atlanta"] else normalized
    section_campus = _normalize_campus_value(
        section.get("campus") or section.get("campus_description"),
        subject=section.get("subject"),
    )
    if not section_campus:
        # Existing local scrapes predate campus capture and contain Atlanta sections only.
        return canonical == "atlanta"
    section_lower = section_campus.lower()
    if canonical == "oxford":
        return "oxford" in section_lower
    if canonical == "atlanta":
        return section_lower in CAMPUS_FILTER_ALIASES["atlanta"] or "atlanta" in section_lower or "main" in section_lower
    return canonical in section_lower


def _has_starred_requirement(section):
    values = [
        section.get("requirement_designation"),
        section.get("requirement"),
        section.get("ger"),
        section.get("attributes"),
    ]
    return any("*" in str(value or "") for value in values)


def _requirement_matches(section, requirement):
    normalized = str(requirement or "").strip().lower()
    if not normalized or normalized == "all":
        return True
    if normalized in {"starred", "starred-ger", "ger_starred"}:
        return _has_starred_requirement(section)
    values = [
        section.get("requirement_designation"),
        section.get("requirement"),
        section.get("ger"),
        section.get("attributes"),
    ]
    return any(normalized in str(value or "").lower() for value in values)


def _normalize_enrollment_status(value):
    raw = str(value or "").strip()
    if not raw:
        return "Unknown"
    return ENROLLMENT_STATUS_MAP.get(raw.upper(), raw.title() if raw.islower() else raw)


def _normalize_instructors(value):
    if not value:
        return []
    if isinstance(value, list):
        instructors = []
        for item in value:
            if isinstance(item, dict):
                name = str(item.get("name") or item.get("instructor") or "").strip()
                email = str(item.get("email") or item.get("mail") or "").strip()
            else:
                name = str(item or "").strip()
                email = ""
            if name:
                instructors.append({"name": name, "email": email or None})
        return instructors
    names = [
        part.strip()
        for part in re.split(r"\s*(?:;|, and | and )\s*", str(value))
        if part.strip()
    ]
    return [{"name": name, "email": None} for name in names if name and name != "TBA"]


def _parse_meeting_times(raw):
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    meetings = []
    for meeting in parsed:
        if not isinstance(meeting, dict):
            continue
        meetings.append({
            "day": ATLAS_DAY_MAP.get(str(meeting.get("meet_day")), f"Day{meeting.get('meet_day')}"),
            "start": str(meeting.get("start_time") or ""),
            "end": str(meeting.get("end_time") or ""),
        })
    return meetings


def _infer_seats_available(status, source):
    seats_available = _first_int(source, SEATS_AVAILABLE_KEYS)
    if seats_available is not None:
        return seats_available
    if str(status or "").strip().lower() == "closed":
        return 0
    return None


def build_section_id(term, subject, catalog, crn, section_number):
    return "|".join([
        str(term),
        str(subject).upper(),
        str(catalog),
        str(crn or "na"),
        str(section_number or "na"),
    ])


def parse_section_id(section_id):
    parts = str(section_id or "").split("|")
    if len(parts) != 5:
        return None
    term, subject, catalog, crn, section_number = parts
    return {
        "term": term.strip(),
        "subject": subject.strip().upper(),
        "catalog": catalog.strip(),
        "crn": "" if crn == "na" else crn.strip(),
        "section_number": "" if section_number == "na" else section_number.strip(),
    }


def _section_row_from_course_data(term_name, subject_name, catalog_number, course_data, section):
    course_code = course_data.get("course_code") or f"{subject_name} {catalog_number}"
    course_title = course_data.get("course_title") or ""
    section_summary = course_data.get("section_summary") or {}
    instructors_unique = course_data.get("instructors_unique") or []
    course_term = course_data.get("term") or term_name
    course_date_range = course_data.get("date_range") or {}
    schedule = section.get("schedule") or {}
    crn = str(section.get("crn") or "")
    section_number = str(section.get("section_number") or "")
    status = _normalize_enrollment_status(section.get("enrollment_status"))
    seats_available = _infer_seats_available(status, section)
    unique_id = build_section_id(course_term, subject_name, catalog_number, crn, section_number)
    instructors = _normalize_instructors(section.get("instructors") or section.get("instructor"))
    campus_value = _first_value(section, CAMPUS_KEYS) or _first_value(course_data, CAMPUS_KEYS)
    return {
        "id": unique_id,
        "term": course_term,
        "subject": subject_name,
        "catalog_number": str(catalog_number),
        "course_code": course_code,
        "course_title": course_title,
        "crn": crn,
        "section_number": section_number,
        "schedule_type": section.get("schedule_type") or "",
        "instructor": section.get("instructor") or "TBA",
        "instructors": instructors,
        "location": _first_value(section, LOCATION_KEYS),
        "enrollment_status": status,
        "enrollment_count": str(section.get("enrollment_count") or ""),
        "seats_available": seats_available,
        "enrollment_capacity": _first_int(section, CAPACITY_KEYS),
        "is_cancelled": bool(section.get("is_cancelled", False)),
        "schedule_display": schedule.get("display") or "TBA",
        "meetings": schedule.get("meetings") or [],
        "date_range": section.get("date_range") or course_date_range,
        "credit_hours": course_data.get("credit_hours"),
        "requirement_designation": _first_value(course_data, REQUIREMENT_KEYS),
        "campus": _normalize_campus_value(campus_value, subject=subject_name),
        "campus_description": campus_value,
        "course_description": _first_value(course_data, COURSE_DESCRIPTION_KEYS),
        "course_notes": course_data.get("course_notes"),
        "section_summary": section_summary,
        "instructors_unique": instructors_unique,
    }


def _split_course_code(code):
    trimmed = str(code or "").strip()
    if not trimmed:
        return "", ""
    parts = trimmed.rsplit(" ", 1)
    if len(parts) != 2:
        return trimmed.upper(), ""
    return parts[0].strip().upper(), parts[1].strip()


def _live_row_from_raw(term, raw):
    course_code = str(raw.get("code") or raw.get("course_code") or "").strip()
    subject, catalog = _split_course_code(course_code)
    crn = str(raw.get("crn") or "").strip()
    section_number = str(raw.get("no") or raw.get("section_number") or "").strip()
    status = _normalize_enrollment_status(raw.get("enrl_stat") or raw.get("enrollment_status"))
    seats_available = _infer_seats_available(status, raw)
    schedule_display = raw.get("meets") or raw.get("schedule_display") or "TBA"
    instructors = _normalize_instructors(raw.get("instructors") or raw.get("instr") or raw.get("instructor"))
    date_range = {
        "start": raw.get("start_date") or raw.get("startDate"),
        "end": raw.get("end_date") or raw.get("endDate"),
    }
    campus_value = _first_value(raw, CAMPUS_KEYS)
    return {
        "id": build_section_id(term, subject, catalog, crn, section_number),
        "term": term,
        "subject": subject,
        "catalog_number": catalog,
        "course_code": course_code,
        "course_title": raw.get("title") or raw.get("course_title") or "",
        "crn": crn,
        "section_number": section_number,
        "schedule_type": raw.get("schd") or raw.get("schedule_type") or "",
        "instructor": raw.get("instr") or raw.get("instructor") or "TBA",
        "instructors": instructors,
        "location": _first_value(raw, LOCATION_KEYS),
        "enrollment_status": status,
        "enrollment_count": str(raw.get("total") or raw.get("enrollment_count") or ""),
        "seats_available": seats_available,
        "enrollment_capacity": _first_int(raw, CAPACITY_KEYS),
        "is_cancelled": bool(raw.get("isCancelled") or raw.get("is_cancelled") or False),
        "schedule_display": schedule_display,
        "meetings": _parse_meeting_times(raw.get("meetingTimes") or raw.get("meetings")),
        "date_range": date_range,
        "credit_hours": _first_value(raw, ("credit_hours", "credits", "hours")),
        "requirement_designation": _first_value(raw, REQUIREMENT_KEYS),
        "campus": _normalize_campus_value(campus_value, subject=subject),
        "campus_description": campus_value,
        "course_description": _first_value(raw, COURSE_DESCRIPTION_KEYS),
        "course_notes": raw.get("course_notes") or raw.get("notes"),
        "live": True,
    }


def _section_search_blob(section):
    parts = [
        section.get("course_title"),
        section.get("course_code"),
        section.get("subject"),
        section.get("catalog_number"),
        section.get("crn"),
        section.get("section_number"),
        section.get("instructor"),
        section.get("credit_hours"),
        section.get("requirement_designation"),
        section.get("campus"),
        section.get("campus_description"),
        section.get("course_description"),
        section.get("course_notes"),
    ]
    for instructor in section.get("instructors") or []:
        if isinstance(instructor, dict):
            parts.extend([instructor.get("name"), instructor.get("email")])
        else:
            parts.append(instructor)
    for name in section.get("instructors_unique") or []:
        parts.append(name)
    return _normalize_query_text(" ".join(str(part) for part in parts if part not in (None, "")))


def _section_matches_time(section, days=None, time_start=None, time_end=None):
    day_set = {str(day).strip() for day in (days or []) if str(day).strip()}
    start_minutes = _coerce_int(time_start)
    end_minutes = _coerce_int(time_end)

    if not day_set and start_minutes is None and end_minutes is None:
        return True

    for meeting in section.get("meetings") or []:
        if day_set and meeting.get("day") not in day_set:
            continue
        if start_minutes is None and end_minutes is None:
            return True
        meeting_start = _coerce_int(meeting.get("start"))
        meeting_end = _coerce_int(meeting.get("end"))
        if meeting_start is None or meeting_end is None:
            continue
        range_start = start_minutes if start_minutes is not None else 0
        range_end = end_minutes if end_minutes is not None else 2400
        if meeting_start < range_end and meeting_end > range_start:
            return True

    return False


def _section_rank(section, query):
    normalized = _normalize_query_text(query)
    compact = _compact_query_text(query)
    if not normalized:
        return 100

    subject = str(section.get("subject") or "").lower()
    catalog = str(section.get("catalog_number") or "").lower()
    course_code = str(section.get("course_code") or f"{subject} {catalog}").lower()
    course_compact = _compact_query_text(course_code)
    crn = str(section.get("crn") or "").lower()
    section_number = str(section.get("section_number") or "").lower()
    title = str(section.get("course_title") or "").lower()
    instructor = str(section.get("instructor") or "").lower()
    blob = section.get("_search_blob") or _section_search_blob(section)

    if normalized == crn:
        return 0
    if compact and compact == course_compact:
        return 1
    if normalized == course_code:
        return 1
    if compact and compact == f"{subject}{catalog}":
        return 1
    if normalized == subject:
        return 2
    if catalog.startswith(normalized):
        return 3
    if course_code.startswith(normalized) or (compact and course_compact.startswith(compact)):
        return 4
    if title.startswith(normalized):
        return 5
    if instructor.startswith(normalized):
        return 6
    if normalized == section_number:
        return 7
    if normalized in blob or (compact and compact in _compact_query_text(blob)):
        return 8
    return None


def _srcdb_for_course(term, subject=None, catalog=None):
    if subject and catalog:
        course = get_course(subject, catalog, term)
        if "error" not in course and course.get("srcdb"):
            return str(course.get("srcdb"))
    return ATLAS_TERM_SRCDB.get(term)


def get_atlas_term_srcdb():
    """Return Atlas FOSE srcdb values for terms known to this app."""
    valid_terms = set(_discover_terms())
    return {
        term: srcdb
        for term, srcdb in ATLAS_TERM_SRCDB.items()
        if term in valid_terms
    }


def is_section_trackable(section):
    if not section:
        return False
    if section.get("is_cancelled"):
        return False
    status = str(section.get("enrollment_status") or "").strip().lower()
    seats_available = _coerce_int(section.get("seats_available"))
    if seats_available == 0:
        return True
    return status == "closed" and seats_available is None


# ── Public API ───────────────────────────────────────────────────────────────

def get_subjects(term=None):
    """
    Return a sorted list of subject codes that have data for the given term.

    Args:
        term: "Fall_2026" or "Spring_2026". Defaults to DEFAULT_TERM.

    Returns:
        dict with keys: term, subjects (list of str), count (int)
        or dict with key: error (str) if term is invalid or missing.
    """
    term = _validate_term(term or _default_term())
    if not term:
        return {"error": "Invalid term"}

    cache_key = f"subjects:{term}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    term_dir = _term_path(term)
    if not os.path.isdir(term_dir):
        return {"error": f"No data for term {term}"}

    subjects = sorted([
        entry for entry in os.listdir(term_dir)
        if os.path.isdir(os.path.join(term_dir, entry))
        and not entry.startswith(".")
    ])

    result = {"term": term, "subjects": subjects, "count": len(subjects)}
    _cache_set(cache_key, result)
    return result


def get_courses(subject, term=None):
    """
    Return a sorted list of catalog numbers for a subject in a given term.

    Args:
        subject: e.g., "CHEM", "BIOL". Case-insensitive (uppercased internally).
        term: "Fall_2026" or "Spring_2026". Defaults to DEFAULT_TERM.

    Returns:
        dict with keys: term, subject, courses (list of str), count (int)
        or dict with key: error (str).
    """
    term = _validate_term(term or _default_term())
    if not term:
        return {"error": "Invalid term"}

    subject = subject.upper().strip()
    cache_key = f"courses:{term}:{subject}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    subject_dir = _safe_path(_term_path(term), subject)
    if not subject_dir or not os.path.isdir(subject_dir):
        return {"error": f"Subject {subject} not found in {term}"}

    courses = sorted([
        os.path.splitext(f)[0]
        for f in os.listdir(subject_dir)
        if f.endswith(".json") and not f.startswith(".")
    ])

    result = {
        "term": term,
        "subject": subject,
        "courses": courses,
        "count": len(courses),
    }
    _cache_set(cache_key, result)
    return result


def get_course(subject, catalog, term=None):
    """
    Return the full JSON content of a specific course file.

    Args:
        subject: e.g., "CHEM". Case-insensitive.
        catalog: e.g., "150", "141L". Used as-is for filename lookup.
        term: "Fall_2026" or "Spring_2026". Defaults to DEFAULT_TERM.

    Returns:
        dict with the full course data from the JSON file,
        or dict with key: error (str).
    """
    term = _validate_term(term or _default_term())
    if not term:
        return {"error": "Invalid term"}

    subject = subject.upper().strip()
    catalog = catalog.strip()

    filepath = _safe_path(_term_path(term), subject, f"{catalog}.json")
    if not filepath or not os.path.isfile(filepath):
        return {"error": f"Course {subject} {catalog} not found in {term}"}

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        return {"error": f"Failed to read course data: {str(e)}"}


def search_courses(query, term=None):
    """
    Search for courses matching a query string.

    If the query contains a space (e.g., "CHEM 150"), it attempts a direct
    subject + catalog lookup first. If no space, it searches across all
    subjects for matching subject codes or catalog numbers.

    Args:
        query: search string, e.g., "CHEM 150", "BIOL", "141"
        term: "Fall_2026" or "Spring_2026". Defaults to DEFAULT_TERM.

    Returns:
        dict with keys: term, query, results (list of match dicts), count (int)
        or the full course dict if an exact match is found,
        or dict with key: error (str).
    """
    term = _validate_term(term or _default_term())
    if not term:
        return {"error": "Invalid term"}

    query = query.strip()
    if not query:
        return {"error": "Missing query"}

    sections_result = get_sections_index(
        term=term,
        include_cancelled=False,
        query=query,
        limit=60,
    )
    if "error" in sections_result:
        return sections_result

    seen_courses = set()
    results = []
    for section in sections_result.get("sections") or []:
        key = (
            section.get("term"),
            section.get("subject"),
            section.get("catalog_number"),
        )
        if key in seen_courses:
            continue
        seen_courses.add(key)
        results.append({
            "term": section.get("term"),
            "subject": section.get("subject"),
            "catalog": section.get("catalog_number"),
            "catalog_number": section.get("catalog_number"),
            "course_code": section.get("course_code"),
            "course_title": section.get("course_title"),
            "course_name": section.get("course_title"),
            "section_number": section.get("section_number"),
            "crn": section.get("crn"),
            "instructor": section.get("instructor"),
            "schedule_display": section.get("schedule_display"),
            "sections": [section],
        })

    return {
        "term": term,
        "query": query,
        "results": results,
        "count": len(results),
        "total": sections_result.get("total", len(results)),
    }


def get_terms():
    """
    Return dynamically discovered top-level term directories.

    Returns:
        dict with keys: terms (list[str]), default_term (str|None), count (int)
    """
    terms = _discover_terms()
    return {
        "terms": terms,
        "default_term": terms[0] if terms else None,
        "count": len(terms),
    }


def _section_number_sort_key(section_number):
    section_str = str(section_number or "")
    match = re.match(r"^(\d+)", section_str)
    if match:
        return (0, int(match.group(1)), section_str)
    return (1, float("inf"), section_str)


def get_sections_index(
    term=None,
    include_cancelled=True,
    query=None,
    limit=None,
    offset=0,
    days=None,
    time_start=None,
    time_end=None,
    campus=None,
    requirement=None,
):
    """
    Return flattened section rows for client-side course searching.

    Args:
        term: Term name like "Fall_2026", or None for all terms.
        include_cancelled: Whether cancelled sections should be included.
        query: Optional local search query. Atlas is not called.
        limit: Optional max results for query-backed searches.
        offset: Optional zero-based offset for paged query results.

    Returns:
        dict with keys: term, terms, sections (list), count (int)
        or dict with key: error (str).
    """
    all_terms = _discover_terms()
    if not all_terms:
        return {"error": "No term directories found"}

    if term:
        validated = _validate_term(term)
        if not validated:
            return {"error": "Invalid term"}
        terms_to_scan = [validated]
    else:
        terms_to_scan = list(all_terms)

    cache_key = f"sections-index:{term or 'ALL'}:{int(bool(include_cancelled))}"
    cached = _cache_get(cache_key)
    if cached:
        return _filter_sections_result(
            cached,
            query=query,
            limit=limit,
            offset=offset,
            days=days,
            time_start=time_start,
            time_end=time_end,
            campus=campus,
            requirement=requirement,
        )

    sections = []

    for term_name in terms_to_scan:
        term_dir = _term_path(term_name)
        if not os.path.isdir(term_dir):
            continue

        for subject_name in sorted(os.listdir(term_dir)):
            subject_path = os.path.join(term_dir, subject_name)
            if not os.path.isdir(subject_path) or subject_name.startswith("."):
                continue

            for filename in sorted(os.listdir(subject_path)):
                if not filename.endswith(".json") or filename.startswith("."):
                    continue

                filepath = os.path.join(subject_path, filename)
                try:
                    with open(filepath, "r", encoding="utf-8") as handle:
                        course_data = json.load(handle)
                except (json.JSONDecodeError, OSError):
                    continue

                catalog_number = str(course_data.get("catalog_number") or os.path.splitext(filename)[0])

                for section in course_data.get("sections", []):
                    is_cancelled = bool(section.get("is_cancelled", False))
                    if not include_cancelled and is_cancelled:
                        continue

                    sections.append(_section_row_from_course_data(
                        term_name,
                        subject_name,
                        catalog_number,
                        course_data,
                        section,
                    ))

    sections.sort(
        key=lambda row: (
            row.get("course_code", ""),
            _section_number_sort_key(row.get("section_number")),
            row.get("crn", ""),
        )
    )

    result = {
        "term": term,
        "terms": terms_to_scan,
        "sections": sections,
        "count": len(sections),
    }
    _cache_set(cache_key, result)
    return _filter_sections_result(
        result,
        query=query,
        limit=limit,
        offset=offset,
        days=days,
        time_start=time_start,
        time_end=time_end,
        campus=campus,
        requirement=requirement,
    )


def _filter_sections_result(
    result,
    query=None,
    limit=None,
    offset=0,
    days=None,
    time_start=None,
    time_end=None,
    campus=None,
    requirement=None,
):
    query = str(query or "").strip()
    has_schedule_filter = bool(days) or time_start not in (None, "") or time_end not in (None, "")
    has_campus_filter = str(campus or "").strip().lower() not in {"", "all"}
    has_requirement_filter = str(requirement or "").strip().lower() not in {"", "all"}
    if not query and not has_schedule_filter and not has_campus_filter and not has_requirement_filter and limit is None and not offset:
        return result

    ranked_sections = []
    for index, section in enumerate(result.get("sections") or []):
        if not _section_matches_time(section, days=days, time_start=time_start, time_end=time_end):
            continue
        if not _campus_matches(section, campus):
            continue
        if not _requirement_matches(section, requirement):
            continue
        rank = _section_rank(section, query) if query else 100
        if rank is None:
            continue
        ranked_sections.append((rank, index, section))

    ranked_sections.sort(
        key=lambda item: (
            item[0],
            item[2].get("course_code", ""),
            _section_number_sort_key(item[2].get("section_number")),
            item[2].get("crn", ""),
            item[1],
        )
    )

    total = len(ranked_sections)
    safe_offset = _safe_offset(offset)
    safe_limit = _safe_limit(limit) if limit is not None else total
    page = [section for _, _, section in ranked_sections[safe_offset:safe_offset + safe_limit]]
    return {
        **result,
        "query": query,
        "offset": safe_offset,
        "limit": safe_limit,
        "total": total,
        "sections": page,
        "count": len(page),
    }


def get_sections_by_ids(section_ids, include_cancelled=True):
    """
    Return only the requested section rows by unique section id.

    Args:
        section_ids: iterable of ids in form term|subject|catalog|crn|section.
        include_cancelled: Whether cancelled sections should be included.

    Returns:
        dict with keys: sections (list), count (int)
        or dict with key: error (str).
    """
    if not section_ids:
        return {"sections": [], "count": 0}

    requested_ids = {str(item).strip() for item in section_ids if str(item).strip()}
    if not requested_ids:
        return {"sections": [], "count": 0}

    files_to_scan = {}
    for section_id in requested_ids:
        parts = section_id.split("|")
        if len(parts) != 5:
            continue
        term, subject, catalog, _, _ = parts
        term = term.strip()
        subject = subject.strip().upper()
        catalog = catalog.strip()
        if not _validate_term(term):
            continue
        files_to_scan[(term, subject, catalog)] = section_id

    sections = []

    for term, subject, catalog in files_to_scan.keys():
        filepath = _safe_path(_term_path(term), subject, f"{catalog}.json")
        if not filepath or not os.path.isfile(filepath):
            continue

        try:
            with open(filepath, "r", encoding="utf-8") as handle:
                course_data = json.load(handle)
        except (json.JSONDecodeError, OSError):
            continue

        for section in course_data.get("sections", []):
            is_cancelled = bool(section.get("is_cancelled", False))
            if not include_cancelled and is_cancelled:
                continue

            row = _section_row_from_course_data(
                term,
                subject,
                catalog,
                course_data,
                section,
            )

            if row["id"] not in requested_ids:
                continue

            sections.append(row)

    sections.sort(
        key=lambda row: (
            row.get("course_code", ""),
            _section_number_sort_key(row.get("section_number")),
            row.get("crn", ""),
        )
    )

    return {
        "sections": sections,
        "count": len(sections),
    }


def fetch_live_subject_sections(term, subject, catalog=None, timeout=15):
    """
    Fetch live Atlas sections for a subject, optionally narrowed to a catalog.

    This mirrors the one-time scraper's FOSE search call and returns normalized
    section rows with live enrollment status and any available-seat fields Atlas
    exposes.
    """
    term = _validate_term(term or _default_term())
    if not term:
        return {"error": "Invalid term"}

    subject = str(subject or "").strip().upper()
    if not subject:
        return {"error": "Missing subject"}

    srcdb = _srcdb_for_course(term, subject, catalog)
    if not srcdb:
        return {"error": f"No Atlas srcdb configured for {term}"}

    try:
        response = requests.post(
            ATLAS_BASE_URL,
            params={"page": "fose", "route": "search"},
            json={
                "other": {"srcdb": srcdb},
                "criteria": [{"field": "subject", "value": subject}],
            },
            headers=ATLAS_REQUIRED_HEADERS,
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        return {"error": f"Live Atlas request failed: {exc}"}

    if not payload or payload == "":
        return {"error": "Live Atlas returned an empty response"}
    if isinstance(payload, dict) and payload.get("fatal"):
        return {"error": f"Live Atlas error: {payload.get('fatal')}"}

    raw_results = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(raw_results, list):
        raw_results = []

    catalog_filter = str(catalog or "").strip().upper()
    sections = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            continue
        row = _live_row_from_raw(term, raw)
        if row.get("subject") != subject:
            continue
        if catalog_filter and str(row.get("catalog_number") or "").upper() != catalog_filter:
            continue
        sections.append(row)

    sections.sort(
        key=lambda row: (
            row.get("course_code", ""),
            _section_number_sort_key(row.get("section_number")),
            row.get("crn", ""),
        )
    )
    return {"term": term, "subject": subject, "sections": sections, "count": len(sections)}


def fetch_live_section_status(term, subject, catalog, crn=None, section_number=None, timeout=15):
    """Fetch a single live Atlas section and return the normalized row."""
    result = fetch_live_subject_sections(term, subject, catalog=catalog, timeout=timeout)
    if "error" in result:
        return result

    wanted_crn = str(crn or "").strip()
    wanted_section = str(section_number or "").strip()
    for row in result.get("sections", []):
        crn_matches = not wanted_crn or str(row.get("crn") or "") == wanted_crn
        section_matches = not wanted_section or str(row.get("section_number") or "") == wanted_section
        if crn_matches and section_matches:
            return {"section": row}

    return {"error": "Live section not found"}


def get_meta():
    """
    Return the scrape metadata from _meta.json.

    Returns:
        dict with scrape timestamps, term statistics, and error lists,
        or dict with key: error (str) if no metadata file exists.
    """
    legacy_meta_path = os.path.join(_PROJECT_ROOT, "atlas-data", "_meta.json")
    root_meta_path = os.path.join(_PROJECT_ROOT, "_meta.json")
    meta_path = root_meta_path if os.path.isfile(root_meta_path) else legacy_meta_path

    if not os.path.isfile(meta_path):
        return {"error": "No scrape metadata found"}

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        return {"error": f"Failed to read metadata: {str(e)}"}
