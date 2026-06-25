CREATE TABLE IF NOT EXISTS course_section_live_snapshots (
    id TEXT PRIMARY KEY,
    section_id TEXT NOT NULL UNIQUE,
    term TEXT NOT NULL,
    subject TEXT NOT NULL,
    catalog TEXT NOT NULL,
    crn TEXT,
    section_number TEXT,
    enrollment_status TEXT,
    enrollment_count TEXT,
    seats_available INTEGER,
    enrollment_capacity INTEGER,
    waitlist_total INTEGER,
    waitlist_capacity INTEGER,
    is_cancelled INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    fetched_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_course_live_snapshots_lookup
    ON course_section_live_snapshots(term, subject, catalog);

CREATE INDEX IF NOT EXISTS idx_course_live_snapshots_fetched_at
    ON course_section_live_snapshots(fetched_at);
