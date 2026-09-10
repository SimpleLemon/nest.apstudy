CREATE TABLE IF NOT EXISTS extension_bridge_conflicts (
    writeback_id TEXT PRIMARY KEY,
    canvas_revision TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
