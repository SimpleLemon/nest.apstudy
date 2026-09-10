from tests.test_calendar_phase2_store import CalendarPhase2StoreTests, ACCOUNT_1
from services import calendar_events as events
from services import extension_mirror_sync as sync
from services.extension_mirrors import inspect_item, change_item
from services.extension_bridge import inspect_conflict, resolve_conflict
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError


class MirrorSyncTests(CalendarPhase2StoreTests):
    def setup_mirror(self):
        self.personal_source()
        view = inspect_item('user-1', 'user:one')
        queued = change_item('user-1', {'event_ref':'user:one','source_ref':view['sources'][0]['source_ref'],
            'action':'mirror','expected_revision':view['expected_revision']})
        self.link = events.create_canvas_event_link('user-1','source-1', {
            'account_key':ACCOUNT_1,'event_ref':'user:one','canvas_item_id':'55','canvas_item_type':'calendar_event',
            'canvas_context_id':'user_1','canvas_calendar_id':'user_1','source_revision':'r1'})
        self.creation = queued['operation_id']
        events.record_canvas_writeback_result('user-1','source-1',self.creation, {'state':'applied','result_revision':'r1'})

    def observe(self, link, revision='r2', snapshot=None):
        return sync.observe('user-1','source-1', {'link_id':link['id'],'expected_revision':link['expected_revision'],
            'canvas_revision':revision, 'canvas_snapshot':snapshot or {'title':'Canvas edit','description':'From Canvas',
            'start':'2026-09-10T12:00:00Z','end':'2026-09-10T13:00:00Z','is_all_day':False}})

    def test_repeated_nest_edits_use_last_acknowledged_revision_and_no_duplicate_queue(self):
        self.setup_mirror()
        for number in (2, 3):
            with calendar_connection() as c:
                c.execute("UPDATE user_events SET title=? WHERE id='one'", ['Edit '+str(number)])
            self.assertEqual(sync.prepare('user-1','source-1'), [])
            self.assertEqual(sync.prepare('user-1','source-1'), [])
            queue = events.list_canvas_writebacks('user-1','source-1', states=['queued'])
            self.assertEqual(len(queue), 1)
            self.assertEqual(queue[0]['expected_revision'], 'r'+str(number-1))
            self.assertEqual(queue[0]['payload']['payload']['title'], 'Edit '+str(number))
            events.record_canvas_writeback_result('user-1','source-1',queue[0]['id'], {'state':'applied','result_revision':'r'+str(number)})
        self.assertEqual(len(sync.prepare('user-1','source-1')), 1)

    def test_canvas_edit_applies_once_and_stale_observation_cannot_overwrite_nest(self):
        self.setup_mirror()
        observation = sync.prepare('user-1','source-1')[0]
        self.assertEqual(self.observe(observation)['state'], 'applied')
        with self.assertRaises(ExtensionContractError):
            self.observe(observation)
        current = sync.prepare('user-1','source-1')[0]
        self.assertEqual(current['source_revision'], 'r2')
        with calendar_connection() as c:
            self.assertEqual(c.execute("SELECT title FROM user_events WHERE id='one'").fetchone()[0], 'Canvas edit')
            c.execute("UPDATE user_events SET title='New Nest edit' WHERE id='one'")
        with self.assertRaises(ExtensionContractError):
            self.observe(current, 'r3')
        sync.prepare('user-1','source-1')
        self.assertEqual(len(events.list_canvas_writebacks('user-1','source-1', states=['queued'])), 1)

    def test_edit_during_inflight_create_is_preserved_for_next_update(self):
        self.setup_mirror()
        with calendar_connection() as c:
            c.execute("UPDATE user_events SET title='Changed after dispatch' WHERE id='one'")
        # Duplicate acknowledgement must not reset the baseline to the current Nest edit.
        events.record_canvas_writeback_result('user-1','source-1',self.creation, {'state':'applied','result_revision':'r1'})
        sync.prepare('user-1','source-1')
        self.assertEqual(len(events.list_canvas_writebacks('user-1','source-1', states=['queued'])), 1)

    def test_remote_delete_requires_choice_and_pauses_only_linked_item(self):
        self.setup_mirror()
        observation=sync.prepare('user-1','source-1')[0]
        self.assertEqual(self.observe(observation, 'deleted', {'deleted':True})['state'], 'conflict')
        self.assertEqual(sync.prepare('user-1','source-1'), [])
        with calendar_connection() as c:
            self.assertIsNotNone(c.execute("SELECT * FROM user_events WHERE id='one'").fetchone())
        conflict=events.list_canvas_writebacks('user-1','source-1', states=['conflict'])[0]
        view=inspect_conflict('user-1','source-1',conflict['id'])
        self.assertEqual(view['canvasSnapshot'], {'deleted':True})

    def test_keep_canvas_resets_baseline_without_echoing_an_update(self):
        self.setup_mirror()
        with calendar_connection() as c:
            c.execute("UPDATE user_events SET title='Nest edit' WHERE id='one'")
        sync.prepare('user-1','source-1')
        queued=events.list_canvas_writebacks('user-1','source-1', states=['queued'])[0]
        events.record_canvas_writeback_result('user-1','source-1',queued['id'], {'state':'conflict','result_revision':'r2'})
        view=inspect_conflict('user-1','source-1',queued['id'], {'canvas_revision':'r2','canvas_snapshot':{'title':'Canvas edit'}})
        resolve_conflict('user-1','source-1',queued['id'], {'choice':'keep_canvas','expected_revision':view['expected_revision']})
        self.assertEqual(len(sync.prepare('user-1','source-1')), 1)
        self.assertEqual(events.list_canvas_writebacks('user-1','source-1', states=['queued']), [])

    def test_unlink_and_invalid_snapshots_never_mutate_the_item(self):
        self.setup_mirror()
        observation=sync.prepare('user-1','source-1')[0]
        with self.assertRaises(ExtensionContractError):
            self.observe(observation, snapshot={'title':'Missing fields'})
        view=inspect_item('user-1','user:one')
        change_item('user-1', {'event_ref':'user:one','source_ref':view['sources'][0]['source_ref'],
            'action':'unlink','expected_revision':view['expected_revision']})
        with self.assertRaises(ExtensionContractError):
            self.observe(observation)
        self.assertEqual(sync.prepare('user-1','source-1'), [])


    def test_planner_sync_preserves_local_day_time_and_reminders(self):
        from services.extension_consent import put_consent
        from services.extension_mirrors import _fields
        self.personal_source()
        put_consent('user-1','canvas:'+ACCOUNT_1,ACCOUNT_1,action='grant',
            scopes=['personal_events_write','planner_items_write','selected_item_mirroring'],version=2,path=self.db_path)
        with calendar_connection() as c:
            c.execute("INSERT INTO tasks (id,user_id,list_id,title,deadline_at,deadline_time,timezone,reminder_minutes,created_at) VALUES ('task1','user-1','list1','Late task','2026-09-10T03:30:00Z','23:30','America/New_York',10,'now')")
            item=dict(c.execute("SELECT * FROM tasks WHERE id='task1'").fetchone())
        self.assertEqual(_fields('tasks',item)['todo_date'],'2026-09-09')
        view=inspect_item('user-1','task:task1')
        queued=change_item('user-1',{'event_ref':'task:task1','source_ref':view['sources'][0]['source_ref'],'action':'mirror','expected_revision':view['expected_revision']})
        events.create_canvas_event_link('user-1','source-1',{'account_key':ACCOUNT_1,'event_ref':'task:task1',
            'canvas_item_id':'77','canvas_item_type':'planner_note','canvas_context_id':'user_1','canvas_calendar_id':'user_1','source_revision':'r1'})
        events.record_canvas_writeback_result('user-1','source-1',queued['operation_id'],{'state':'applied','result_revision':'r1'})
        link=sync.prepare('user-1','source-1')[0]
        self.observe(link,'r2',{'title':'Moved task','deadline_at':'2026-11-02T00:00:00Z'})
        with calendar_connection() as c:
            item=dict(c.execute("SELECT * FROM tasks WHERE id='task1'").fetchone())
        self.assertEqual(item['deadline_at'],'2026-11-03T04:30:00Z')
        self.assertEqual(item['deadline_time'],'23:30')
        self.assertEqual(item['reminder_minutes'],10)
        self.assertEqual(_fields('tasks',item)['todo_date'],'2026-11-02')
        self.assertEqual(len(sync.prepare('user-1','source-1')),1)


    def test_read_revocation_suspends_observations_and_outgoing_updates(self):
        self.setup_mirror()
        observation=sync.prepare('user-1','source-1')[0]
        from services.extension_consent import put_consent
        put_consent('user-1','canvas:'+ACCOUNT_1,ACCOUNT_1,action='revoke',scopes=[],version=1,path=self.db_path)
        with self.assertRaises(ExtensionContractError):
            self.observe(observation)
        with self.assertRaises(ExtensionContractError):
            sync.prepare('user-1','source-1')
        with calendar_connection() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM calendar_writebacks WHERE state='queued'").fetchone()[0],0)
