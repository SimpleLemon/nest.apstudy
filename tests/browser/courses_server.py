"""Loopback-only course preview with explicitly synthetic catalog and ratings.

Run ``.venv/bin/python tests/browser/courses_server.py`` and visit
``http://127.0.0.1:8806/__test__/courses/auth``. All state is disposable.
"""
from __future__ import annotations

import json
import os
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = str(Path(__file__).resolve().parents[2])
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from flask import abort, redirect, request
from flask_login import login_user

from tests.browser.storage_server import OWNER_ID, storage_test_app

TERM = "Fall_2026"
STAMP = "2026-10-07T12:00:00Z"


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def seed_catalog(root):
    """Create over 500 searchable sections and every ratings display state."""
    people = [
        ("Jane Fixture", "matched", 4.2, 18),
        ("Colin Fixture", "unavailable", 3.8, 27),
        ("Casey Fixture", "unrated", None, 0),
        ("Jordan Fixture", "ambiguous", None, None),
        ("Taylor Fixture", "unmatched", None, None),
        ("Riley Fixture", "unavailable", None, None),
    ]
    ratings = {}
    for index, (name, status, score, count) in enumerate(people):
        key = f"340:atlas:fixture-{index}"
        verified = status in {"matched", "unrated"} or score is not None
        ratings[key] = {
            "instructor_key": key, "name": name, "school_id": "340", "status": status,
            "verified": verified, "professor_id": str(900000 + index) if verified else None,
            "overall_rating": score, "difficulty": 2.9 if score is not None else None,
            "rating_count": count, "fetched_at": STAMP if verified else None,
            "stale": score is not None and status == "unavailable",
        }
    for index in range(610):
        person = index % len(people)
        name = people[person][0]
        catalog = str(100 + index)
        instructors = [{"name": name, "atlas_id": f"fixture-{person}", "role": "Primary Instructor"}]
        if index == 0:
            instructors.append({"name": people[1][0], "atlas_id": "fixture-1"})
        _write(root / f"data/atlas/snapshots/{TERM}/fixture/DEMO/{catalog}.json", {
            "term": TERM, "srcdb": "5269", "subject": "DEMO", "catalog_number": catalog,
            "course_code": f"DEMO {catalog}", "course_title": f"Synthetic course {index + 1}",
            "credit_hours": "3", "campus": "Atlanta", "course_description": "Synthetic browser verification course.",
            "sections": [{
                "crn": str(10000 + index), "section_number": "1", "atlas_key": str(index),
                "instructor": name, "instructors": instructors, "campus": "Atlanta",
                "academic_career": "UCOL", "schedule_type": "LEC", "enrollment_status": "Open",
                "seats_available": 8, "enrollment_capacity": 24, "is_cancelled": False,
                "date_range": {"start": "2026-08-26", "end": "2026-12-09"},
                "schedule": {"display": "MW 10:00–11:15a", "meetings": [
                    {"day": "Mon", "start": "1000", "end": "1115"},
                    {"day": "Wed", "start": "1000", "end": "1115"},
                ]},
            }],
        })
    _write(root / "data/atlas/manifest.json", {"version": 1, "terms": {TERM: {
        "srcdb": "5269", "label": "Fall 2026", "status": "complete", "generation": "fixture",
        "path": f"snapshots/{TERM}/fixture", "last_successful_refresh": STAMP,
        "coverage": {"scope": "undergraduate", "sections": 610}, "previous_generations": [],
    }}})
    _write(root / "data/rmp/ratings.json", {"schema_version": 1, "source": "synthetic-browser-fixture", "ratings": ratings})


@contextmanager
def courses_test_app(port=8806):
    with storage_test_app(port=port) as app, ExitStack() as stack:
        from blueprints import courses
        from services import atlas_client, atlas_live_verification, calendar_ics_courses, database, professor_ratings
        from models import User

        root = Path(app.extensions["storage_test_fixture"]["temporary_directory"]) / "courses"
        seed_catalog(root)
        stack.enter_context(patch.object(atlas_client, "COURSE_DATA_ROOT", str(root)))
        stack.enter_context(patch.object(calendar_ics_courses, "COURSE_DATA_ROOT", root))
        stack.enter_context(patch.object(professor_ratings, "SNAPSHOT_PATH", root / "data/rmp/ratings.json"))
        atlas_client.invalidate_cache()

        def verify(section_ids, detail_ids=None):
            rows = atlas_client.get_sections_by_ids(section_ids).get("sections", [])
            return {"verified_by_id": {row["id"]: row for row in rows},
                    "details_by_id": {row["id"]: row for row in rows if row["id"] in (detail_ids or [])},
                    "errors_by_id": {}, "detail_errors_by_id": {}, "groups": []}

        stack.enter_context(patch.object(atlas_live_verification, "verify_sections_by_ids", side_effect=verify))
        stack.enter_context(patch.object(courses, "refresh_section_snapshot", side_effect=lambda row, **_: (
            {**row, "live_updated_at": STAMP, "live_snapshot_available": True, "live_stale": False}, None, STAMP, False,
        )))

        @app.get("/__test__/courses/auth")
        def authenticate():
            theme = request.args.get("theme", "obsidian-dark")
            if theme not in {"obsidian-dark", "parchment-light"}:
                abort(400)
            database.update_row("user_settings", OWNER_ID, data={
                "interface_theme": theme, "theme": "dark" if theme == "obsidian-dark" else "light",
            })
            login_user(User(database.get_row("users", OWNER_ID)))
            return redirect("/courses")

        @app.after_request
        def label_fixture(response):
            if request.path == "/courses" and response.mimetype == "text/html":
                markup = response.get_data(as_text=True).replace(
                    '<p id="courses-result-summary">',
                    '<p class="courses-catalog-status">Synthetic preview · course and rating data are fictional.</p><p id="courses-result-summary">',
                    1,
                )
                response.set_data(markup)
            return response

        yield app
        atlas_client.invalidate_cache()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8806"))
    with courses_test_app(port) as application:
        print(f"Synthetic course preview: http://127.0.0.1:{port}/__test__/courses/auth", flush=True)
        application.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
