"""Community gallery and same-origin, session/CSRF-protected editorial API."""
from functools import wraps
from flask import Blueprint, jsonify, render_template, request, abort, url_for
from flask_login import current_user, login_required
from flask_wtf.csrf import generate_csrf
from services.admin_access import user_can_access_admin
from services import community_themes as themes
from services.community_theme_schema import ThemeError, text
from services.database import db_connection

community_themes_bp = Blueprint('community_themes', __name__)


def admin_only(fn):
    @wraps(fn)
    @login_required
    def wrapped(*args, **kwargs):
        if not user_can_access_admin(current_user.id):
            abort(403)
        return fn(*args, **kwargs)
    return wrapped


def data(allowed, required=()):
    if request.content_length and request.content_length > 24000:
        raise ThemeError('Request is too large.', 413)
    if len(request.get_data(cache=True)) > 24000:
        raise ThemeError('Request is too large.', 413)
    result = request.get_json(silent=True)
    if not isinstance(result, dict) or set(result) - set(allowed) or set(required) - set(result):
        raise ThemeError('Invalid request fields.')
    return result


@community_themes_bp.errorhandler(ThemeError)
def error(exc):
    return jsonify(ok=False, error={'message': str(exc)}), exc.status


@community_themes_bp.after_request
def private_cache(response):
    response.headers['Cache-Control'] = 'no-store'
    return response


def page(view, theme_id=None):
    if theme_id and view == 'detail':
        themes.get_theme(theme_id)
    return render_template('community_themes.html', theme_view=view, theme_id=theme_id or '', signed_in=current_user.is_authenticated, csrf_token_value=generate_csrf())


@community_themes_bp.get('/themes')
def gallery():
    return page('gallery')


@community_themes_bp.get('/themes/new')
@login_required
def new_theme():
    return page('editor')


@community_themes_bp.get('/themes/mine')
@login_required
def my_themes():
    return page('mine')


@community_themes_bp.get('/themes/<theme_id>')
def detail(theme_id):
    return page('detail', theme_id)


@community_themes_bp.get('/themes/<theme_id>/edit')
@login_required
def edit(theme_id):
    themes.get_theme(theme_id, user=str(current_user.id), private=True)
    return page('editor', theme_id)


@community_themes_bp.get('/admin/themes')
@admin_only
def admin_themes():
    return render_template('admin_themes.html', active_admin_page='themes', admin_viewer=None, theme_preference=None, breadcrumbs=[('Admin', url_for('admin.admin_index')), ('Community themes', None)], csrf_token_value=generate_csrf())


@community_themes_bp.get('/api/themes')
def gallery_api():
    offset = request.args.get('offset', '0')
    if not offset.isdecimal() or int(offset) > 10000:
        raise ThemeError('Invalid page offset.')
    return jsonify(ok=True, **themes.list_themes(query=text(request.args.get('q', ''), 'Search', 0, 80), tag=request.args.get('tag', ''), offset=int(offset)))


@community_themes_bp.get('/api/themes/mine')
@login_required
def mine_api():
    return jsonify(ok=True, **themes.list_themes(user=str(current_user.id), offset=_offset()))


def _offset():
    value = request.args.get('offset', '0')
    if not value.isdecimal() or int(value) > 10000:
        raise ThemeError('Invalid page offset.')
    return int(value)


@community_themes_bp.get('/api/themes/<theme_id>')
def theme_api(theme_id):
    return jsonify(ok=True, theme=themes.get_theme(theme_id))


@community_themes_bp.get('/api/themes/<theme_id>/draft')
@login_required
def draft_api(theme_id):
    return jsonify(ok=True, theme=themes.get_theme(theme_id, user=str(current_user.id), private=True))


@community_themes_bp.post('/api/themes')
@login_required
def create_api():
    body = data(('document', 'remixOf', 'remixRevision'), ('document',))
    parent = body.get('remixOf')
    if parent is not None and (not isinstance(parent, str) or len(parent) != 32):
        raise ThemeError('Invalid remix source.')
    return jsonify(ok=True, theme=themes.save(str(current_user.id), body['document'], parent_id=parent, parent_revision=body.get('remixRevision'))), 201


@community_themes_bp.put('/api/themes/<theme_id>')
@login_required
def save_api(theme_id):
    body = data(('document', 'expectedRevision'), ('document', 'expectedRevision'))
    return jsonify(ok=True, theme=themes.save(str(current_user.id), body['document'], theme_id, body['expectedRevision']))


@community_themes_bp.post('/api/themes/<theme_id>/<action>')
@login_required
def action_api(theme_id, action):
    if action not in ('submit', 'withdraw', 'report'):
        abort(404)
    body = data(('expectedRevision', 'reason'))
    if action == 'report':
        return jsonify(themes.report(theme_id, str(current_user.id), body.get('reason')))
    return jsonify(ok=True, theme=themes.transition(theme_id, str(current_user.id), action, body.get('expectedRevision')))


@community_themes_bp.get('/api/admin/themes')
@admin_only
def admin_list_api():
    return jsonify(ok=True, **themes.list_themes(admin=True, status=request.args.get('status', ''), query=text(request.args.get('q', ''), 'Search', 0, 80), offset=_offset()))


@community_themes_bp.get('/api/admin/themes/reports')
@admin_only
def admin_reports_api():
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM community_theme_reports WHERE state='open' ORDER BY id LIMIT 25 OFFSET ?", (_offset(),)).fetchall()
        return jsonify(ok=True, items=[dict(r) for r in rows[:24]], hasMore=len(rows) > 24)


@community_themes_bp.get('/api/admin/themes/<theme_id>')
@admin_only
def admin_detail_api(theme_id):
    return jsonify(ok=True, theme=themes.get_theme(theme_id, admin=True, private=True))


@community_themes_bp.post('/api/admin/themes/<theme_id>/<action>')
@admin_only
def review_api(theme_id, action):
    if action not in ('approve', 'reject', 'unpublish'):
        abort(404)
    body = data(('expectedRevision', 'reason'), ('expectedRevision',))
    return jsonify(ok=True, theme=themes.transition(theme_id, str(current_user.id), action, body['expectedRevision'], body.get('reason', ''), admin=True))


@community_themes_bp.post('/api/admin/theme-reports/<int:report_id>/resolve')
@admin_only
def resolve_api(report_id):
    body = data(('reason',), ('reason',))
    return jsonify(themes.resolve_report(report_id, str(current_user.id), body['reason']))


@community_themes_bp.get('/api/admin/themes/<theme_id>/revisions/<int:revision>')
@admin_only
def revision_api(theme_id, revision):
    import json
    with db_connection() as conn:
        record = conn.execute('SELECT document_json FROM community_theme_versions WHERE theme_id=? AND revision=?', (theme_id, revision)).fetchone()
        if record is None:
            raise ThemeError('Revision not found.', 404)
        return jsonify(ok=True, document=json.loads(record[0]), revision=revision)
