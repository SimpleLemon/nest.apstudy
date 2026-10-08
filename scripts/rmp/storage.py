"""Scoped Atlas roster loading and durable, atomic RMP cache publication."""
import json
import os
import re
import tempfile
from pathlib import Path

from services.atlas_catalog_store import CatalogStore
from services.professor_rating_identity import section_instructors

TERM_PATTERN = re.compile(r"^(?:Spring|Summer|Fall|Winter)_\d{4}$")


def load_roster(root, terms, *, with_metadata=False):
    view = CatalogStore(root).view()
    roster = {}
    metadata = view.term_metadata()
    careers = {str(item.get("value", "")).upper(): item for item in view.registry.get("careers", [])
               if isinstance(item, dict)}
    scopes = {}
    for term in terms:
        if not TERM_PATTERN.fullmatch(term):
            raise ValueError(f"Invalid term: {term}")
        current = view.current_path(term)
        if not current:
            raise ValueError(f"No active or legacy catalog for {term}")
        term_meta = metadata.get(term, {})
        certified = term_meta.get("status") == "complete" and term_meta.get("coverage", {}).get("scope") == "undergraduate"
        if term_meta.get("status") == "complete" and not certified:
            raise ValueError(f"Published snapshot has no undergraduate scope certification: {term}")
        scopes[term] = {"scope": "undergraduate" if certified else "legacy/unverified",
                        "unknown_career_sections": 0, "excluded_sections": 0}
        for path in sorted(current.glob("*/*.json")):
            if not path.resolve().is_relative_to(current.resolve()):
                raise ValueError("Catalog file escaped the active snapshot")
            course = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(course, dict) or not isinstance(course.get("sections", []), list):
                raise ValueError(f"Invalid course roster: {path}")
            for section in course.get("sections") or []:
                if not isinstance(section, dict):
                    raise ValueError(f"Invalid section roster: {path}")
                career = str(section.get("academic_career") or course.get("academic_career") or "").upper()
                if not certified:
                    career_meta = careers.get(career, {})
                    label = str(career_meta.get("label", ""))
                    undergraduate = (career_meta.get("undergraduate") is True
                                     or career in {"UGRD", "UNDERGRADUATE", "UG"}
                                     or bool(re.search(r"undergrad|emory college|oxford|bachelor", label, re.I)))
                    if career_meta.get("undergraduate") is False or (career and not undergraduate):
                        scopes[term]["excluded_sections"] += 1
                        continue
                    if not career:
                        scopes[term]["unknown_career_sections"] += 1
                canonical = {**section, "academic_career": career,
                             "campus": section.get("campus") or course.get("campus"),
                             "campus_description": section.get("campus_description") or course.get("campus_description")}
                for identity in section_instructors(canonical):
                    key = identity["instructor_key"]
                    existing = roster.setdefault(key, {**identity, "terms": []})
                    if term not in existing["terms"]:
                        existing["terms"].append(term)
    entries = list(roster.values())
    return (entries, {"catalog_metadata": {term: metadata.get(term) for term in terms}, "roster_scope": scopes}) if with_metadata else entries


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".ratings-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(data, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
