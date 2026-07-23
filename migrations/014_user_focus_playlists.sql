CREATE TABLE focus_playlists_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK(owner_type IN ('routine', 'session', 'user')),
    owner_id TEXT NOT NULL,
    spotify_url TEXT NOT NULL,
    title TEXT NOT NULL,
    creator TEXT NOT NULL,
    thumbnail_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(owner_type, owner_id, spotify_url)
);

INSERT INTO focus_playlists_new (
    id,
    user_id,
    owner_type,
    owner_id,
    spotify_url,
    title,
    creator,
    thumbnail_url,
    position,
    created_at
)
SELECT
    id,
    user_id,
    owner_type,
    owner_id,
    spotify_url,
    title,
    creator,
    thumbnail_url,
    position,
    created_at
FROM focus_playlists;

DROP TABLE focus_playlists;

ALTER TABLE focus_playlists_new RENAME TO focus_playlists;

CREATE INDEX IF NOT EXISTS idx_focus_playlists_owner
    ON focus_playlists(owner_type, owner_id, position, created_at);

CREATE INDEX IF NOT EXISTS idx_focus_playlists_user
    ON focus_playlists(user_id, created_at DESC);

ALTER TABLE focus_player_preferences ADD COLUMN active_playlist_url TEXT;

INSERT INTO focus_playlists (
    id,
    user_id,
    owner_type,
    owner_id,
    spotify_url,
    title,
    creator,
    thumbnail_url,
    position,
    created_at
)
SELECT
    lower(hex(randomblob(16))),
    user_id,
    'user',
    user_id,
    spotify_url,
    title,
    creator,
    thumbnail_url,
    position,
    created_at
FROM (
    SELECT
        deduped.user_id,
        deduped.spotify_url,
        deduped.title,
        deduped.creator,
        deduped.thumbnail_url,
        deduped.position,
        deduped.created_at,
        ROW_NUMBER() OVER (
            PARTITION BY deduped.user_id
            ORDER BY deduped.position ASC, deduped.created_at ASC
        ) AS playlist_rank,
        CASE COALESCE(users.tier, 'free')
            WHEN 'grade_a' THEN 3
            WHEN 'grade_aa' THEN 6
            WHEN 'developer' THEN 1000000
            ELSE 2
        END AS playlist_limit
    FROM (
        SELECT
            fp.user_id,
            fp.spotify_url,
            fp.title,
            fp.creator,
            fp.thumbnail_url,
            fp.position,
            fp.created_at,
            ROW_NUMBER() OVER (
                PARTITION BY fp.user_id, fp.spotify_url
                ORDER BY fp.position ASC, fp.created_at ASC
            ) AS url_rank
        FROM focus_playlists AS fp
        WHERE fp.owner_type IN ('routine', 'session')
    ) AS deduped
    LEFT JOIN users ON users.id = deduped.user_id
    WHERE deduped.url_rank = 1
) AS ranked
WHERE ranked.playlist_rank <= ranked.playlist_limit;

INSERT INTO focus_player_preferences (
    user_id,
    layout,
    floating_size,
    floating_x,
    floating_y,
    panel_width,
    panel_height,
    active_playlist_url,
    updated_at
)
SELECT
    ranked.user_id,
    'beside',
    'compact',
    1.0,
    1.0,
    0,
    0,
    ranked.spotify_url,
    ranked.created_at
FROM (
    SELECT
        user_id,
        spotify_url,
        created_at,
        ROW_NUMBER() OVER (
            PARTITION BY user_id
            ORDER BY position ASC, created_at ASC
        ) AS playlist_rank
    FROM focus_playlists
    WHERE owner_type = 'user'
) AS ranked
WHERE ranked.playlist_rank = 1
ON CONFLICT(user_id) DO UPDATE SET
    active_playlist_url = COALESCE(
        focus_player_preferences.active_playlist_url,
        excluded.active_playlist_url
    );
