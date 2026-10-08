CREATE TABLE IF NOT EXISTS extension_streaks (
 user_id TEXT NOT NULL, account_key TEXT NOT NULL, time_zone TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '{}',
 marks TEXT NOT NULL DEFAULT '{}', corrections TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(user_id, account_key, time_zone)
);
CREATE TABLE IF NOT EXISTS extension_streak_receipts (
 user_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(user_id, operation_id)
);
CREATE TABLE IF NOT EXISTS extension_streak_audit (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_key TEXT NOT NULL,
 time_zone TEXT NOT NULL, actor_id TEXT NOT NULL, dates TEXT NOT NULL,
 action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
