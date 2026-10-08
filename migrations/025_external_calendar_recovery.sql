-- Recovery state is additive to the initial feature migration.
ALTER TABLE external_calendar_connections ADD COLUMN last_sync_requested_at REAL;
ALTER TABLE external_calendar_connections ADD COLUMN export_error TEXT;
ALTER TABLE external_calendars ADD COLUMN last_error TEXT;
ALTER TABLE external_calendar_exports ADD COLUMN operation_id TEXT;
ALTER TABLE external_calendar_exports ADD COLUMN pending_body TEXT;
ALTER TABLE external_calendar_exports ADD COLUMN pending_revision TEXT;
ALTER TABLE external_calendar_exports ADD COLUMN pending_remote_id TEXT;
ALTER TABLE external_calendar_jobs ADD COLUMN last_error TEXT;
ALTER TABLE external_calendar_conflicts ADD COLUMN reason TEXT NOT NULL DEFAULT 'overlapping_edits';
ALTER TABLE external_calendar_conflicts ADD COLUMN source_url TEXT;
UPDATE external_calendar_exports SET operation_id=CASE WHEN initialized=0 THEN remote_id ELSE lower(hex(randomblob(16))) END;
CREATE TABLE external_calendar_resolutions (
 user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
 connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 result TEXT NOT NULL, PRIMARY KEY(user_id,idempotency_key)
);
