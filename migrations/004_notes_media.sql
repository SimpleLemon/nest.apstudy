CREATE TABLE IF NOT EXISTS note_media (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    storage_bucket_id TEXT NOT NULL,
    storage_file_id TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
    created_at TEXT NOT NULL,
    updated_at TEXT,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_media_note ON note_media(note_id);
CREATE INDEX IF NOT EXISTS idx_note_media_user ON note_media(user_id);
CREATE INDEX IF NOT EXISTS idx_note_media_status_created ON note_media(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_media_storage_file ON note_media(storage_file_id);
