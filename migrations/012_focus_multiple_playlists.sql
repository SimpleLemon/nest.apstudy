CREATE TABLE IF NOT EXISTS focus_playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK(owner_type IN ('routine', 'session')),
    owner_id TEXT NOT NULL,
    spotify_url TEXT NOT NULL,
    title TEXT NOT NULL,
    creator TEXT NOT NULL,
    thumbnail_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(owner_type, owner_id, spotify_url)
);

CREATE INDEX IF NOT EXISTS idx_focus_playlists_owner
    ON focus_playlists(owner_type, owner_id, position, created_at);

CREATE INDEX IF NOT EXISTS idx_focus_playlists_user
    ON focus_playlists(user_id, created_at DESC);
