-- The payload and feature metadata share a transaction. Key material lives
-- exclusively in the separately protected upload keyring, outside SQLite.
CREATE TABLE storage_objects (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL CHECK (namespace IN ('avatars', 'shared_files', 'note_media', 'chat_attachments')),
    object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128 AND instr(object_id, char(0)) = 0),
    original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 1024 AND instr(original_filename, char(0)) = 0),
    mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 255 AND instr(mime_type, char(0)) = 0),
    byte_length INTEGER NOT NULL CHECK (typeof(byte_length) = 'integer' AND byte_length BETWEEN 0 AND 52428800),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    format_version INTEGER NOT NULL CHECK (typeof(format_version) = 'integer' AND format_version = 1),
    encryption_key_id TEXT NOT NULL CHECK (length(encryption_key_id) BETWEEN 1 AND 64),
    nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
    payload BLOB NOT NULL CHECK (typeof(payload) = 'blob' AND length(payload) = byte_length + 16),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    UNIQUE (namespace, object_id)
);

CREATE INDEX idx_storage_objects_encryption_key ON storage_objects(encryption_key_id);

-- Historical avatars stay charged to their original account while a message
-- still references them. Keep attribution after profile replacement/deletion.
CREATE TABLE storage_avatar_ownership (
    object_id TEXT PRIMARY KEY NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128),
    user_id TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 10485760),
    storage_backend TEXT NOT NULL CHECK (storage_backend IN ('appwrite', 'sqlite'))
);

CREATE INDEX idx_storage_avatar_ownership_user ON storage_avatar_ownership(user_id);

ALTER TABLE users ADD COLUMN avatar_storage_backend TEXT NOT NULL DEFAULT 'appwrite'
    CHECK (avatar_storage_backend IN ('appwrite', 'sqlite'));
ALTER TABLE note_media ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'appwrite'
    CHECK (storage_backend IN ('appwrite', 'sqlite'));
ALTER TABLE chat_attachments ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'appwrite'
    CHECK (storage_backend IN ('appwrite', 'sqlite'));
-- Preserve an authorized delete while its remote attachment work is pending.
ALTER TABLE chat_messages ADD COLUMN delete_requested_at TEXT;

-- Keep deletion intent when a remote identity delete must be retried. OAuth
-- must not recreate a profile or attach new uploads during that interval.
CREATE TABLE storage_account_deletions (
    user_id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    auth_deleted_at TEXT
);

-- Source history intentionally survives object deletion and supports rollback.
CREATE TABLE storage_migration_manifest (
    id INTEGER PRIMARY KEY,
    source_endpoint TEXT NOT NULL DEFAULT '',
    source_project_id TEXT NOT NULL DEFAULT '',
    source_bucket_id TEXT NOT NULL,
    source_file_id TEXT NOT NULL,
    namespace TEXT NOT NULL CHECK (namespace IN ('avatars', 'shared_files', 'note_media', 'chat_attachments')),
    object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 128),
    source_url TEXT,
    source_created_at TEXT,
    source_updated_at TEXT,
    source_byte_length INTEGER CHECK (source_byte_length IS NULL OR (typeof(source_byte_length) = 'integer' AND source_byte_length BETWEEN 0 AND 52428800)),
    byte_length INTEGER CHECK (byte_length IS NULL OR (typeof(byte_length) = 'integer' AND byte_length BETWEEN 0 AND 52428800)),
    sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
    reference_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (reference_status IN ('unknown', 'referenced', 'unreferenced', 'missing_baseline', 'source_disappeared')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'copied', 'verified', 'promoted', 'failed', 'missing', 'removed')),
    error TEXT,
    copied_at TEXT,
    verified_at TEXT,
    promoted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_endpoint, source_project_id, source_bucket_id, source_file_id)
);

CREATE INDEX idx_storage_manifest_destination ON storage_migration_manifest(namespace, object_id);
CREATE INDEX idx_storage_manifest_status ON storage_migration_manifest(status);

-- Retry only explicitly legacy object deletions after the feature transaction
-- releases its writer lock. Preserve the remote identity on transient errors.
CREATE TABLE storage_legacy_deletions (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL CHECK (namespace IN ('avatars', 'shared_files', 'note_media', 'chat_attachments')),
    bucket_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    account_user_id TEXT,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (namespace, bucket_id, object_id)
);

CREATE INDEX idx_storage_legacy_deletions_account ON storage_legacy_deletions(account_user_id, namespace);
CREATE INDEX idx_storage_legacy_deletions_parent ON storage_legacy_deletions(namespace, parent_id);
