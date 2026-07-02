ALTER TABLE notes ADD COLUMN collaboration_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE note_folders ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS note_share_invitations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('note', 'folder')),
    resource_id TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    email_display TEXT NOT NULL,
    access_level TEXT NOT NULL CHECK (access_level IN ('viewer', 'reviewer', 'editor')),
    invited_by_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    accepted_user_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_share_invitation_pending
    ON note_share_invitations(resource_type, resource_id, email_normalized)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_note_share_invitation_email
    ON note_share_invitations(email_normalized, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_note_share_invitation_resource
    ON note_share_invitations(resource_type, resource_id, status);

CREATE TABLE IF NOT EXISTS note_collaboration_documents (
    note_id TEXT PRIMARY KEY,
    ydoc_blob BLOB NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    durable_revision INTEGER NOT NULL DEFAULT 0,
    projection_revision INTEGER NOT NULL DEFAULT 0,
    initialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    actor_user_id TEXT,
    reason TEXT NOT NULL,
    name TEXT,
    ydoc_blob BLOB,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    page_setup_json TEXT,
    durable_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_versions_note_created
    ON note_versions(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_versions_expires
    ON note_versions(expires_at);

CREATE TABLE IF NOT EXISTS note_suggestions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'conflicted')),
    operation_kind TEXT NOT NULL,
    operations_json TEXT NOT NULL,
    anchor_start TEXT,
    anchor_end TEXT,
    block_id TEXT,
    base_state_vector TEXT,
    summary TEXT,
    resolved_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_note_suggestions_note_status
    ON note_suggestions(note_id, status, created_at);

CREATE TABLE IF NOT EXISTS note_comment_threads (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    anchor_start TEXT,
    anchor_end TEXT,
    block_id TEXT,
    quoted_text TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolved_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_note_comment_threads_note_status
    ON note_comment_threads(note_id, status, created_at);

CREATE TABLE IF NOT EXISTS note_comment_replies (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_comment_replies_thread
    ON note_comment_replies(thread_id, created_at);

CREATE TABLE IF NOT EXISTS note_access_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    old_access_level TEXT,
    new_access_level TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_access_events_resource
    ON note_access_events(resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    actor_user_id TEXT,
    notification_type TEXT NOT NULL,
    note_id TEXT,
    thread_id TEXT,
    suggestion_id TEXT,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_read
    ON user_notifications(user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_email_casefold
    ON users(LOWER(email));
