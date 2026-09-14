"""Calendar consent is independent of Nest login and Canvas writeback."""
import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import urlencode, urlsplit
import jwt
import requests
from services.external_calendar_domain import CalendarError
from services.external_calendar_store import available, config, connection, row, seal, transaction, uid, unseal

SCOPES = {
    'google': 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.app.created',
    'microsoft': 'openid profile email offline_access User.Read Calendars.ReadWrite Calendars.ReadWrite.Shared',
}
AUTH = {'google': 'https://accounts.google.com/o/oauth2/v2/auth', 'microsoft': 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'}
TOKEN = {'google': 'https://oauth2.googleapis.com/token', 'microsoft': 'https://login.microsoftonline.com/common/oauth2/v2.0/token'}


def callback(provider):
    base = config('CALENDAR_OAUTH_BASE_URL', 'https://nest.apstudy.org').rstrip('/')
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise CalendarError('invalid_oauth_base_url', 503)
    return base + '/oauth/calendar/' + provider + '/callback'


def require_available(provider, user_id):
    if not available(provider, user_id):
        raise CalendarError('provider_not_configured', 503)


def begin(user_id, provider, connection_id=None):
    require_available(provider, user_id)
    state, verifier, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(64), secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    with transaction() as db:
        if connection_id and connection(db, user_id, connection_id)['provider'] != provider:
            raise CalendarError('connection_provider_mismatch')
        db.execute('DELETE FROM external_calendar_oauth WHERE expires_at<?', (time.time(),))
        db.execute('INSERT INTO external_calendar_oauth VALUES(?,?,?,?,?,?)',
                   (hashlib.sha256(state.encode()).hexdigest(), str(user_id), provider, seal({'verifier': verifier, 'nonce': nonce}), connection_id, time.time() + 600))
    params = {'client_id': config('CALENDAR_' + provider.upper() + '_CLIENT_ID'), 'redirect_uri': callback(provider),
              'response_type': 'code', 'scope': SCOPES[provider], 'state': state, 'nonce': nonce,
              'code_challenge': challenge, 'code_challenge_method': 'S256', 'prompt': 'select_account'}
    if provider == 'google':
        params.update(access_type='offline', prompt='consent select_account')
    return AUTH[provider] + '?' + urlencode(params)


def token_request(provider, data):
    data = {**data, 'client_id': config('CALENDAR_' + provider.upper() + '_CLIENT_ID'),
            'client_secret': config('CALENDAR_' + provider.upper() + '_CLIENT_SECRET')}
    try:
        response = requests.post(TOKEN[provider], data=data, timeout=(5, 15), allow_redirects=False)
        if response.status_code != 200:
            raise CalendarError('reconnect_required' if response.status_code == 400 else 'provider_unavailable', 503)
        token = response.json()
        if not token.get('access_token'):
            raise ValueError()
        return {**token, 'expires_at': time.time() + int(token.get('expires_in', 3600))}
    except CalendarError:
        raise
    except (requests.RequestException, ValueError, TypeError):
        raise CalendarError('provider_unavailable', 503) from None


def identity(provider, token, nonce):
    """Validate signed identity; never trust email or an unverified JWT subject."""
    try:
        encoded = token['id_token']
        audience = config('CALENDAR_' + provider.upper() + '_CLIENT_ID')
        if provider == 'google':
            jwks, issuer = 'https://www.googleapis.com/oauth2/v3/certs', 'https://accounts.google.com'
        else:
            tenant = jwt.decode(encoded, options={'verify_signature': False}).get('tid', '')
            import uuid
            tenant = str(uuid.UUID(tenant))
            jwks = 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
            issuer = 'https://login.microsoftonline.com/' + tenant + '/v2.0'
        key = jwt.PyJWKClient(jwks, timeout=10).get_signing_key_from_jwt(encoded).key
        claims = jwt.decode(encoded, key, algorithms=['RS256'], audience=audience, issuer=issuer, options={'require': ['exp', 'iat', 'sub', 'nonce']})
        if not hmac.compare_digest(str(claims['nonce']), nonce):
            raise ValueError()
        return claims['sub'], claims.get('tid', '') if provider == 'microsoft' else '', str(claims.get('email') or claims.get('preferred_username') or claims.get('name') or provider)[:160]
    except (KeyError, ValueError, jwt.PyJWTError):
        raise CalendarError('invalid_provider_identity', 401) from None


def complete(user_id, provider, state, code):
    require_available(provider, user_id)
    with transaction() as db:
        stored = row(db, 'SELECT * FROM external_calendar_oauth WHERE state_hash=? AND user_id=? AND provider=? AND expires_at>?',
                     (hashlib.sha256(state.encode()).hexdigest(), str(user_id), provider, time.time()))
        if not stored:
            raise CalendarError('oauth_state_expired', 400)
        db.execute('DELETE FROM external_calendar_oauth WHERE state_hash=?', (stored['state_hash'],))
    proof = unseal(stored['verifier'])
    token = token_request(provider, {'grant_type': 'authorization_code', 'code': code, 'code_verifier': proof['verifier'], 'redirect_uri': callback(provider)})
    subject, tenant, label = identity(provider, token, proof['nonce'])
    granted = set(token.get('scope', '').split())
    required = set(SCOPES[provider].split()) - {'openid', 'email', 'profile', 'offline_access'}
    if not required <= granted:
        raise CalendarError('calendar_consent_incomplete', 403)
    with transaction() as db:
        existing = row(db, 'SELECT * FROM external_calendar_connections WHERE user_id=? AND provider=? AND subject=? AND tenant=?', (str(user_id), provider, subject, tenant))
        if stored['connection_id'] and (not existing or existing['id'] != stored['connection_id']):
            raise CalendarError('reconnect_account_mismatch', 409)
        if not token.get('refresh_token') and existing and existing['credentials']:
            token['refresh_token'] = unseal(existing['credentials']).get('refresh_token')
        if not token.get('refresh_token'):
            raise CalendarError('offline_consent_required', 403)
        credentials = seal({k: token[k] for k in ('access_token', 'refresh_token', 'expires_at')})
        connection_id = existing['id'] if existing else uid()
        if existing:
            # Fence the existing worker by status, but keep its lease until it
            # stops. Clearing a live lease could permit simultaneous API writes.
            db.execute("UPDATE external_calendar_connections SET credentials=?,label=?,status='setup',last_error=NULL WHERE id=?", (credentials, label, connection_id))
        else:
            db.execute('INSERT INTO external_calendar_connections(id,user_id,provider,subject,tenant,label,credentials,created_at) VALUES(?,?,?,?,?,?,?,?)',
                       (connection_id, str(user_id), provider, subject, tenant, label, credentials, time.time()))
    return connection_id


def access_token(record):
    token = unseal(record['credentials'])
    if token['expires_at'] > time.time() + 120:
        return token['access_token']
    refreshed = token_request(record['provider'], {'grant_type': 'refresh_token', 'refresh_token': token['refresh_token']})
    if 'scope' in refreshed:
        required = set(SCOPES[record['provider']].split()) - {'openid', 'email', 'profile', 'offline_access'}
        if not required <= set(refreshed['scope'].split()):
            raise CalendarError('reconnect_required', 403)
    refreshed = {'access_token': refreshed['access_token'], 'refresh_token': refreshed.get('refresh_token', token['refresh_token']), 'expires_at': refreshed['expires_at']}
    with transaction() as db:
        # Do not restore a token after concurrent disconnect/reconnect.
        changed = db.execute('UPDATE external_calendar_connections SET credentials=? WHERE id=? AND credentials=?',
                             (seal(refreshed), record['id'], record['credentials'])).rowcount
        if not changed:
            raise CalendarError('connection_changed', 409)
    return refreshed['access_token']
