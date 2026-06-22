#!/usr/bin/env python3
"""Add canonical starred GER tags to scraped course JSON files."""

from __future__ import annotations

import json
import os
import sys
from typing import Iterable

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from services.atlas_client import (  # noqa: E402
    GENERAL_ED_COMPOSITE_REQUIREMENTS,
    GENERAL_ED_REQUIREMENT_ALIASES,
    STARRED_GENERAL_ED_REQUIREMENTS,
    _canonical_general_ed_requirement,
    _general_ed_match_tokens,
    _normalize_requirement_token,
    _requirement_values,
)

TERMS = ("Spring_2026", "Fall_2026")


def _tokens_for_requirement(requirement: str) -> set[str]:
    return _general_ed_match_tokens(requirement)


def _canonical_tags_for_values(values: Iterable[str]) -> set[str]:
    tagged: set[str] = set()
    value_list = [str(value).strip() for value in values if str(value or "").strip()]
    if not value_list:
        return tagged

    for requirement in STARRED_GENERAL_ED_REQUIREMENTS:
        match_tokens = _tokens_for_requirement(requirement)
        if not match_tokens:
            continue
        for value in value_list:
            value_token = _normalize_requirement_token(value)
            if not value_token:
                continue
            if value_token in match_tokens or value_token.rstrip("*") in match_tokens:
                tagged.add(requirement)
                break

    for requirement, parts in GENERAL_ED_COMPOSITE_REQUIREMENTS.items():
        if all(
            any(
                _normalize_requirement_token(value) in _tokens_for_requirement(part)
                or _normalize_requirement_token(value).rstrip("*") in _tokens_for_requirement(part)
                for value in value_list
                if _normalize_requirement_token(value)
            )
            for part in parts
        ):
            tagged.add(requirement)

    return tagged


def _merge_requirements(existing: Iterable[str], additions: Iterable[str]) -> list[str]:
    merged: list[str] = []
    for value in existing:
        text = str(value or "").strip()
        if text and text not in merged:
            merged.append(text)
    for value in additions:
        text = str(value or "").strip()
        if text and text not in merged:
            merged.append(text)
    return merged


def enrich_course_file(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)

    changed = False
    course_values = _requirement_values(data)
    course_tags = _canonical_tags_for_values(course_values)
    if course_tags:
        requirements = _merge_requirements(data.get("requirements") or [], course_tags)
        if requirements != (data.get("requirements") or []):
            data["requirements"] = requirements
            changed = True
        designation = data.get("requirement_designation")
        if not designation and requirements:
            data["requirement_designation"] = requirements[0]
            changed = True

    for section in data.get("sections") or []:
        section_values = _requirement_values(section, data)
        section_tags = _canonical_tags_for_values(section_values)
        if not section_tags:
            continue
        requirements = _merge_requirements(section.get("requirements") or [], section_tags)
        if requirements != (section.get("requirements") or []):
            section["requirements"] = requirements
            changed = True
        designation = section.get("requirement_designation")
        if not designation and requirements:
            section["requirement_designation"] = requirements[0]
            changed = True

    if changed:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
    return changed


def main() -> int:
    changed_files = 0
    for term in TERMS:
        term_dir = os.path.join(PROJECT_ROOT, term)
        if not os.path.isdir(term_dir):
            continue
        for subject in sorted(os.listdir(term_dir)):
            subject_dir = os.path.join(term_dir, subject)
            if not os.path.isdir(subject_dir):
                continue
            for filename in sorted(os.listdir(subject_dir)):
                if not filename.endswith(".json"):
                    continue
                path = os.path.join(subject_dir, filename)
                if enrich_course_file(path):
                    changed_files += 1
    print(f"Updated {changed_files} course files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
