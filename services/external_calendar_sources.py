"""Export only explicit academic/native sources; never external or arbitrary ICS imports."""
from datetime import date, datetime, timezone
from services.external_calendar_domain import CalendarError, normalize, in_window
from services.external_calendar_store import rows


def source_body(event):
    def iso(value):
        return value.isoformat() if hasattr(value, 'isoformat') else value
    all_day = bool(event.get('is_all_day', event.get('all_day', False)))
    start, end = iso(event.get('start')), iso(event.get('end'))
    return normalize({'title': event.get('title') or '(Untitled)', 'description': (event.get('description') or '')[:4096],
                      'start': start[:10] if all_day else start, 'end': end[:10] if all_day else end,
                      'all_day': all_day, 'timezone': event.get('timezone') or 'UTC', 'location': event.get('location') or '',
                      'reminder_minutes': max(-1, int(event.get('reminder_minutes') if event.get('reminder_minutes') is not None else -1))})


def load_sources(user_id, selected, bounds):
    from services.calendar_store import calendar_connection
    result = {}
    if 'personal' in selected:
        with calendar_connection() as db:
            for event in rows(db, 'SELECT * FROM user_events WHERE user_id=?', (str(user_id),)):
                result['user:' + event['id']] = ('personal', source_body(event))
    start, end = (datetime.combine(date.fromisoformat(x), datetime.min.time(), tzinfo=timezone.utc) for x in bounds)
    if 'canvas' in selected:
        from blueprints.calendar_api import _load_serialized_calendar_events
        # This projection honors existing source/account read consent. No feed URLs are exported.
        events, _, _ = _load_serialized_calendar_events(str(user_id), {}, start, end)
        for event in events:
            if event.get('source_type') == 'canvas':
                result[event['event_ref']] = ('canvas', source_body(event))
    if 'tasks' in selected:
        from services.task_calendar import task_calendar_events_for_user
        for event in task_calendar_events_for_user(str(user_id), start, end):
            result[event['event_ref']] = ('tasks', source_body(event))
    if 'courses' in selected:
        from services.calendar_ics_courses import project_simulated_courses
        outcome = project_simulated_courses(str(user_id), start, end)
        if outcome.status.value not in ('success', 'valid_empty'):
            raise CalendarError('course_projection_unavailable', 503)
        for event in outcome.events:
            result['course:' + event.uid] = ('courses', source_body({key: getattr(event, key, None) for key in ('title', 'description', 'start', 'end', 'is_all_day', 'location', 'reminder_minutes')}))
    return result


def save_personal(db, user_id, source_ref, body):
    if not source_ref.startswith('user:'):
        raise CalendarError('source_is_authoritative', 403)
    event_id = source_ref[5:]
    if body is None:
        # Preserve the established Canvas mirror deletion-choice contract.
        mirror = db.execute("SELECT id FROM calendar_event_links WHERE user_id=? AND event_ref=? AND archived_at IS NULL LIMIT 1", (user_id, source_ref)).fetchone()
        if mirror:
            raise CalendarError('mirror_delete_choice_required', 409)
        db.execute('DELETE FROM user_events WHERE id=? AND user_id=?', (event_id, user_id))
        return
    start, end = body['start'], body['end']
    if body['all_day']:
        start, end = start + 'T00:00:00+00:00', end + 'T00:00:00+00:00'
    db.execute('INSERT INTO user_events(id,user_id,title,description,start,end,is_all_day,calendar_id,reminder_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) '
               'ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,start=excluded.start,end=excluded.end,is_all_day=excluded.is_all_day,reminder_minutes=excluded.reminder_minutes,updated_at=excluded.updated_at WHERE user_events.user_id=excluded.user_id',
               (event_id, user_id, body['title'], body['description'], start, end, body['all_day'], 'local:default', body['reminder_minutes'], datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()))

    db.execute('UPDATE user_events SET timezone=?,location=? WHERE id=? AND user_id=?', (body['timezone'],body['location'],event_id,user_id))
