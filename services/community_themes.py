"""Immutable submissions and approval-pinned public versions, stored in Nest SQLite."""
import json
import uuid
from datetime import datetime, timezone
from services.database import db_connection
from services.community_theme_schema import ThemeError, validate_document, text, TAGS


def now():
    return datetime.now(timezone.utc).isoformat()


def row(conn, theme_id):
    found = conn.execute('SELECT * FROM community_themes WHERE id=?', (theme_id,)).fetchone()
    if found is None:
        raise ThemeError('Theme not found.', 404)
    return dict(found)


def audit(conn, theme, actor, action, reason=''):
    conn.execute('INSERT INTO community_theme_reviews(theme_id,revision,actor_id,action,reason,created_at) VALUES(?,?,?,?,?,?)', (theme['id'], theme['revision'], actor, action, reason, now()))


def payload(conn, theme, *, private=False):
    version = theme['revision'] if private else theme['published_revision']
    if version is None:
        raise ThemeError('Theme not found.', 404)
    record = conn.execute('SELECT document_json,created_at FROM community_theme_versions WHERE theme_id=? AND revision=?', (theme['id'], version)).fetchone()
    data = json.loads(record[0])
    result = dict(id=theme['id'], revision=version, document=data, updatedAt=theme['updated_at'] if private else record[1], sharePath='/themes/' + theme['id'])
    if theme['parent_id']:
        # Attribution remains pinned even if the parent is later unpublished.
        parent = conn.execute('SELECT document_json FROM community_theme_versions WHERE theme_id=? AND revision=?', (theme['parent_id'], theme['parent_revision'])).fetchone()
        source = json.loads(parent[0]) if parent else {}
        result['remixOf'] = dict(id=theme['parent_id'], revision=theme['parent_revision'], name=source.get('name', 'Unavailable theme'), creator=source.get('creator', ''))
    if private:
        result.update(status=theme['status'], publishedRevision=theme['published_revision'])
        result['history'] = [dict(r) for r in conn.execute('SELECT revision,action,reason,created_at FROM community_theme_reviews WHERE theme_id=? ORDER BY id DESC LIMIT 100', (theme['id'],))]
    return result


def get_theme(theme_id, user=None, admin=False, private=False):
    with db_connection() as conn:
        theme = row(conn, theme_id)
        if private and not (admin or theme['owner_id'] == user):
            raise ThemeError('Theme not found.', 404)
        result = payload(conn, theme, private=private)
        if admin and private:
            result['ownerId'] = theme['owner_id']
            result['history'] = [dict(r) for r in conn.execute('SELECT revision,action,reason,actor_id,created_at FROM community_theme_reviews WHERE theme_id=? ORDER BY id DESC LIMIT 100', (theme_id,))]
            result['versions'] = [dict(r) for r in conn.execute('SELECT revision,created_at FROM community_theme_versions WHERE theme_id=? ORDER BY revision DESC LIMIT 100', (theme_id,))]
            result['published'] = payload(conn, theme) if theme['published_revision'] else None
            result['reports'] = [dict(r) for r in conn.execute('SELECT * FROM community_theme_reports WHERE theme_id=? ORDER BY id DESC LIMIT 100', (theme_id,))]
        return result


def list_themes(*, user=None, admin=False, status='', query='', tag='', offset=0):
    clauses, args = [], []
    if user and not admin:
        clauses.append('t.owner_id=?'); args.append(user)
    elif not admin:
        clauses.append('t.published_revision IS NOT NULL')
    if status:
        if not admin or status not in ('draft', 'pending', 'approved', 'rejected', 'unpublished'):
            raise ThemeError('Invalid status filter.')
        clauses.append('t.status=?'); args.append(status)
    if tag and tag not in TAGS:
        raise ThemeError('Invalid tag.')
    if query:
        clauses.append("(json_extract(v.document_json,'$.name') LIKE ? ESCAPE '\\' OR json_extract(v.document_json,'$.creator') LIKE ? ESCAPE '\\')")
        escaped = query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        args += ['%' + escaped + '%'] * 2
    if tag:
        clauses.append("EXISTS(SELECT 1 FROM json_each(v.document_json,'$.tags') WHERE value=?)"); args.append(tag)
    version = 't.revision' if user or admin else 't.published_revision'
    sql = f'SELECT t.* FROM community_themes t JOIN community_theme_versions v ON v.theme_id=t.id AND v.revision={version}'
    if clauses:
        sql += ' WHERE ' + ' AND '.join(clauses)
    with db_connection() as conn:
        order = 't.updated_at' if user or admin else 'v.created_at'
        rows = conn.execute(sql + f' ORDER BY {order} DESC,t.id LIMIT 25 OFFSET ?', (*args, offset)).fetchall()
        result = dict(items=[payload(conn, dict(r), private=bool(user or admin)) for r in rows[:24]], hasMore=len(rows) > 24, offset=offset)
        if admin:
            result['counts'] = {r[0]: r[1] for r in conn.execute('SELECT status,COUNT(*) FROM community_themes GROUP BY status')}
            result['openReports'] = conn.execute("SELECT COUNT(*) FROM community_theme_reports WHERE state='open'").fetchone()[0]
        return result


def save(user, document, theme_id=None, expected=None, parent_id=None, parent_revision=None):
    document = validate_document(document)
    stamp = now()
    with db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if theme_id:
            theme = row(conn, theme_id)
            if theme['owner_id'] != user:
                raise ThemeError('Theme not found.', 404)
            if type(expected) is not int or theme['revision'] != expected:
                raise ThemeError('This theme changed. Reload before saving.', 409)
            if theme['status'] == 'pending':
                raise ThemeError('Withdraw the pending submission before editing.', 409)
            if expected >= 500:
                raise ThemeError('This theme has reached its revision limit.', 429)
            revision = expected + 1
            conn.execute("UPDATE community_themes SET revision=?,status='draft',updated_at=? WHERE id=?", (revision, stamp, theme_id))
        else:
            count = conn.execute('SELECT COUNT(*) FROM community_themes WHERE owner_id=?', (user,)).fetchone()[0]
            if count >= 100:
                raise ThemeError('Your library has reached its 100-theme limit.', 429)
            parent = row(conn, parent_id) if parent_id else None
            if parent and not parent['published_revision']:
                raise ThemeError('Only published themes can be remixed.', 404)
            if parent and (type(parent_revision) is not int or parent_revision != parent['published_revision']):
                raise ThemeError('The source theme changed. Reload its approved version before remixing.', 409)
            theme_id, revision = uuid.uuid4().hex, 1
            conn.execute("INSERT INTO community_themes VALUES(?,?,1,'draft',NULL,?,?,?,?)", (theme_id, user, parent_id, parent['published_revision'] if parent else None, stamp, stamp))
        conn.execute('INSERT INTO community_theme_versions VALUES(?,?,?,?)', (theme_id, revision, json.dumps(document), stamp))
        theme = row(conn, theme_id)
        audit(conn, theme, user, 'saved')
        return payload(conn, theme, private=True)


def transition(theme_id, actor, action, expected, reason='', admin=False):
    reason = text(reason, 'Reason', 1 if action in ('reject', 'unpublish') else 0, 1000)
    with db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        theme = row(conn, theme_id)
        if not admin and theme['owner_id'] != actor:
            raise ThemeError('Theme not found.', 404)
        if type(expected) is not int or expected != theme['revision']:
            raise ThemeError('This revision changed. Reload before continuing.', 409)
        state, published = theme['status'], theme['published_revision']
        if action == 'submit' and not admin and state in ('draft', 'rejected', 'unpublished'):
            state = 'pending'
        elif action == 'withdraw' and not admin and state == 'pending':
            state = 'draft'
        elif action == 'approve' and admin and state == 'pending':
            state, published = 'approved', theme['revision']
        elif action == 'reject' and admin and state == 'pending':
            state = 'rejected'
        elif action == 'unpublish' and admin and published is not None:
            state, published = 'unpublished', None
        else:
            raise ThemeError('This action is not available for the current theme state.', 409)
        conn.execute('UPDATE community_themes SET status=?,published_revision=?,updated_at=? WHERE id=?', (state, published, now(), theme_id))
        audit(conn, theme, actor, action, reason)
        return payload(conn, row(conn, theme_id), private=True)


def report(theme_id, user, reason):
    reason = text(reason, 'Report', 5, 1000)
    with db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        theme = row(conn, theme_id)
        if not theme['published_revision']:
            raise ThemeError('Theme not found.', 404)
        if conn.execute("SELECT 1 FROM community_theme_reports WHERE theme_id=? AND reporter_id=? AND state='open'", (theme_id, user)).fetchone():
            raise ThemeError('You already have an open report for this theme.', 409)
        if conn.execute("SELECT COUNT(*) FROM community_theme_reports WHERE reporter_id=? AND state='open'", (user,)).fetchone()[0] >= 20:
            raise ThemeError('You have reached the open-report limit.', 429)
        conn.execute('INSERT INTO community_theme_reports(theme_id,revision,reporter_id,reason,created_at) VALUES(?,?,?,?,?)', (theme_id, theme['published_revision'], user, reason, now()))
    return {'ok': True}


def resolve_report(report_id, actor, reason):
    reason = text(reason, 'Resolution', 1, 1000)
    with db_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        changed = conn.execute("UPDATE community_theme_reports SET state='resolved',resolution=?,resolved_by=?,resolved_at=? WHERE id=? AND state='open'", (reason, actor, now(), report_id))
        if changed.rowcount != 1:
            raise ThemeError('Report not found or already resolved.', 409)
        report_row = dict(conn.execute('SELECT * FROM community_theme_reports WHERE id=?', (report_id,)).fetchone())
        audit(conn, dict(id=report_row['theme_id'], revision=report_row['revision']), actor, 'report-resolved', reason)
    return {'ok': True}
