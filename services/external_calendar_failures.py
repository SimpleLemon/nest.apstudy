"""Event-level failures cannot block other calendars in the same account."""
import time
from services.external_calendar_domain import CalendarError
from services.external_calendar_store import assert_lease


def retry_delay(exc, attempts):
    return max(getattr(exc, 'retry_after', 0), min(3600, 30 * 2 ** min(attempts, 7)))


def defer_job(db, item, lease, job, exc):
    assert_lease(db, item['id'], lease)
    fatal = exc.code in ('calendar_permission_denied', 'event_no_longer_editable', 'remote_not_found', 'invalid_event')
    state = 'failed' if fatal else 'queued'
    db.execute('UPDATE external_calendar_jobs SET state=?,last_error=?,attempts=attempts+1,next_attempt_at=? WHERE id=?',
               (state, exc.code, time.time() + retry_delay(exc, job['attempts']), job['id']))
    if fatal:
        db.execute("UPDATE external_calendar_events SET status='failed',editable=0 WHERE id=?", (job['event_id'],))
    if exc.code in ('reconnect_required', 'sync_time_budget', 'sync_lease_lost', 'connection_not_active'):
        raise exc
