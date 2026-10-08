CREATE TABLE IF NOT EXISTS community_themes (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected','unpublished')),
 published_revision INTEGER, parent_id TEXT, parent_revision INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_theme_versions (
 theme_id TEXT NOT NULL REFERENCES community_themes(id), revision INTEGER NOT NULL,
 document_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(theme_id, revision)
);
CREATE TABLE IF NOT EXISTS community_theme_reviews (
 id INTEGER PRIMARY KEY AUTOINCREMENT, theme_id TEXT NOT NULL REFERENCES community_themes(id),
 revision INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_theme_reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, theme_id TEXT NOT NULL REFERENCES community_themes(id),
 revision INTEGER NOT NULL, reporter_id TEXT NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
 resolution TEXT NOT NULL DEFAULT '', resolved_by TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS community_theme_report_open ON community_theme_reports(theme_id,reporter_id) WHERE state='open';
CREATE INDEX IF NOT EXISTS community_theme_queue ON community_themes(status,updated_at);
CREATE INDEX IF NOT EXISTS community_theme_owner ON community_themes(owner_id,updated_at);
