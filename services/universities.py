import json
import os
import re
from functools import lru_cache


DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "us_universities.json",
)
MAX_RESULTS = 20


def normalize_school_key(value):
    text = str(value or "").strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


@lru_cache(maxsize=1)
def load_universities():
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as handle:
            rows = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []

    cleaned = []
    for row in rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        cleaned.append({
            "id": str(row.get("id") or "").strip(),
            "name": name,
            "city": str(row.get("city") or "").strip(),
            "state": str(row.get("state") or "").strip(),
            "key": normalize_school_key(name),
        })
    return cleaned


def match_university(value):
    key = normalize_school_key(value)
    if not key:
        return None
    for school in load_universities():
        if school["key"] == key:
            return school
    return None


def school_payload(value):
    name = str(value or "").strip()
    if not name:
        return {
            "school": None,
            "school_key": None,
            "school_source": None,
            "scorecard_id": None,
        }

    match = match_university(name)
    if match:
        return {
            "school": match["name"],
            "school_key": match["key"],
            "school_source": "scorecard",
            "scorecard_id": match["id"] or None,
        }

    return {
        "school": name,
        "school_key": normalize_school_key(name),
        "school_source": "custom",
        "scorecard_id": None,
    }


def search_universities(query, limit=MAX_RESULTS):
    raw_query = str(query or "").strip()
    if not raw_query:
        return load_universities()[:limit]

    normalized_query = normalize_school_key(raw_query)
    query_words = [part for part in normalized_query.split("-") if part]
    scored = []

    for school in load_universities():
        key = school["key"]
        name_lower = school["name"].lower()
        score = 0
        if key == normalized_query:
            score += 100
        if key.startswith(normalized_query):
            score += 70
        if normalized_query and normalized_query in key:
            score += 45
        if raw_query and name_lower.startswith(f"{raw_query.lower()} university"):
            score += 25
        score += sum(8 for word in query_words if word in key)
        if raw_query.lower() in name_lower:
            score += 20
        if score:
            scored.append((score, school["name"].lower(), school))

    scored.sort(key=lambda item: (-item[0], item[1]))
    return [item[2] for item in scored[:limit]]
