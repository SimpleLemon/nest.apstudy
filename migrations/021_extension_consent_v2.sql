-- Allow Canvas read consent v1 and personal-write consent v2 to coexist.
--
-- Existing v1 rows stay intact.  The uniqueness boundary gains version so a
-- user can keep read import authorization while separately opting into
-- personal event/planner writes or selected item mirroring.

ALTER TABLE calendar_integration_consents RENAME TO calendar_integration_consents_v1;

CREATE TABLE calendar_integration_consents (
    id TEXT PRIMARY KEY,
    nest_user_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    account_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version IN (1, 2)),
    scopes_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    granted_at TEXT,
    revoked_at TEXT,
    cancellation_state TEXT NOT NULL DEFAULT 'not_applicable',
    archive_state TEXT NOT NULL DEFAULT 'not_applicable',
    UNIQUE(nest_user_id, source_key, account_key, version)
);

INSERT INTO calendar_integration_consents (
    id, nest_user_id, source_key, account_key, version, scopes_json, state,
    created_at, updated_at, granted_at, revoked_at, cancellation_state, archive_state
)
SELECT
    id, nest_user_id, source_key, account_key, version, scopes_json, state,
    created_at, updated_at, granted_at, revoked_at, cancellation_state, archive_state
FROM calendar_integration_consents_v1;

DROP TABLE calendar_integration_consents_v1;

CREATE INDEX IF NOT EXISTS idx_calendar_consents_user_source
    ON calendar_integration_consents(nest_user_id, source_key);

CREATE INDEX IF NOT EXISTS idx_calendar_consents_state
    ON calendar_integration_consents(state, updated_at);
