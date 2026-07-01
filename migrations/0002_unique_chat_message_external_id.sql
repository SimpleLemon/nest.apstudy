CREATE TEMP TABLE duplicate_chat_message_map AS
WITH ranked AS (
    SELECT
        id,
        FIRST_VALUE(id) OVER (
            PARTITION BY external_id
            ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
        ) AS keep_id,
        COUNT(*) OVER (PARTITION BY external_id) AS copies
    FROM chat_messages
    WHERE external_id IS NOT NULL AND external_id != ''
)
SELECT id AS old_id, keep_id
FROM ranked
WHERE copies > 1 AND id != keep_id;

UPDATE chat_events
SET message_id = (
    SELECT keep_id
    FROM duplicate_chat_message_map
    WHERE old_id = chat_events.message_id
)
WHERE message_id IN (SELECT old_id FROM duplicate_chat_message_map);

UPDATE chat_read_states
SET last_read_message_id = (
    SELECT keep_id
    FROM duplicate_chat_message_map
    WHERE old_id = chat_read_states.last_read_message_id
)
WHERE last_read_message_id IN (SELECT old_id FROM duplicate_chat_message_map);

DELETE FROM chat_messages
WHERE id IN (SELECT old_id FROM duplicate_chat_message_map);

DROP TABLE duplicate_chat_message_map;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_external_id_unique
    ON chat_messages(external_id)
    WHERE external_id IS NOT NULL AND external_id != '';
