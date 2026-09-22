import copy
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Flask, jsonify, g
from flask_login import LoginManager, UserMixin
from flask_wtf.csrf import CSRFProtect, generate_csrf
from services import community_themes as service
from services.community_theme_schema import ThemeError, PALETTE_KEYS

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('theme_test_routes', ROOT / 'blueprints/community_themes.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)


def document():
    return dict(version=1, name='Fixture only', creator='Test author', description='Test data', tags=['study'], settings={
        'light_preset':dict.fromkeys(PALETTE_KEYS, '#eeeeee'), 'dark_preset':dict.fromkeys(PALETTE_KEYS, '#222222'),
        'custom_font':dict(family='',link=''), 'dark_mode':False, 'light_palette_enabled':True,
        'wide_course_cards':True, 'condensed_cards':False, 'disable_color_overlay':False, 'customCardStyles':True,
        'cardRoundness':5, 'cardImageRoundness':0, 'cardPadding':0, 'cardSpacing':0})


class CommunityThemesTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.path=str(Path(temp.name)/'themes.sqlite3')
        with sqlite3.connect(self.path) as conn:
            conn.executescript((ROOT/'migrations/026_community_themes.sql').read_text())
        self.app=Flask(__name__,template_folder=str(ROOT/'templates'),static_folder=str(ROOT/'static'))
        self.app.config.update(SECRET_KEY='test',TESTING=True,DATABASE_PATH=self.path)
        self.app.register_blueprint(routes.community_themes_bp)
        manager=LoginManager(self.app)
        class User(UserMixin):
            def __init__(self,id):self.id=id
        manager.user_loader(lambda id:User(id))
        @self.app.before_request
        def reset_cached_user():
            g.pop("_login_user", None)
        CSRFProtect(self.app)
        self.app.add_url_rule('/test-csrf',view_func=lambda:jsonify(token=generate_csrf()))
        self.ctx=self.app.app_context();self.ctx.push();self.addCleanup(self.ctx.pop)
        guard=patch.object(routes,'user_can_access_admin',side_effect=lambda id:id=='admin');guard.start();self.addCleanup(guard.stop)
        self.client=self.app.test_client()

    def login(self,id):
        with self.client.session_transaction() as session:session['_user_id']=id;session['_fresh']=True
        self.token=self.client.get('/test-csrf').json['token']

    def write(self,path,body,method='post',csrf=True):
        return getattr(self.client,method)(path,json=body,headers={'X-CSRFToken':self.token} if csrf else {})

    def approved(self):
        theme=service.save('one',document());service.transition(theme['id'],'one','submit',1)
        service.transition(theme['id'],'admin','approve',1,admin=True);return theme

    def test_empty_by_default_and_private_drafts_cannot_leak(self):
        self.assertEqual(service.list_themes()['items'],[])
        theme=service.save('one',document())
        with self.assertRaises(ThemeError) as error:service.get_theme(theme['id'])
        self.assertEqual(error.exception.status,404)
        with self.assertRaises(ThemeError):service.get_theme(theme['id'],user='two',private=True)
        self.assertEqual(service.list_themes()['items'],[])
        self.assertEqual(service.list_themes(user='one')['items'][0]['status'],'draft')

    def test_approved_revision_stays_public_during_edits_and_rejection(self):
        theme=self.approved();id=theme['id'];doc=document();doc['name']='Unreviewed edit'
        public_stamp=service.get_theme(id)['updatedAt']
        service.save('one',doc,id,1)
        self.assertEqual(service.get_theme(id)['updatedAt'],public_stamp)
        self.assertEqual(service.get_theme(id)['document']['name'],'Fixture only')
        self.assertEqual(service.list_themes(query='Unreviewed')['items'],[])
        service.transition(id,'one','submit',2)
        with self.assertRaises(ThemeError):service.transition(id,'admin','approve',1,admin=True)
        service.transition(id,'admin','reject',2,'Needs changes',admin=True)
        self.assertEqual(service.get_theme(id)['revision'],1)
        service.transition(id,'one','submit',2);service.transition(id,'admin','approve',2,admin=True)
        self.assertEqual(service.get_theme(id)['document']['name'],'Unreviewed edit')
        service.transition(id,'admin','unpublish',2,'Reported content',admin=True)
        with self.assertRaises(ThemeError):service.get_theme(id)

    def test_pending_immutable_withdraw_and_owner_isolation(self):
        theme=service.save('one',document());id=theme['id'];service.transition(id,'one','submit',1)
        for actor in ['one','two']:
            with self.assertRaises(ThemeError):service.save(actor,document(),id,1)
        with self.assertRaises(ThemeError):service.transition(id,'two','withdraw',1)
        with self.assertRaises(ThemeError):service.transition(id,'one','approve',1)
        service.transition(id,'one','withdraw',1);service.save('one',document(),id,1)
        with self.assertRaises(ThemeError):service.save('one',document(),id,1)

    def test_remix_pins_original_public_revision_and_cannot_forge_parent(self):
        parent=self.approved();remix=service.save('two',document(),parent_id=parent['id'],parent_revision=1)
        self.assertEqual(remix['remixOf']['revision'],1)
        with self.assertRaises(ThemeError):service.save('two',document(),parent_id=parent['id'],parent_revision=99)
        service.transition(parent['id'],'admin','unpublish',1,'Removed',admin=True)
        self.assertEqual(service.get_theme(remix['id'],user='two',private=True)['remixOf']['name'],'Fixture only')
        with self.assertRaises(ThemeError):service.save('two',document(),parent_id=parent['id'],parent_revision=1)
        self.assertEqual(service.list_themes()['items'],[])

    def test_reports_are_private_deduplicated_and_audited(self):
        id=self.approved()['id'];service.report(id,'two','Please review contrast')
        with self.assertRaises(ThemeError):service.report(id,'two','Another report')
        self.assertNotIn('reports',service.get_theme(id))
        private=service.get_theme(id,admin=True,private=True);self.assertEqual(len(private['reports']),1)
        service.resolve_report(private['reports'][0]['id'],'admin','Reviewed and addressed')
        private=service.get_theme(id,admin=True,private=True);self.assertEqual(private['reports'][0]['state'],'resolved')
        self.assertEqual(private['history'][0]['action'],'report-resolved')

    def test_api_auth_admin_and_csrf_enforced(self):
        response=self.client.get('/api/admin/themes');self.assertIn(response.status_code,(302,401))
        self.login('one');self.assertEqual(self.client.get('/api/admin/themes').status_code,403)
        self.assertEqual(self.write('/api/themes',{'document':document()},csrf=False).status_code,400)
        result=self.write('/api/themes',{'document':document()});self.assertEqual(result.status_code,201);id=result.json['theme']['id']
        self.assertEqual(self.client.get('/api/themes/'+id).status_code,404)
        self.assertEqual(self.write('/api/admin/themes/'+id+'/approve',{'expectedRevision':1}).status_code,403)
        self.assertEqual(self.write('/api/themes/'+id+'/submit',{'expectedRevision':1}).status_code,200)
        self.login('admin');self.assertEqual(self.write('/api/admin/themes/'+id+'/approve',{'expectedRevision':1},csrf=False).status_code,400)
        self.assertEqual(self.write('/api/admin/themes/'+id+'/approve',{'expectedRevision':1}).status_code,200)
        self.assertEqual(self.client.get('/api/themes/'+id).status_code,200)
        public=self.client.get('/api/themes/'+id).json['theme'];self.assertNotIn('ownerId',public);self.assertNotIn('history',public)

    def test_schema_rejects_injection_unbounded_data_and_external_fonts(self):
        for key,value in [('custom_styles','body{display:none}'),('custom_cards',{}),('credentials','secret')]:
            doc=document();doc['settings'][key]=value
            with self.assertRaises(ThemeError):service.save('one',doc)
        for color in ['url(https://evil.test)','red','#fff','#ffffff;body{}']:
            doc=document();doc['settings']['light_preset']['links']=color
            with self.assertRaises(ThemeError):service.save('one',doc)
        doc=document();doc['settings']['custom_font']['link']='https://evil.test'
        with self.assertRaises(ThemeError):service.save('one',doc)
        self.login('one');self.assertEqual(self.write('/api/themes',{'document':document(),'owner_id':'other'}).status_code,400)
        self.assertEqual(self.write('/api/themes',{'document':{'name':'x'*25000}}).status_code,413)

    def test_bounded_pagination_tag_and_search(self):
        for i in range(26):
            doc=document();doc['name']=f'Fixture {i:02}';t=service.save('one',doc);service.transition(t['id'],'one','submit',1);service.transition(t['id'],'admin','approve',1,admin=True)
        page=service.list_themes();self.assertEqual(len(page['items']),24);self.assertTrue(page['hasMore'])
        self.assertEqual(len(service.list_themes(offset=24)['items']),2)
        self.assertEqual(len(service.list_themes(query='Fixture 25',tag='study')['items']),1)
        self.assertEqual(service.list_themes(query='%')['items'],[])
        self.assertEqual(self.client.get('/api/themes?offset=-1').status_code,400)
