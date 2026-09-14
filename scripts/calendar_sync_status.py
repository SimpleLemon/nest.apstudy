"""Read aggregate sync health without event contents, identifiers or credentials."""
import argparse
import json
import sqlite3
import time
from pathlib import Path


def snapshot(path):
    with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return {
            'connections': [dict(row) for row in db.execute('SELECT provider,status,COUNT(*) AS count FROM external_calendar_connections GROUP BY provider,status')],
            'oldest_sync_age_seconds': db.execute("SELECT MAX(?-COALESCE(last_sync_at,created_at)) FROM external_calendar_connections WHERE status='active'", (time.time(),)).fetchone()[0],
            'jobs': [dict(row) for row in db.execute('SELECT state,COUNT(*) AS count FROM external_calendar_jobs GROUP BY state')],
            'conflicts': db.execute('SELECT COUNT(*) FROM external_calendar_conflicts').fetchone()[0],
            'failures': [dict(row) for row in db.execute('SELECT provider,last_error,COUNT(*) AS count FROM external_calendar_connections WHERE last_error IS NOT NULL GROUP BY provider,last_error')],
        }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', help='Path to the calendar SQLite database')
    print(json.dumps(snapshot(parser.parse_args().database), indent=2))
