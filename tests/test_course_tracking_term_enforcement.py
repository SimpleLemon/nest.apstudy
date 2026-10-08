import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

from blueprints import courses
from services import course_tracking as polling
from services import course_tracking_terms as terms
from services.admin_tracking_terms import enabling_error
from tests import test_course_tracking_terms as policy_tests


class TermEnforcementTests(unittest.TestCase):
    setUp = policy_tests.TermPolicyTests.setUp
    save = policy_tests.TermPolicyTests.save

    def section(self, term):
        return {'id': term + '|CS|170|123|1', 'term': term, 'subject': 'CS',
                'catalog_number': '170', 'crn': '123', 'course_code': 'CS 170',
                'enrollment_status': 'Closed', 'seats_available': 0}

    def upsert(self, term, enabled):
        section = self.section(term)
        view = courses.upsert_track
        while hasattr(view, '__wrapped__'):
            view = view.__wrapped__
        with self.app.test_request_context('/tracks', method='POST', json={'section_id': section['id'], 'enabled': enabled}), ExitStack() as stack:
            for name, value in [('_require_emory_student', None), ('_get_section_by_id', section), ('_current_user_id', 'user'), ('_track_for_section', None), ('format_actor', 'User'), ('emit_course_track_event', None)]:
                stack.enter_context(patch.object(courses, name, return_value=value))
            stack.enter_context(patch.object(courses, 'current_user', SimpleNamespace(id='user')))
            stack.enter_context(patch.object(courses, 'request_entitlements', return_value={'key': 'free', 'label': 'Free', 'limits': {'seat_track_intervals_minutes': [30], 'max_seat_tracks': 10}, 'usage': {'seat_tracks': 0}}))
            stack.enter_context(patch.object(courses, 'check_limit'))
            create = stack.enter_context(patch.object(courses, 'create_row_safe', side_effect=lambda table, row_id, data: {'id': row_id, **data}))
            live = stack.enter_context(patch.object(courses, '_merge_live_section', return_value=(section, None, None, False)))
            response = view()
            return response, create, live

    def test_student_cannot_create_or_reenable_closed_fall(self):
        response, create, live = self.upsert('Fall_2026', True)
        self.assertEqual(response[1], 403)
        self.assertEqual(response[0].get_json()['code'], 'course_tracking_closed')
        create.assert_not_called()
        live.assert_not_called()

    def test_upcoming_subscription_is_saved_without_live_atlas_request(self):
        response, create, live = self.upsert('Spring_2027', True)
        self.assertTrue(response.get_json()['track']['enabled'])
        self.assertEqual(response.get_json()['track']['tracking_state'], 'queued')
        create.assert_called_once()
        live.assert_not_called()

    def test_closed_term_can_still_be_paused(self):
        response, create, live = self.upsert('Fall_2026', False)
        self.assertFalse(response.get_json()['track']['enabled'])
        create.assert_called_once()
        live.assert_not_called()

    def test_admin_group_is_validated_before_any_updates(self):
        with self.app.test_request_context('/'):
            blocked = enabling_error([{'term': 'Spring_2027'}, {'term': 'Fall_2026'}], True)
            self.assertEqual(blocked[1], 403)
            self.assertIsNone(enabling_error([{'term': 'Spring_2027'}], True))
            self.assertIsNone(enabling_error([{'term': 'Fall_2026'}], False))

    def run_poll(self, term, *, on_fetch=None, on_email=None, source='automated'):
        section = {**self.section(term), 'enrollment_status': 'Open', 'seats_available': 2}
        track = {'id': 'track', 'user_id': 'user', 'enabled': True, 'term': term,
                 'subject': 'CS', 'catalog': '170', 'crn': '123',
                 'last_status': 'Closed', 'last_seats_available': 0}
        def fetch(*args, **kwargs):
            if on_fetch:
                on_fetch()
            return {'section': section}
        with ExitStack() as stack:
            stack.enter_context(patch.object(polling, 'list_rows_all', return_value=[track]))
            atlas = stack.enter_context(patch.object(polling, 'fetch_live_section_status', side_effect=fetch))
            email = stack.enter_context(patch.object(polling, '_send_open_email', side_effect=on_email))
            push = stack.enter_context(patch.object(polling.notifications, 'notify', return_value=({}, {'accepted': 1})))
            stack.enter_context(patch.object(polling.notifications, 'preferences', return_value={'course_email_enabled': True, 'course_push_enabled': True}))
            update = stack.enter_context(patch.object(polling, 'update_row_safe'))
            stack.enter_context(patch.object(polling, 'emit_course_track_event'))
            stack.enter_context(patch.object(polling, 'update_course_tracks_channel_topic'))
            result = polling.check_course_seat_tracks(poll_source=source)
        return result, atlas, email, push, update

    def test_closed_and_upcoming_skip_automated_and_manual_polling(self):
        for term in ['Fall_2026', 'Spring_2027']:
            for source in ['automated', 'manual_admin_test']:
                with self.subTest(term=term, source=source):
                    result, atlas, email, push, update = self.run_poll(term, source=source)
                    self.assertEqual(result, 0)
                    for mocked in [atlas, email, push, update]:
                        mocked.assert_not_called()

    def test_close_during_atlas_response_suppresses_alerts_and_row_updates(self):
        self.save(state='open')
        result, atlas, email, push, update = self.run_poll('Spring_2027', on_fetch=lambda: self.save(state='closed'))
        self.assertEqual(result, 0)
        atlas.assert_called_once()
        email.assert_not_called()
        push.assert_not_called()
        update.assert_not_called()

    def test_close_between_delivery_channels_suppresses_later_push(self):
        self.save(state='open')
        result, atlas, email, push, update = self.run_poll('Spring_2027', on_email=lambda *args: self.save(state='closed'))
        self.assertEqual(result, 1)  # The already-sent email cannot be recalled.
        email.assert_called_once()
        push.assert_not_called()


if __name__ == '__main__':
    unittest.main()
