CREATE TABLE IF NOT EXISTS daily_active_users (
    user_id TEXT NOT NULL,
    active_date TEXT NOT NULL,
    PRIMARY KEY (user_id, active_date)
);
