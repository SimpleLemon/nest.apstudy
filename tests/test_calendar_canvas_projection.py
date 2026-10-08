import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from services import calendar_events


def canvas_row(
    event_ref="canvas:source-1:event-1",
    *,
    source_id="source-1",
    account_key="canvas-1",
    status="incomplete",
    soft_deleted=0,
):
    return {
        "id": event_ref,
        "canvas_source_id": source_id,
        "canvas_account_key": account_key,
        "canvas_event_ref": event_ref,
        "canvas_source_item_key": "source-1/item-1",
        "canvas_context_id": "course-1",
        "canvas_calendar_id": "canvas-calendar-1",
        "canvas_item_type": "assignment",
        "canvas_completion_status": status,
        "canvas_completion_source": "canvas",
        "canvas_soft_deleted": soft_deleted,
        "event_uid": "item-1",
        "event_title": "Read chapter 1",
        "event_start": "2026-08-12T10:00:00Z",
        "event_end": "2026-08-12T11:00:00Z",
        "event_type": "assignment",
        "course_name": "BIO 101",
        "raw_description": "Read the assigned chapter.",
        "is_all_day": False,
        "fetched_at": "2026-08-12T09:00:00Z",
    }


def source_row(*, source_id="source-1", account_key="canvas-1", status="active", default="local:canvas"):
    return {
        "source_id": source_id,
        "account_key": account_key,
        "provider": "canvas",
        "label": "BIO Canvas",
        "origin": "https://canvas.example.edu",
        "status": status,
        "default_mirror_calendar": default,
    }


class CanvasProjectionTests(unittest.TestCase):
    def project(self, rows, *, sources=None, routes=None, overrides=None, preferences=None):
        return calendar_events._project_canvas_calendar_events(
            "user-1",
            rows,
            overrides or {},
            source_rows=sources if sources is not None else [source_row()],
            routing_rows=routes or [],
            preferences=preferences or [],
        )

    def test_active_canvas_event_has_additive_authenticated_fields(self):
        event = self.project([canvas_row()])[0]

        self.assertEqual(event["event_ref"], "canvas:source-1:event-1")
        self.assertEqual(event["source_type"], "canvas")
        self.assertEqual(event["provider"], "canvas")
        self.assertEqual(event["source_id"], "source-1")
        self.assertEqual(event["account_label"], "BIO Canvas")
        self.assertEqual(event["source_item_type"], "assignment")
        self.assertEqual(event["source_item_key"], "source-1/item-1")
        self.assertEqual(event["source_url"], "https://canvas.example.edu")
        self.assertEqual(event["original_calendar_id"], "canvas-calendar-1")
        self.assertEqual(event["calendar_id"], "local:canvas")
        self.assertFalse(event["has_override"])
        self.assertTrue(event["routing_degraded"])
        self.assertFalse(event["stale"])

    def test_archived_revoked_and_soft_deleted_canvas_rows_are_excluded(self):
        rows = [
            canvas_row("canvas:source-1:soft", soft_deleted=1),
            canvas_row("canvas:source-2:archived", source_id="source-2"),
            canvas_row("canvas:source-3:revoked", source_id="source-3"),
        ]
        sources = [
            source_row(),
            source_row(source_id="source-2", status="archived"),
            # A revoked source is absent from the active-consented source loader.
        ]

        projected = self.project(rows, sources=sources)

        self.assertEqual(projected, [])

    def test_hide_override_and_explicit_calendar_override_win(self):
        hidden_ref = "canvas:source-1:hidden"
        moved_ref = "canvas:source-1:moved"
        rows = [canvas_row(hidden_ref), canvas_row(moved_ref)]
        overrides = {
            hidden_ref: {"event_ref": hidden_ref, "hidden": True},
            moved_ref: {
                "$id": "override-1",
                "event_ref": moved_ref,
                "title": "Renamed locally",
                "calendar_id": "local:override",
            },
        }

        projected = self.project(
            rows,
            routes=[{
                "source_id": "source-1",
                "state": "incomplete",
                "destination_calendar_id": "local:route",
            }],
            overrides=overrides,
        )

        self.assertEqual(len(projected), 1)
        self.assertEqual(projected[0]["title"], "Renamed locally")
        self.assertEqual(projected[0]["calendar_id"], "local:override")
        self.assertTrue(projected[0]["has_override"])
        self.assertFalse(projected[0]["routing_degraded"])
        self.assertEqual(overrides[moved_ref]["calendar_id"], "local:override")

    def test_missing_destination_uses_source_or_visible_fallback_and_degrades(self):
        source_default = self.project(
            [canvas_row()],
            sources=[source_row(default="local:source-default")],
            routes=[{"source_id": "source-1", "state": "incomplete"}],
            preferences=[{"calendar_name": "local:visible", "visible": True}],
        )[0]
        visible_fallback = self.project(
            [canvas_row()],
            sources=[source_row(default=None)],
            routes=[],
            preferences=[{"calendar_name": "local:visible", "visible": True}],
        )[0]

        self.assertEqual(source_default["calendar_id"], "local:source-default")
        self.assertTrue(source_default["routing_degraded"])
        self.assertEqual(visible_fallback["calendar_id"], "local:visible")
        self.assertTrue(visible_fallback["routing_degraded"])

    def test_completion_routing_uses_completed_destination(self):
        event = self.project(
            [canvas_row(status="completed")],
            routes=[
                {
                    "source_id": "source-1",
                    "state": "incomplete",
                    "destination_calendar_id": "local:incomplete",
                },
                {
                    "source_id": "source-1",
                    "state": "completed",
                    "destination_calendar_id": "local:completed",
                },
            ],
        )[0]

        self.assertEqual(event["completion_status"], "completed")
        self.assertEqual(event["calendar_id"], "local:completed")
        self.assertFalse(event["routing_degraded"])



if __name__ == "__main__":
    unittest.main()
