"""Account-scoped calendar streak observations; only staff may forgive misses."""
import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from collections.abc import Mapping
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from services import database


class StreakError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate_streak_account_scope(account: str, zone: str) -> tuple[str, str]:
    if not isinstance(account, str) or not re.fullmatch(r"[a-f0-9]{64}", account):
        raise StreakError("Invalid Canvas account.")
    try:
        ZoneInfo(zone)
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        raise StreakError("Invalid time zone.")
    return account, zone


def parse_streak_date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError()
        return parsed
    except (ValueError, TypeError):
        raise StreakError("Invalid calendar date.")


def today_for(zone):
    return datetime.now(ZoneInfo(zone)).date().isoformat()


def empty_streak_history(account: str, zone: str) -> dict[str, Any]:
    return dict(v=4, policyVersion=4, accountKey=account, timeZone=zone, since=None,
                startedAt=None, lastSettledDate=None, lastVerified=None, current=0, best=0,
                days={}, forgiven=[], correctionRevision=0, todayComplete=False)


def load(conn, user, account, zone):
    row = conn.execute("SELECT * FROM extension_streaks WHERE user_id=? AND account_key=? AND time_zone=?", (user, account, zone)).fetchone()
    if not row:
        return dict(history=empty_streak_history(account, zone), marks={}, corrections=[], revision=0)
    return dict(history=json.loads(row['history']), marks=json.loads(row['marks']),
                corrections=json.loads(row['corrections']), revision=row['revision'])


def recalculate(history):
    if not history.get('since'):
        return
    end = parse_streak_date(history['lastSettledDate'])
    cursor = parse_streak_date(history['since'])
    run = best = 0
    start = cursor
    forgiven = set(history['forgiven'])
    while cursor <= end:
        outcome = history['days'].get(cursor.isoformat())
        if not outcome:
            break
        if outcome == 'missed' and cursor.isoformat() not in forgiven:
            run = 0
            start = cursor + timedelta(days=1)
        else:
            run += 1
            best = max(best, run)
        cursor += timedelta(days=1)
    if history['todayComplete']:
        run += 1
    history.update(current=run, best=max(best, run), startedAt=start.isoformat())


def serialize_streak_record(record: Mapping[str, Any]) -> dict[str, Any]:
    history = dict(record['history'], revision=record['revision'])
    history['days'] = [dict(date=d, state=s) for d, s in sorted(history['days'].items())]
    return dict(ok=True, contractVersion=1, history=history, revision=record['revision'],
                marks=[dict(id=k, **v) for k, v in record['marks'].items()])


def read(user, account, zone):
    validate_streak_account_scope(account, zone)
    with database.db_connection() as conn:
        return serialize_streak_record(load(conn, user, account, zone))


def save(conn, user, account, zone, record):
    conn.execute("""INSERT INTO extension_streaks VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id,account_key,time_zone) DO UPDATE SET revision=excluded.revision,
    history=excluded.history,marks=excluded.marks,corrections=excluded.corrections""",
                 (user, account, zone, record['revision'], json.dumps(record['history']),
                  json.dumps(record['marks']), json.dumps(record['corrections'])))


def sync(user, payload, operation_id):
    if not isinstance(payload, dict) or set(payload) - {'accountKey', 'timeZone', 'expectedRevision', 'history', 'marks'}:
        raise StreakError("Invalid streak request.")
    account, zone = validate_streak_account_scope(payload.get('accountKey'), payload.get('timeZone'))
    if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,160}', operation_id):
        raise StreakError("An operation ID is required.")
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    with database.db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = load(conn, user, account, zone)
        receipt = conn.execute('SELECT digest FROM extension_streak_receipts WHERE user_id=? AND operation_id=?', (user, operation_id)).fetchone()
        if receipt:
            if receipt['digest'] != digest:
                raise StreakError('Operation ID reused with different data.', 409)
            return serialize_streak_record(record)
        if type(payload.get('expectedRevision')) is not int or payload['expectedRevision'] != record['revision']:
            raise StreakError('Streak changed. Refresh and retry.', 409)
        revision = record['revision'] + 1
        marks = payload.get('marks', [])
        if not isinstance(marks, list) or len(marks) > 500:
            raise StreakError('Invalid completion marks.')
        for mark in marks:
            if not isinstance(mark, dict) or set(mark) != {'id', 'completed', 'revision'} or not isinstance(mark['id'], str) or not re.fullmatch(r'canvas:' + re.escape(account) + r':[a-f0-9]{64}', mark['id']) or type(mark['completed']) is not bool:
                raise StreakError('Invalid completion mark.')
            existing = record['marks'].get(mark['id'], {})
            if type(mark['revision']) is not int or mark['revision'] != existing.get('revision', 0):
                raise StreakError('Completion changed in another browser.', 409)
            record['marks'][mark['id']] = dict(completed=mark['completed'], revision=revision)
        observation = payload.get('history')
        if observation is not None:
            apply_observation(record['history'], observation, zone)
        record['revision'] = revision
        save(conn, user, account, zone, record)
        now = datetime.now(timezone.utc).isoformat()
        conn.execute('INSERT INTO extension_streak_receipts VALUES (?,?,?,?)', (user, operation_id, digest, now))
        conn.execute('DELETE FROM extension_streak_receipts WHERE created_at < ?', ((datetime.now(timezone.utc)-timedelta(days=30)).isoformat(),))
        return serialize_streak_record(record)


def apply_observation(history, observation, zone):
    allowed = {'since', 'lastSettledDate', 'todayComplete', 'days'}
    if not isinstance(observation, dict) or set(observation) != allowed or type(observation['todayComplete']) is not bool:
        raise StreakError('Invalid observation.')
    today = parse_streak_date(today_for(zone))
    end = parse_streak_date(observation['lastSettledDate'])
    since = parse_streak_date(observation['since'])
    if end != today - timedelta(days=1) or since > today or since < date(2000, 1, 1):
        raise StreakError('Observation must be current and bounded.')
    if history['since'] and observation['since'] != history['since']:
        raise StreakError('Tracking baseline changed. Refresh and retry.', 409)
    if not history['since'] and since < today - timedelta(days=180):
        raise StreakError('Initial history exceeds 180 days.')
    entries = observation['days']
    if not isinstance(entries, list) or len(entries) > 20000:
        raise StreakError('Invalid day history.')
    updates = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'date', 'state'} or entry['state'] not in {'clear', 'missed', 'none'}:
            raise StreakError('Invalid day outcome.')
        d = parse_streak_date(entry['date'])
        if d > end or d < since or entry['date'] in updates:
            raise StreakError('Invalid day range.')
        updates[entry['date']] = entry['state']
    cursor = since
    while cursor <= end:
        if cursor.isoformat() not in updates and cursor.isoformat() not in history['days']:
            raise StreakError('Incomplete historical coverage.')
        cursor += timedelta(days=1)
    for d, outcome in updates.items():
        history['days'][d] = 'missed' if history['days'].get(d) == 'missed' else outcome
    history.update(since=since.isoformat(), lastSettledDate=end.isoformat(), todayComplete=observation['todayComplete'],
                   lastVerified=datetime.now(timezone.utc).isoformat())
    recalculate(history)


def list_for_user(user):
    with database.db_connection() as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extension_streaks'").fetchone():
            return None
        rows = conn.execute('SELECT account_key,time_zone FROM extension_streaks WHERE user_id=? ORDER BY account_key,time_zone', (user,)).fetchall()
        return [dict(serialize_streak_record(load(conn, user, r['account_key'], r['time_zone'])), accountKey=r['account_key'], timeZone=r['time_zone']) for r in rows]


def correct(user, actor, account, zone, dates, reason, revoke=False, expected_revision=None, preview=False):
    validate_streak_account_scope(account, zone)
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
        raise StreakError('A correction reason is required (up to 1,000 characters).')
    if not isinstance(dates, list) or not dates or len(dates) > 180 or any(not isinstance(d, str) for d in dates) or len(set(dates)) != len(dates):
        raise StreakError('Select between 1 and 180 missed dates.')
    with database.db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = load(conn, user, account, zone)
        if type(expected_revision) is not int or expected_revision != record['revision']:
            raise StreakError('Streak changed. Review the updated record.', 409)
        history = record['history']
        forgiven = set(history['forgiven'])
        for d in dates:
            parse_streak_date(d)
            if history['days'].get(d) != 'missed' or d >= today_for(zone):
                raise StreakError('Only recorded past missed dates can be corrected.')
            if revoke:
                forgiven.discard(d)
            else:
                forgiven.add(d)
        history['forgiven'] = sorted(forgiven)
        history['correctionRevision'] += 1
        recalculate(history)
        record['revision'] += 1
        if not preview:
            audit_id = uuid.uuid4().hex
            conn.execute('INSERT INTO extension_streak_audit VALUES (?,?,?,?,?,?,?,?,?)',
                         (audit_id, user, account, zone, actor, json.dumps(dates), 'revoke' if revoke else 'forgive', reason.strip(), datetime.now(timezone.utc).isoformat()))
            record['corrections'].append(audit_id)
            save(conn, user, account, zone, record)
        return serialize_streak_record(record)
