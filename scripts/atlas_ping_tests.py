#!/usr/bin/env python3
"""
Diagnostic Atlas FOSE pings for planning scraper changes.

This script intentionally does not modify the scraper or course corpus. It sends
small, explicit FOSE search requests and reports which candidate criteria Atlas
appears to honor.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import requests

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from services.atlas_client import (
    ATLAS_BASE_URL,
    ATLAS_REQUIRED_HEADERS,
    ATLAS_TERM_SRCDB,
    STARRED_GENERAL_ED_REQUIREMENTS,
    parse_atlas_details_payload,
)


DEFAULT_TERM = "Fall_2026"
DEFAULT_SUBJECT = "CHEM"
DEFAULT_REQUIREMENT = "Quantitative Reasoning(*)"
DEFAULT_CAMPUS = "Oxford"
DEFAULT_DELAY_SECONDS = 1.0
IGNORED_FILTER_RATIO = 0.8
IGNORED_FILTER_MIN_ROWS = 1000

CAMPUS_FIELD_CANDIDATES = (
    "campus",
    "campus_description",
    "campusDescription",
    "campus_descr",
    "campusDescr",
    "camp",
    "campus_code",
)
CAMPUS_VALUE_CANDIDATES = (
    "Oxford",
    "Oxford College",
    "OXFORD",
    "O",
)
REQUIREMENT_FIELD_CANDIDATES = (
    "requirement",
    "requirements",
    "requirement_designation",
    "ger",
    "ge_req",
    "geReq",
    "rqmt",
    "rqmt_descr",
    "attribute",
    "attributes",
)


@dataclass(frozen=True)
class PingResult:
    name: str
    criteria: list[dict[str, str]]
    ok: bool
    count: int
    sample_codes: tuple[str, ...]
    sample_keys: tuple[str, ...]
    error: str | None = None
    fatal: str | None = None


def atlas_post(
    srcdb: str,
    criteria: list[dict[str, str]],
    timeout: int = 20,
    route: str = "search",
    extra_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"other": {"srcdb": srcdb}}
    if route == "search":
        body["criteria"] = criteria
    if extra_body:
        body.update(extra_body)
    response = requests.post(
        ATLAS_BASE_URL,
        params={"page": "fose", "route": route},
        json=body,
        headers=ATLAS_REQUIRED_HEADERS,
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return {"results": []}
    return payload


def ping(
    name: str,
    srcdb: str,
    criteria: list[dict[str, str]],
    *,
    timeout: int = 20,
) -> PingResult:
    try:
        payload = atlas_post(srcdb, criteria, timeout=timeout)
    except (requests.RequestException, ValueError) as exc:
        return PingResult(name, criteria, False, 0, (), (), error=str(exc))

    fatal = str(payload.get("fatal") or "").strip() or None
    results = payload.get("results") if isinstance(payload.get("results"), list) else []
    sample = [row for row in results[:5] if isinstance(row, dict)]
    sample_codes = tuple(str(row.get("code") or row.get("course_code") or "") for row in sample)
    sample_keys = tuple(sorted({key for row in sample for key in row.keys()}))
    return PingResult(name, criteria, fatal is None, len(results), sample_codes, sample_keys, fatal=fatal)


def criterion(field: str, value: str) -> dict[str, str]:
    return {"field": field, "value": value}


def normalize_text(value: Any) -> str:
    return "".join(char for char in str(value or "").lower() if char.isalnum())


def result_has_value_sample(rows: list[dict[str, Any]], value: str) -> bool:
    needle = normalize_text(value)
    if not needle:
        return False
    for row in rows[:25]:
        haystack = normalize_text(json.dumps(row, sort_keys=True))
        if needle in haystack:
            return True
    return False


def classify_filter_result(baseline_count: int, filtered_count: int) -> str:
    if filtered_count <= 0:
        return "no_matches"
    if baseline_count <= 0:
        return "needs_review"
    if filtered_count >= IGNORED_FILTER_MIN_ROWS and filtered_count >= baseline_count * IGNORED_FILTER_RATIO:
        return "probably_ignored"
    if filtered_count < baseline_count:
        return "candidate"
    if filtered_count == baseline_count:
        return "probably_ignored"
    return "needs_review"


def print_result(result: PingResult, baseline_count: int | None = None) -> None:
    status = "ok" if result.ok else "error"
    classification = ""
    if baseline_count is not None and result.ok:
        classification = f" [{classify_filter_result(baseline_count, result.count)}]"
    print(f"{result.name}: {status}, {result.count} rows{classification}")
    if result.error:
        print(f"  error: {result.error}")
    if result.fatal:
        print(f"  fatal: {result.fatal}")
    if result.sample_codes:
        print(f"  sample codes: {', '.join(code for code in result.sample_codes if code) or '(none)'}")
    if result.sample_keys:
        print(f"  sample keys: {', '.join(result.sample_keys[:40])}")
    print(f"  criteria: {json.dumps(result.criteria)}")


def build_pings(args: argparse.Namespace) -> list[tuple[str, list[dict[str, str]]]]:
    subject = str(args.subject).strip().upper()
    pings: list[tuple[str, list[dict[str, str]]]] = [
        ("baseline subject", [criterion("subject", subject)]),
    ]

    for field in args.campus_fields:
        for value in args.campus_values:
            pings.append((
                f"campus {field}={value}",
                [criterion("subject", subject), criterion(field, value)],
            ))

    for field in args.requirement_fields:
        pings.append((
            f"requirement {field}={args.requirement}",
            [criterion(field, args.requirement)],
        ))
        pings.append((
            f"subject+requirement {field}={args.requirement}",
            [criterion("subject", subject), criterion(field, args.requirement)],
        ))

    return pings


def print_details_checklist(srcdb: str, timeout: int = 20) -> None:
    acceptance = (
        ("2760", "CHEM 150"),
        ("4196", "ENG_OX 185"),
    )
    print("Atlas details acceptance checklist:")
    for crn, label in acceptance:
        search_payload = atlas_post(srcdb, [criterion("crn", crn)], timeout=timeout)
        results = search_payload.get("results") if isinstance(search_payload.get("results"), list) else []
        search_row = next((row for row in results if isinstance(row, dict) and str(row.get("crn") or "") == crn), None)
        if not search_row:
            print(f"  {label} ({crn}): search miss")
            continue
        key = str(search_row.get("key") or "").strip()
        details_payload = atlas_post(
            srcdb,
            [],
            timeout=timeout,
            route="details",
            extra_body={"group": f"key:{key}"},
        )
        if details_payload.get("fatal"):
            print(f"  {label} ({crn}): details error: {details_payload.get('fatal')}")
            continue
        parsed = parse_atlas_details_payload(details_payload, search_row)
        print(f"  {label} ({crn}):")
        for field in (
            "credit_hours",
            "seats_available",
            "enrollment_capacity",
            "grading_mode",
            "instruction_method",
            "enrollment_status",
            "requirement_designation",
            "campus_description",
            "location",
        ):
            print(f"    {field}: {parsed.get(field)}")
    print("")


def parse_list(value: str | None, fallback: tuple[str, ...]) -> list[str]:
    if not value:
        return list(fallback)
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ping Atlas FOSE criteria candidates without modifying scraper output.")
    parser.add_argument("--term", default=DEFAULT_TERM, choices=sorted(ATLAS_TERM_SRCDB.keys()))
    parser.add_argument("--subject", default=DEFAULT_SUBJECT)
    parser.add_argument("--requirement", default=DEFAULT_REQUIREMENT, choices=STARRED_GENERAL_ED_REQUIREMENTS)
    parser.add_argument("--campus-values", default=None, help="Comma-separated campus values to test.")
    parser.add_argument("--campus-fields", default=None, help="Comma-separated campus field names to test.")
    parser.add_argument("--requirement-fields", default=None, help="Comma-separated requirement field names to test.")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS)
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--details", action="store_true", help="Print details checklist for CHEM 150 and ENG_OX 185.")
    args = parser.parse_args()
    args.campus_values = parse_list(args.campus_values, CAMPUS_VALUE_CANDIDATES)
    args.campus_fields = parse_list(args.campus_fields, CAMPUS_FIELD_CANDIDATES)
    args.requirement_fields = parse_list(args.requirement_fields, REQUIREMENT_FIELD_CANDIDATES)
    return args


def main() -> int:
    args = parse_args()
    srcdb = ATLAS_TERM_SRCDB[args.term]
    print(f"Atlas ping diagnostics: term={args.term} srcdb={srcdb} subject={args.subject}")
    print("No files will be written.\n")

    if args.details:
        print_details_checklist(srcdb, timeout=args.timeout)
        return 0

    pings = build_pings(args)
    baseline_count: int | None = None
    for index, (name, criteria) in enumerate(pings, start=1):
        result = ping(name, srcdb, criteria, timeout=args.timeout)
        if index == 1:
            baseline_count = result.count
        print_result(result, baseline_count if index > 1 else None)
        if index < len(pings):
            time.sleep(max(0.0, args.delay))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
