"""Native and extension routes share provider-specific authorization."""
from functools import wraps
from flask import Blueprint, jsonify, redirect, render_template, request
from flask_login import current_user, login_required
from blueprints.extension_api import _auth_or_response, extension_response_contract
from services import external_calendar_service as service
from services import external_calendar_oauth as oauth
from services.external_calendar_domain import CalendarError
from services.external_calendar_store import connection, row, transaction

external_calendar_bp = Blueprint('external_calendar', __name__)
external_calendar_extension_bp = Blueprint('external_calendar_extension', __name__)
external_calendar_oauth_bp = Blueprint('external_calendar_oauth', __name__)
external_calendar_extension_bp.after_request(extension_response_contract)


def endpoint(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        unauthorized = _auth_or_response()
        if unauthorized:
            return unauthorized
        try:
            if request.method != 'GET' and (not request.is_json or not isinstance(request.get_json(silent=True), dict)):
                raise CalendarError('json_object_required')
            result = fn(str(current_user.id), *args, **kwargs)
            response = jsonify({'ok': True, 'contractVersion': 1, **result})
            response.headers['Cache-Control'] = 'no-store'
            return response
        except CalendarError as exc:
            return jsonify({'ok': False, 'contractVersion': 1, 'code': exc.code, 'error': exc.code.replace('_', ' ')}), exc.status
    return wrapped


@endpoint
def connections(user_id):
    return service.status(user_id)


@endpoint
def connect(user_id, provider):
    return {'authorization_url': oauth.begin(user_id, provider, request.get_json().get('connection_id'))}


@endpoint
def configure(user_id, connection_id):
    return service.configure(user_id, connection_id, request.get_json())


@endpoint
def calendars(user_id, connection_id):
    return service.refresh_calendars(user_id, connection_id)


@endpoint
def sync(user_id, connection_id):
    return service.sync_now(user_id, connection_id)


@endpoint
def disconnect(user_id, connection_id):
    cleanup = request.get_json().get('cleanup', False)
    if not isinstance(cleanup, bool):
        raise CalendarError('invalid_cleanup_choice')
    return service.disconnect(user_id, connection_id, cleanup)


@endpoint
def events(user_id):
    if request.method == 'POST':
        return service.mutate(user_id, None, 'create', request.get_json())
    values, sources = service.project(user_id, request.args.get('start'), request.args.get('end'))
    return {'events': values, 'sources': sources}


@endpoint
def planner_events(user_id):
    from datetime import datetime, timedelta
    from flask import make_response
    from blueprints.calendar_api import get_events
    try:
        start, end = (datetime.fromisoformat(request.args[key].replace('Z', '+00:00')) for key in ('start', 'end'))
        if start.tzinfo is None or end.tzinfo is None or not timedelta(0) < end - start <= timedelta(days=62):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise CalendarError('invalid_calendar_range') from None
    if not service.capabilities()['provider_calendar_read']:
        raise CalendarError('provider_not_configured', 503)
    response = make_response(get_events())
    if response.status_code != 200:
        raise CalendarError('calendar_unavailable', 503)
    body = response.get_json()
    return {'events': body['events'], 'sources': body['calendar_sources']}


@endpoint
def event(user_id, event_id):
    return service.mutate(user_id, event_id.removeprefix('external:'), 'delete' if request.method == 'DELETE' else 'update', request.get_json())


@endpoint
def conflicts(user_id):
    return service.conflicts(user_id)


@endpoint
def resolve(user_id, conflict_id):
    body = request.get_json()
    if not isinstance(body.get('revision'), str):
        raise CalendarError('event_revision_required')
    if not isinstance(body.get('idempotency_key'), str) or not 8 <= len(body['idempotency_key']) <= 128:
        raise CalendarError('idempotency_key_required')
    return service.resolve(user_id, conflict_id, body.get('choice'), body['revision'], body['idempotency_key'])


@endpoint
def restore(user_id, connection_id, export_id):
    with transaction() as db:
        import time
        item = connection(db, user_id, connection_id)
        if item['status'] != 'active' or item['lease_until'] > time.time():
            raise CalendarError('sync_in_progress', 409)
        mapping = row(db, 'SELECT * FROM external_calendar_exports WHERE id=? AND connection_id=? AND user_id=? AND suppressed=1', (export_id, connection_id, user_id))
        if not mapping:
            raise CalendarError('export_not_suppressed', 409)
        from services.external_calendar_exports import reset_export
        reset_export(db, mapping)
        db.execute('UPDATE external_calendar_connections SET next_sync_at=0 WHERE id=?', (connection_id,))
    return {'state': 'queued'}


@endpoint
def recover_calendar(user_id, connection_id):
    with transaction() as db:
        item = connection(db, user_id, connection_id)
        if not str(item['managed_calendar_id']).startswith('pending:') or item['lease_until'] > __import__('time').time():
            raise CalendarError('calendar_recovery_not_available', 409)
        calendar = row(db, 'SELECT * FROM external_calendars WHERE id=? AND connection_id=? AND writable=1', (request.get_json().get('calendar_id'), connection_id))
        if not calendar or calendar['ownership_marker'] != 'APStudy connection ' + connection_id or request.get_json().get('confirm_managed_calendar') is not True:
            raise CalendarError('confirm_export_calendar_required')
        db.execute('UPDATE external_calendar_connections SET managed_calendar_id=?,last_error=NULL,next_sync_at=0 WHERE id=?', (calendar['remote_id'], connection_id))
    return service.status(user_id)


for blueprint in (external_calendar_bp, external_calendar_extension_bp):
    for route, handler, methods in (
        ('/connections', connections, ['GET']),
        ('/connections/connect/<provider>', connect, ['POST']),
        ('/connections/<connection_id>/configure', configure, ['POST']),
        ('/connections/<connection_id>/calendars', calendars, ['POST']),
        ('/connections/<connection_id>/sync', sync, ['POST']),
        ('/connections/<connection_id>/disconnect', disconnect, ['POST']),
        ('/connections/<connection_id>/recover-calendar', recover_calendar, ['POST']),
        ('/connections/<connection_id>/exports/<export_id>/restore', restore, ['POST']),
        ('/external-events', events, ['GET', 'POST']),
        ('/planner-events', planner_events, ['GET']),
        ('/external-events/<event_id>', event, ['PUT', 'DELETE']),
        ('/calendar-conflicts', conflicts, ['GET']),
        ('/calendar-conflicts/<conflict_id>/resolve', resolve, ['POST']),
    ):
        if blueprint is external_calendar_extension_bp and handler is connect:
            continue
        blueprint.add_url_rule(route, view_func=handler, methods=methods)


@external_calendar_oauth_bp.route('/calendar/connections')
@login_required
def page():
    return render_template('calendar_connections.html')


@external_calendar_oauth_bp.route('/oauth/calendar/<provider>/callback')
def callback(provider):
    try:
        # Never carry an OAuth code into a login redirect's `next` URL.
        if not current_user.is_authenticated:
            raise CalendarError('calendar_login_required', 401)
        if request.args.get('error'):
            raise CalendarError('calendar_consent_cancelled')
        oauth.complete(str(current_user.id), provider, request.args.get('state', ''), request.args.get('code', ''))
        target = '/calendar/connections?connected=1'
    except CalendarError as exc:
        from urllib.parse import urlencode
        target = '/calendar/connections?' + urlencode({'error': exc.code})
    response = redirect(target, 303)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response
