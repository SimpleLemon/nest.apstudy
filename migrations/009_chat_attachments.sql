CREATE TABLE IF NOT EXISTS chat_attachments (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    scope_type VARCHAR(16) NOT NULL,
    scope_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    original_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(127) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    original_size_bytes INTEGER NOT NULL,
    stored_size_bytes INTEGER NOT NULL,
    compression_encoding VARCHAR(16) NOT NULL DEFAULT 'identity',
    sha256 VARCHAR(64) NOT NULL,
    width INTEGER,
    height INTEGER,
    storage_bucket_id VARCHAR(64) NOT NULL,
    storage_file_id VARCHAR(64) NOT NULL,
    preview_file_id VARCHAR(64) NOT NULL DEFAULT '',
    preview_size_bytes INTEGER NOT NULL DEFAULT 0,
    provider VARCHAR(32) NOT NULL DEFAULT 'nest',
    provider_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_user ON chat_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_scope ON chat_attachments(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_status ON chat_attachments(status, created_at);
