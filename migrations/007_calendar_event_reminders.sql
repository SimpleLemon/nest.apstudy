ALTER TABLE user_events ADD COLUMN reminder_minutes INTEGER;
ALTER TABLE user_event_overrides ADD COLUMN reminder_minutes INTEGER;

UPDATE user_events
SET reminder_minutes = CASE WHEN is_all_day = 1 THEN -1 ELSE 10 END
WHERE reminder_minutes IS NULL;
