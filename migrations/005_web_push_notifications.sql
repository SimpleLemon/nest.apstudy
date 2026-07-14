ALTER TABLE user_notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'notes';
ALTER TABLE user_notifications ADD COLUMN title TEXT;
ALTER TABLE user_notifications ADD COLUMN body TEXT;
ALTER TABLE user_notifications ADD COLUMN target_url TEXT;
ALTER TABLE user_notifications ADD COLUMN source_ref TEXT;
ALTER TABLE user_notifications ADD COLUMN dedupe_key TEXT;
ALTER TABLE user_notifications ADD COLUMN deleted_at TEXT;
ALTER TABLE user_notifications ADD COLUMN expires_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_dedupe
    ON user_notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifications_feed
    ON user_notifications(user_id, deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    device_name TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    last_seen_at TEXT,
    failed_at TEXT,
    failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    push_enabled INTEGER NOT NULL DEFAULT 0,
    calendar_enabled INTEGER NOT NULL DEFAULT 1,
    course_push_enabled INTEGER NOT NULL DEFAULT 1,
    course_email_enabled INTEGER NOT NULL DEFAULT 0,
    dm_enabled INTEGER NOT NULL DEFAULT 1,
    mention_enabled INTEGER NOT NULL DEFAULT 1,
    message_preview_enabled INTEGER NOT NULL DEFAULT 1,
    calendar_lead_minutes_json TEXT NOT NULL DEFAULT '[10,1440]',
    all_day_previous_time TEXT NOT NULL DEFAULT '18:00',
    prompt_dismissed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_status INTEGER,
    failure_reason TEXT,
    attempted_at TEXT NOT NULL,
    UNIQUE(notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_attempted ON notification_deliveries(attempted_at);

CREATE TABLE IF NOT EXISTS calendar_reminder_claims (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_ref TEXT NOT NULL,
    occurrence_start TEXT NOT NULL,
    lead_minutes INTEGER NOT NULL,
    notification_id TEXT,
    claimed_at TEXT NOT NULL,
    UNIQUE(user_id, event_ref, occurrence_start, lead_minutes)
);
CREATE INDEX IF NOT EXISTS idx_calendar_claims_claimed ON calendar_reminder_claims(claimed_at);
