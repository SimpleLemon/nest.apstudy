"""Manually refresh an explicitly scoped, summary-only RMP snapshot."""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from scripts.rmp.matching import refresh_entries, validate_overrides
from scripts.rmp.public_pages import FixturePages, PublicPages
from scripts.rmp.browser_pages import BrowserPages
from scripts.rmp.storage import atomic_write, load_roster
from services.professor_ratings import read_snapshot

ROOT = Path(__file__).resolve().parents[2]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--terms", required=True, nargs="+", help="Explicit Atlas terms, e.g. Fall_2026")
    parser.add_argument("--root", type=Path, default=ROOT, help="Atlas catalog root")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data/rmp")
    parser.add_argument("--overrides", type=Path, default=Path(__file__).with_name("overrides.json"))
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--input", type=Path, help="Explicit offline summary import JSON; makes no network requests")
    inputs.add_argument("--browser-export", type=Path, help="Complete public Emory/Oxford directories exported from normal browser access")
    parser.add_argument("--delay", type=float, default=1.5, help="Minimum seconds between requests (at least 1)")
    parser.add_argument("--max-requests", type=int, default=2000, help="Stop after this many public HTTP requests (1–10000)")
    args = parser.parse_args(argv)
    try:
        if args.input and args.output_dir.resolve() == (ROOT / "data/rmp").resolve():
            raise ValueError("Offline input requires a separate --output-dir; fixtures cannot replace the real cache")
        overrides = validate_overrides(json.loads(args.overrides.read_text(encoding="utf-8")))
        terms = list(dict.fromkeys(term for value in args.terms for term in value.split(",")))
        roster, roster_metadata = load_roster(args.root, terms, with_metadata=True)
        if not roster:
            raise ValueError("Selected terms contain no authoritative Atlas instructors; cache unchanged")
        snapshot_path = args.output_dir / "ratings.json"
        previous = read_snapshot(snapshot_path)
        if snapshot_path.exists() and not previous:
            raise ValueError("Existing ratings cache is invalid; repair it before refreshing")
        if args.browser_export:
            source = BrowserPages(json.loads(args.browser_export.read_text(encoding="utf-8")))
        elif args.input:
            source = FixturePages(json.loads(args.input.read_text(encoding="utf-8")))
        else:
            source = PublicPages(args.delay, max_requests=args.max_requests)
        timestamp = datetime.now(timezone.utc).isoformat()
        ratings, report = refresh_entries(roster, previous.get("ratings", {}), source, overrides, timestamp)
        report.update(started_at=timestamp, completed_at=datetime.now(timezone.utc).isoformat(), terms=terms,
                      source="public-rmp-brave" if args.browser_export else "offline-import" if args.input else "public-rmp-html",
                      **roster_metadata,
                      legacy_scope_note="Unknown-career legacy rosters are unverified. Professor summaries do not certify course scope; no course-number heuristic is used.")
        if args.browser_export:
            report["directories"] = source.directory_reports
        snapshot = {"schema_version": 1, "updated_at": report["completed_at"], "source": report["source"],
                    "ratings": ratings, "report": report}
        atomic_write(snapshot_path, snapshot)
        atomic_write(args.output_dir / "last-refresh-report.json", report)
        print(json.dumps({"snapshot": str(snapshot_path), **report}, indent=2))
        return 2 if report["failures"] else 0
    except (ValueError, OSError) as error:
        print(f"RMP refresh failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
