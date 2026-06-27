CREATE TABLE IF NOT EXISTS note_access_grants (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('note', 'folder')),
    resource_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('public', 'user')),
    principal_id TEXT NOT NULL,
    access_level TEXT NOT NULL DEFAULT 'viewer',
    granted_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    CHECK (
        (principal_type = 'public' AND principal_id = '*')
        OR (principal_type = 'user' AND principal_id <> '')
    ),
    UNIQUE(resource_type, resource_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_note_access_grants_resource
    ON note_access_grants(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_note_access_grants_principal
    ON note_access_grants(principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_note_access_grants_owner
    ON note_access_grants(owner_user_id);
