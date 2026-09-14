"""Transactions and encrypted credential storage for direct calendar sync."""
import json
import time
import uuid
from contextlib import contextmanager
from flask import current_app, has_app_context
from cryptography.fernet import Fernet, InvalidToken
from services.calendar_store import calendar_connection
from services.external_calendar_domain import CalendarError, dumps


def uid():
    return uuid.uuid4().hex


@contextmanager
def transaction():
    with calendar_connection() as db:
        db.execute('BEGIN IMMEDIATE')
        yield db


def row(db, sql, args=()):
    result = db.execute(sql, args).fetchone()
    return dict(result) if result else None


def rows(db, sql, args=()):
    return [dict(item) for item in db.execute(sql, args).fetchall()]


def connection(db, user_id, connection_id):
    result = row(db, 'SELECT * FROM external_calendar_connections WHERE id=? AND user_id=?', (connection_id, str(user_id)))
    if not result:
        raise CalendarError('connection_not_found', 404)
    return result


def config(name, default=''):
    if not has_app_context():
        return default
    from config import ENVIRONMENT_CONFIG_EXTENSION_KEY
    environment = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
    settings = environment.calendar_provider_settings if environment else {}
    return current_app.config.get(name, settings.get(name, default))


def keys():
    try:
        configured = config('CALENDAR_TOKEN_KEYS', '{}')
        values = json.loads(configured) if isinstance(configured, str) else configured
        return {key: Fernet(value.encode()) for key, value in values.items()}
    except (ValueError, TypeError, AttributeError):
        raise CalendarError('calendar_encryption_unavailable', 503) from None


def seal(value):
    key_id = config('CALENDAR_TOKEN_ACTIVE_KEY', 'v1')
    key = keys().get(key_id)
    if not key:
        raise CalendarError('calendar_encryption_unavailable', 503)
    return key_id + ':' + key.encrypt(dumps(value).encode()).decode()


def unseal(value):
    try:
        key_id, cipher = value.split(':', 1)
        return json.loads(keys()[key_id].decrypt(cipher.encode()))
    except (KeyError, ValueError, AttributeError, InvalidToken):
        raise CalendarError('calendar_credentials_unavailable', 503) from None


def available(provider, user_id=None):
    from flask import has_request_context
    from flask_login import current_user
    allowlist = config('CALENDAR_SYNC_USER_ALLOWLIST', '*').split(',')
    if user_id is None and has_request_context() and current_user.is_authenticated:
        user_id = str(current_user.id)
    if '*' not in allowlist and str(user_id) not in {x.strip() for x in allowlist}:
        return False
    try:
        return bool(config('CALENDAR_SYNC_ENABLED') == '1' and provider in ('google', 'microsoft')
                    and config('CALENDAR_' + provider.upper() + '_ENABLED', '0' if provider == 'microsoft' else '1') == '1'
                    and config('CALENDAR_' + provider.upper() + '_CLIENT_ID')
                    and config('CALENDAR_' + provider.upper() + '_CLIENT_SECRET')
                    and config('CALENDAR_TOKEN_ACTIVE_KEY', 'v1') in keys())
    except CalendarError:
        return False


def claim(connection_id):
    token, now = uid(), time.time()
    with transaction() as db:
        changed = db.execute('UPDATE external_calendar_connections SET lease_token=?,lease_until=? WHERE id=? AND lease_until<?',
                             (token, now + 120, connection_id, now)).rowcount
    return token if changed else None


def assert_lease(db, connection_id, token):
    value = row(db, 'SELECT lease_token,lease_until,status FROM external_calendar_connections WHERE id=?', (connection_id,))
    if not value or value['lease_token'] != token or value['lease_until'] < time.time():
        raise CalendarError('sync_lease_lost', 409)
    db.execute('UPDATE external_calendar_connections SET lease_until=? WHERE id=?', (time.time() + 120, connection_id))
    return value['status']
