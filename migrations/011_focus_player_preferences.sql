CREATE TABLE IF NOT EXISTS focus_player_preferences (
    user_id TEXT PRIMARY KEY,
    layout TEXT NOT NULL DEFAULT 'beside',
    floating_size TEXT NOT NULL DEFAULT 'compact',
    floating_x REAL NOT NULL DEFAULT 1,
    floating_y REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
