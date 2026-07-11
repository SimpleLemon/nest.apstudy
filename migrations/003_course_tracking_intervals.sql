ALTER TABLE course_seat_tracks ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE course_seat_tracks ADD COLUMN next_check_at TEXT;
ALTER TABLE course_seat_tracks ADD COLUMN last_waitlist_total INTEGER;
ALTER TABLE course_seat_tracks ADD COLUMN last_waitlist_capacity INTEGER;
ALTER TABLE course_seat_tracks ADD COLUMN cooldown_until_closed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_course_tracks_next_check ON course_seat_tracks(enabled, next_check_at);
