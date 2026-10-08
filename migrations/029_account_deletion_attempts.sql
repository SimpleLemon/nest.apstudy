-- Rotate bounded account-cleanup batches past failures and interrupted work.
ALTER TABLE storage_account_deletions ADD COLUMN last_attempt_at TEXT;

CREATE INDEX idx_storage_account_deletions_attempt
    ON storage_account_deletions(auth_deleted_at, last_attempt_at, deleted_at, user_id);
