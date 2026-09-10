-- Phase 2 extension to the existing Nest task storage.
--
-- The extension owns one source-keyed list per user, but its tasks remain
-- ordinary Nest tasks so the existing local:tasks calendar projection keeps
-- seeing them.
ALTER TABLE task_lists ADD COLUMN source_key TEXT;

ALTER TABLE tasks ADD COLUMN description TEXT;
ALTER TABLE tasks ADD COLUMN link TEXT;
ALTER TABLE tasks ADD COLUMN canvas_account_key TEXT;
ALTER TABLE tasks ADD COLUMN canvas_course_id TEXT;
ALTER TABLE tasks ADD COLUMN canvas_course_label TEXT;
ALTER TABLE tasks ADD COLUMN type_label TEXT;
ALTER TABLE tasks ADD COLUMN points_earned REAL;
ALTER TABLE tasks ADD COLUMN points_possible REAL;
ALTER TABLE tasks ADD COLUMN source_identity TEXT;
ALTER TABLE tasks ADD COLUMN source_key TEXT;
ALTER TABLE tasks ADD COLUMN source_item_key TEXT;
ALTER TABLE tasks ADD COLUMN source_event_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_lists_user_source_key
    ON task_lists(user_id, source_key)
    WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_source_key
    ON tasks(user_id, source_key, source_item_key);

CREATE INDEX IF NOT EXISTS idx_tasks_canvas_account
    ON tasks(user_id, canvas_account_key);

-- Receipts are deliberately separate from task/calendar tables.  They retain
-- the original response so a retry can replay the exact created representation
-- even if a caller has since renamed the source list.
CREATE TABLE IF NOT EXISTS task_idempotency_receipts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    task_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_task_idempotency_receipts_user
    ON task_idempotency_receipts(user_id, created_at);
