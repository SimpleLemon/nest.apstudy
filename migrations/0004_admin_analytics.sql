CREATE TABLE IF NOT EXISTS user_activity_buckets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bucket_granularity TEXT NOT NULL,
    bucket_start TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(user_id, bucket_granularity, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_buckets_start
    ON user_activity_buckets(bucket_start);
CREATE INDEX IF NOT EXISTS idx_user_activity_buckets_user_start
    ON user_activity_buckets(user_id, bucket_start);

CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    event_type TEXT NOT NULL,
    path TEXT,
    endpoint TEXT,
    feature TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
    ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
    ON analytics_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
    ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_path
    ON analytics_events(path);
