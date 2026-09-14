-- Calendar OAuth credentials never enter the existing Canvas import tables.
CREATE TABLE IF NOT EXISTS external_calendar_connections (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
 subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
 credentials TEXT, status TEXT NOT NULL DEFAULT 'setup', consent_version INTEGER NOT NULL DEFAULT 0,
 export_sources TEXT NOT NULL DEFAULT '[]', managed_calendar_id TEXT,
 next_sync_at REAL NOT NULL DEFAULT 0, last_sync_at REAL, last_error TEXT,
 lease_token TEXT, lease_until REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL, UNIQUE(user_id,provider,subject,tenant)
);
CREATE INDEX IF NOT EXISTS external_calendar_due ON external_calendar_connections(status,next_sync_at);
CREATE TABLE IF NOT EXISTS external_calendars (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, remote_id TEXT NOT NULL, name TEXT NOT NULL, writable INTEGER NOT NULL DEFAULT 0,
 selected INTEGER NOT NULL DEFAULT 0, is_primary INTEGER NOT NULL DEFAULT 0,
 cursor TEXT, window_key TEXT, ownership_marker TEXT, available INTEGER NOT NULL DEFAULT 1, UNIQUE(connection_id,remote_id)
);
CREATE TABLE IF NOT EXISTS external_calendar_events (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 calendar_id TEXT NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
 remote_id TEXT, revision TEXT, body TEXT NOT NULL, baseline TEXT, editable INTEGER NOT NULL DEFAULT 0,
 source_url TEXT, occurrence_id TEXT, status TEXT NOT NULL DEFAULT 'synchronized', deleted INTEGER NOT NULL DEFAULT 0,
 UNIQUE(calendar_id,remote_id)
);
CREATE TABLE IF NOT EXISTS external_calendar_exports (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, source_ref TEXT NOT NULL, remote_id TEXT NOT NULL, baseline TEXT,
 revision TEXT, suppressed INTEGER NOT NULL DEFAULT 0, source_kind TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0,
 UNIQUE(connection_id,source_ref), UNIQUE(connection_id,remote_id)
);
CREATE TABLE IF NOT EXISTS external_calendar_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 event_id TEXT, operation TEXT NOT NULL, payload TEXT NOT NULL, expected_revision TEXT,
 idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL,
 UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS external_calendar_conflicts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES external_calendar_connections(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, export_id TEXT, local_body TEXT, remote_body TEXT, remote_revision TEXT,
 created_at REAL NOT NULL, UNIQUE(connection_id,event_id)
);
CREATE TABLE IF NOT EXISTS external_calendar_oauth (
 state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
 verifier TEXT NOT NULL, connection_id TEXT, expires_at REAL NOT NULL
);
-- Native event writes schedule reconciliation in the same SQLite transaction.
CREATE TRIGGER IF NOT EXISTS external_calendar_native_insert AFTER INSERT ON user_events
 BEGIN UPDATE external_calendar_connections SET next_sync_at=0 WHERE user_id=NEW.user_id AND status='active'; END;
CREATE TRIGGER IF NOT EXISTS external_calendar_native_update AFTER UPDATE ON user_events
 BEGIN UPDATE external_calendar_connections SET next_sync_at=0 WHERE user_id=NEW.user_id AND status='active'; END;
CREATE TRIGGER IF NOT EXISTS external_calendar_native_delete AFTER DELETE ON user_events
 BEGIN UPDATE external_calendar_connections SET next_sync_at=0 WHERE user_id=OLD.user_id AND status='active'; END;

ALTER TABLE user_events ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE user_events ADD COLUMN location TEXT NOT NULL DEFAULT '';
