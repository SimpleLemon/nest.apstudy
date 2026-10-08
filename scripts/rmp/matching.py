"""Exact school-scoped matching, reviewed overrides, and conservative retention."""
import math

from services.professor_rating_identity import SCHOOLS, full_name, normalized_name, professor_id
from scripts.rmp.public_pages import SourceUnavailable


def validate_overrides(document):
    if not isinstance(document, dict) or document.get("schema_version") != 1 or not isinstance(document.get("mappings"), dict):
        raise ValueError("Overrides require schema_version 1 and mappings object")
    for key, mapping in document["mappings"].items():
        if not isinstance(key, str) or ":" not in key or not isinstance(mapping, dict) or not professor_id(mapping.get("professor_id")):
            raise ValueError(f"Invalid professor mapping: {key}")
        school = professor_id(mapping.get("school_id"))
        if not school or (school not in SCHOOLS.values() and mapping.get("allow_cross_school") is not True):
            raise ValueError(f"Unknown school mapping: {key}")
        if not full_name(mapping.get("expected_name")):
            raise ValueError(f"Mapping requires a full expected RMP name: {key}")
        if not isinstance(mapping.get("label"), str) or not mapping["label"].strip():
            raise ValueError(f"Mapping requires an explanatory label: {key}")
        if school != key.split(":", 1)[0] and mapping.get("allow_cross_school") is not True:
            raise ValueError(f"Cross-school mapping requires allow_cross_school: {key}")
    return document["mappings"]


def _valid_score(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 5


def resolve(identity, source, override, timestamp):
    entry = {**identity, "professor_id": None, "overall_rating": None, "difficulty": None,
             "rating_count": None, "fetched_at": None, "status": "unmatched", "stale": False,
             "verified": False, "last_attempt_at": timestamp}
    if identity.get("atlas_id_conflict"):
        return {**entry, "status": "ambiguous", "error": "Conflicting Atlas instructor identity"}
    school = identity["school_id"]
    if school not in SCHOOLS.values() and not override:
        return {**entry, "status": "unavailable", "error": "Unknown Atlas campus"}
    expected_name = identity["name"]
    if override:
        validate_overrides({"schema_version": 1, "mappings": {identity["instructor_key"]: override}})
        school = professor_id(override["school_id"])
        expected_name = override["expected_name"]
        entry.update(override_label=override["label"], cross_school_override=override.get("allow_cross_school") is True)
        candidate_id = professor_id(override["professor_id"])
    else:
        if not full_name(expected_name):
            return {**entry, "status": "ambiguous"}
        matches = {professor_id(item.get("professor_id")) for item in source.search(school, expected_name)
                   if normalized_name(item.get("name")) == normalized_name(expected_name)
                   and str(item.get("school_id")) == school}
        matches.discard(None)
        if len(matches) != 1:
            return {**entry, "status": "ambiguous" if matches else "unmatched"}
        candidate_id = matches.pop()
    profile = source.profile(candidate_id)
    if (professor_id(profile.get("professor_id")) != candidate_id
            or str(profile.get("school_id")) != school
            or normalized_name(profile.get("name")) != normalized_name(expected_name)):
        # A changed or misdirected identity must never inherit an old numeric summary.
        return {**entry, "status": "ambiguous", "error": "Profile identity did not verify"}
    count = profile.get("rating_count")
    if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 10000000:
        raise SourceUnavailable("Profile rating count is missing or invalid")
    rating, difficulty = profile.get("overall_rating"), profile.get("difficulty")
    if count and not (_valid_score(rating) and _valid_score(difficulty)):
        raise SourceUnavailable("Profile rating summary is missing or invalid")
    return {**entry, "professor_id": candidate_id, "school_id": school, "verified": True,
            "overall_rating": rating if count else None, "difficulty": difficulty if count else None,
            "rating_count": count, "fetched_at": profile.get("fetched_at") or timestamp, "status": "matched" if count else "unrated"}


def refresh_entries(roster, old, source, overrides, timestamp):
    ratings = dict(old)
    counts = {}
    failures = []
    for identity in roster:
        key = identity["instructor_key"]
        try:
            result = resolve(identity, source, overrides.get(key), timestamp)
        except SourceUnavailable as error:
            prior = old.get(key, {})
            prior = prior if isinstance(prior, dict) else {}
            if (prior.get("instructor_key") != key
                    or normalized_name(prior.get("name")) != normalized_name(identity["name"])):
                prior = {}
            # Retain verified previous values and their original fetched_at, never restamp them.
            result = {**prior, **identity, "school_id": prior.get("school_id", identity["school_id"]), "status": "unavailable", "stale": bool(prior.get("verified")),
                      "last_attempt_at": timestamp, "error": str(error)}
            failures.append({"instructor_key": key, "reason": str(error)})
        if result["status"] == "unavailable" and not any(failure["instructor_key"] == key for failure in failures):
            failures.append({"instructor_key": key, "reason": result.get("error", "Summary unavailable")})
        ratings[key] = result
        status = result["status"]
        counts[status] = counts.get(status, 0) + 1
    return ratings, {"instructors": len(roster), "counts": counts, "failures": failures}
