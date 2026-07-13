ALTER TABLE tasks ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT -1;

UPDATE tasks
SET reminder_minutes = 10
WHERE deadline_at IS NOT NULL AND deadline_time IS NOT NULL;
