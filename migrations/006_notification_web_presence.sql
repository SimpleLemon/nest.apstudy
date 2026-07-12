CREATE TABLE IF NOT EXISTS notification_web_presence (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    device_class TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT NOT NULL,
    UNIQUE(user_id, tab_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_web_presence_active
    ON notification_web_presence(user_id, device_class, is_active, last_seen_at);

CREATE TABLE IF NOT EXISTS notification_foreground_queue (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    target_url TEXT,
    tag TEXT,
    deliver_after TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    fallback_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_foreground_queue_pending
    ON notification_foreground_queue(acknowledged_at, fallback_at, deliver_after);
