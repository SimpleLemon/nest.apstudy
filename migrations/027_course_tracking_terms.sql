-- Preserve the fall shutdown and scope the former spring setting to known data.
INSERT OR IGNORE INTO chat_bridge_config (id, config_key, config_value, created_at, updated_at)
VALUES ('course_tracking_term:Fall_2026', 'course_tracking_term:Fall_2026',
        '{"state":"closed","opens_at":null,"closes_at":null,"revision":1,"updated_by":"migration","updated_at":null}',
        strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));

INSERT OR IGNORE INTO chat_bridge_config (id, config_key, config_value, created_at, updated_at)
SELECT 'course_tracking_term:' || term, 'course_tracking_term:' || term,
       json_object('state', CASE WHEN EXISTS (
           SELECT 1 FROM chat_bridge_config WHERE config_key='spring_course_tracking_open'
           AND json_valid(config_value) AND json_extract(config_value,'$.enabled')=1
       ) THEN 'open' ELSE 'upcoming' END,
       'opens_at', NULL, 'closes_at', NULL, 'revision', 1, 'updated_by', 'migration', 'updated_at', NULL),
       strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
FROM (SELECT 'Spring_2026' AS term UNION SELECT DISTINCT term FROM course_seat_tracks WHERE term GLOB 'Spring_[0-9][0-9][0-9][0-9]');

-- Close the read/write race when a student resumes as an admin closes a term.
CREATE TRIGGER IF NOT EXISTS course_tracking_closed_insert
BEFORE INSERT ON course_seat_tracks WHEN NEW.enabled=1
BEGIN
    SELECT RAISE(ABORT, 'course_tracking_closed') WHERE EXISTS (
        SELECT 1 FROM chat_bridge_config WHERE config_key='course_tracking_term:' || NEW.term
        AND (NOT json_valid(config_value) OR json_extract(config_value,'$.state')='closed'
             OR julianday(json_extract(config_value,'$.closes_at')) <= julianday('now'))
    );
END;

CREATE TRIGGER IF NOT EXISTS course_tracking_closed_resume
BEFORE UPDATE OF enabled ON course_seat_tracks WHEN NEW.enabled=1
BEGIN
    SELECT RAISE(ABORT, 'course_tracking_closed') WHERE EXISTS (
        SELECT 1 FROM chat_bridge_config WHERE config_key='course_tracking_term:' || NEW.term
        AND (NOT json_valid(config_value) OR json_extract(config_value,'$.state')='closed'
             OR julianday(json_extract(config_value,'$.closes_at')) <= julianday('now'))
    );
END;
