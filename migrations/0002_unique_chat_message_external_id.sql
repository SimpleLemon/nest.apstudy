CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_external_id_unique
    ON chat_messages(external_id)
    WHERE external_id IS NOT NULL AND external_id != '';
