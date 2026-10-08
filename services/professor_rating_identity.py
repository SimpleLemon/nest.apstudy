"""Conservative Atlas-to-RMP identity and safe public link construction."""
import re
import unicodedata
from collections import Counter
from urllib.parse import urlencode

SCHOOLS = {"Atlanta": "340", "Oxford": "2633"}
# Official Atlas undergraduate career selectors identify these institutions
# even when a section's meeting campus is the generic ONLIN@ONLINE.
CAREER_SCHOOLS = {"UCOL": "340", "UAH": "340", "UBUS": "340", "UNUR": "340", "UOXF": "2633"}
BASE_URL = "https://www.ratemyprofessors.com"
INSTRUCTOR_ID_FIELDS = ("atlas_id", "instructor_id", "id")


def normalized_name(value):
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    if text.count(",") == 1:
        last, first = text.split(",")
        text = f"{first} {last}"
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def full_name(value):
    parts = normalized_name(value).split()
    return len(parts) >= 2 and len(parts[0]) > 1 and len(parts[-1]) > 1


def instructor_ids(instructor):
    return {str(instructor[field]).strip() for field in INSTRUCTOR_ID_FIELDS
            if instructor.get(field) not in (None, "") and str(instructor[field]).strip()}


def instructor_identity_conflict(instructor):
    return bool(instructor.get("atlas_id_conflict")) or len(instructor_ids(instructor)) > 1


def preserve_instructor_ids(original, live):
    """Recover missing IDs only when both authoritative rosters identify one name."""
    if not isinstance(live, list):
        return live
    originals = {}
    for person in (original if isinstance(original, list) else []):
        if isinstance(person, dict) and (name := normalized_name(person.get("name"))):
            originals.setdefault(name, []).append(person)
    live_names = Counter(normalized_name(person.get("name")) for person in live if isinstance(person, dict))
    merged = []
    for person in live:
        if not isinstance(person, dict):
            merged.append(person)
            continue
        instructor = dict(person)
        name = normalized_name(instructor.get("name"))
        matches = originals.get(name, [])
        if instructor_identity_conflict(instructor):
            instructor["atlas_id_conflict"] = True
        elif not instructor_ids(instructor) and name:
            if live_names[name] > 1 or len(matches) > 1:
                instructor["atlas_id_conflict"] = True
            elif len(matches) == 1:
                instructor.update({field: matches[0][field] for field in INSTRUCTOR_ID_FIELDS
                                   if matches[0].get(field) not in (None, "")})
                if instructor_identity_conflict(matches[0]):
                    instructor["atlas_id_conflict"] = True
        merged.append(instructor)
    return merged


def school_for_section(section):
    campuses = [str(section.get(field) or "").strip().lower() for field in ("campus", "campus_description")]
    schools = set()
    for campus in campuses:
        if "oxford" in campus or campus in {"oxf", "ox"} or campus.startswith("oxf@"):
            schools.add("2633")
        if "atlanta" in campus or campus in {"atl", "emory", "emory college"} or campus.startswith("atl@"):
            schools.add("340")
    career = str(section.get("academic_career") or "").strip().upper()
    if career in CAREER_SCHOOLS:
        schools.add(CAREER_SCHOOLS[career])
    return schools.pop() if len(schools) == 1 else None


def professor_id(value):
    value = str(value or "")
    return value if re.fullmatch(r"[1-9][0-9]{0,11}", value) else None


def profile_url(value):
    identifier = professor_id(value)
    return f"{BASE_URL}/professor/{identifier}" if identifier else None


def search_url(name, school_id):
    school = str(school_id) if str(school_id) in SCHOOLS.values() else "0"
    return f"{BASE_URL}/search/professors/{school}?{urlencode({'q': name})}"


def section_instructors(section):
    """Never consume the user-editable singular instructor label."""
    school = school_for_section(section)
    seen = set()
    instructors = [person for person in section.get("instructors") or [] if isinstance(person, dict)]
    names = Counter(normalized_name(person.get("name")) for person in instructors)
    for instructor in instructors:
        if not isinstance(instructor, dict):
            continue
        name = str(instructor.get("name") or "").strip()
        if not name or normalized_name(name) in {"staff", "tba", "to be announced"}:
            continue
        ids = instructor_ids(instructor)
        conflict = instructor_identity_conflict(instructor) or (not ids and names[normalized_name(name)] > 1)
        identity = (f"conflict:name:{normalized_name(name)}" if conflict else
                    f"atlas:{next(iter(ids))}" if ids else f"name:{normalized_name(name)}")
        key = f"{school or 'unknown'}:{identity}"
        if key in seen:
            continue
        seen.add(key)
        yield {"instructor_key": key, "name": name, "school_id": school,
               **({"atlas_id_conflict": True} if conflict else {})}
