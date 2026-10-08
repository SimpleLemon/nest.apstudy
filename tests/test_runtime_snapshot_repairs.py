"""Runtime settings stay with their app and factory tests remain disposable."""

import ast
import asyncio
import os
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from flask import Flask

from app import create_app
from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services import apswiftly_control, discord_audit, discord_bridge, discord_gateway
from services.environment_config import chat_runtime_settings
from tests.support.factory import isolated_factory_environment


def snapshot_app(**values):
    with patch.dict(os.environ, {}, clear=True):
        configured = replace(load_environment_config(), **values)
    app = Flask(__name__)
    app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = configured
    return app


class RuntimeSnapshotRepairTests(unittest.TestCase):
    def test_chat_presence_defaults_follow_each_app_after_environment_changes(self):
        from blueprints import chat_api
        first = snapshot_app(presence_chat_fresh_seconds_raw="41", chat_events_stream_limit_raw="3")
        second = snapshot_app(presence_chat_fresh_seconds_raw="72", chat_events_stream_limit_raw="8")
        with patch.dict(os.environ, {"PRESENCE_CHAT_FRESH_SECONDS": "999"}):
            for app, expected, limit in [(first, 41, 3), (second, 72, 8)]:
                with app.app_context(), patch.object(chat_api, "_fresh_presence_rows_service", return_value=[]) as rows:
                    chat_api._fresh_presence_rows()
                    self.assertEqual(rows.call_args.kwargs["seconds"], expected)
                    self.assertEqual(chat_api._presence_fresh_seconds("chat"), expected)
                    self.assertEqual(chat_runtime_settings().stream_limit, limit)

    def test_role_link_settings_follow_the_current_app_and_keep_empty_ids(self):
        first = snapshot_app(discord_link_guild_id=" guild-one ", discord_link_role_id=" role-one ")
        second = snapshot_app(discord_link_guild_id="", discord_link_role_id="")
        with patch.dict(os.environ, {"DISCORD_LINK_GUILD_ID": "changed"}):
            with first.app_context():
                self.assertEqual(discord_bridge._link_guild_id(), "guild-one")
                self.assertEqual(discord_bridge._link_role_id(), "role-one")
                self.assertEqual(discord_bridge._link_role_id("override"), "override")
            with second.app_context():
                self.assertEqual(discord_bridge._link_guild_id(), "")
                self.assertEqual(discord_bridge._link_role_id(), "")

    def test_control_requests_and_systemd_commands_use_each_apps_snapshot(self):
        first = snapshot_app(apswiftly_control_url_raw="https://one.example///", apswiftly_control_token_raw=" one-token ", apswiftly_service_name_raw=" one-service ", apswiftly_control_timeout_seconds_raw="0")
        second = snapshot_app(apswiftly_control_url_raw="https://two.example/", apswiftly_control_token_raw=" two-token ", apswiftly_service_name_raw="two-service", apswiftly_control_timeout_seconds_raw="7")
        with patch.dict(os.environ, {"APSWIFTLY_CONTROL_TOKEN": "changed-token"}):
            for app, host, token, service, timeout in [(first, "one", "one-token", "one-service", 1), (second, "two", "two-token", "two-service", 7)]:
                with app.app_context(), patch.object(apswiftly_control.requests, "post", return_value=SimpleNamespace(content=b"", ok=True)) as post, patch.object(apswiftly_control.subprocess, "run", return_value=SimpleNamespace(stdout="active", stderr="")) as command, patch.object(apswiftly_control, "_resolve_executable", side_effect=lambda name: name):
                    apswiftly_control.apswiftly_reload()
                    self.assertEqual(post.call_args.args[0], f"https://{host}.example/api/control/reload")
                    self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], f"Bearer {token}")
                    self.assertEqual(post.call_args.kwargs["timeout"], timeout)
                    self.assertEqual(apswiftly_control._service_state(), "active")
                    self.assertEqual(command.call_args.args[0][-1], service)
                    self.assertEqual(command.call_args.kwargs["timeout"], timeout)

    def test_gateway_authenticates_with_supplied_snapshot_without_context(self):
        app = snapshot_app(discord_bot_token=" original-token ")
        bridge = discord_gateway.DiscordGatewayBridge(app)
        client = SimpleNamespace(event=lambda callback: callback, start=AsyncMock())
        discord = SimpleNamespace(Intents=SimpleNamespace(none=lambda: SimpleNamespace()), Client=lambda **kwargs: client)
        with patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "changed-token"}), patch.dict("sys.modules", {"discord": discord}):
            asyncio.run(bridge._run_client())
        client.start.assert_awaited_once_with("original-token", reconnect=True)

    def test_gateway_status_uses_the_bridge_snapshot_without_starting_network_work(self):
        app = snapshot_app(discord_gateway_enabled_raw="1")
        thread = SimpleNamespace(is_alive=Mock(return_value=True))
        bridge = SimpleNamespace(app=app, started=True, thread=thread)
        with patch.object(discord_gateway, "_bridge", bridge), \
                patch.dict(os.environ, {"DISCORD_GATEWAY_ENABLED": "0"}):
            self.assertEqual(discord_gateway.discord_gateway_status(), {
                "enabled": True, "started": True, "thread_alive": True,
            })
        thread.is_alive.assert_called_once_with()

    def test_gateway_status_without_a_bridge_uses_the_current_app_snapshot(self):
        app = snapshot_app(discord_gateway_enabled_raw="0")
        with patch.object(discord_gateway, "_bridge", None), app.app_context(), \
                patch.dict(os.environ, {"DISCORD_GATEWAY_ENABLED": "1"}):
            self.assertEqual(discord_gateway.discord_gateway_status(), {
                "enabled": False, "started": False, "thread_alive": False,
            })

    def test_audit_sender_and_retry_use_bound_snapshot_without_context(self):
        app = snapshot_app(discord_bot_token=" original-token ", discord_audit_admin_channel_id=" original-admin ", discord_audit_console_logs_channel_id="original-console")
        with isolated_factory_environment() as directory, patch.object(discord_audit, "_service", None), patch.object(discord_audit.DiscordAuditService, "start"), patch.object(discord_audit, "init_discord_error_reporting"), patch.object(discord_audit, "init_server_console_forwarding"):
            app.instance_path = directory
            service = discord_audit.init_discord_audit(app)
            response = SimpleNamespace(status_code=200, json=lambda: [])
            service.request_func = Mock(return_value=response)
            with patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "changed-token", "DISCORD_AUDIT_ADMIN_CHANNEL_ID": "changed-admin", "DISCORD_CONSOLE_LOG_ENABLED": "0"}):
                event = discord_audit.DiscordAuditEvent(channel="admin", title="Test", actor="Test", target="Test")
                service._send_queued(discord_audit._QueuedAuditEvent(event=event))
                self.assertFalse(service._already_posted(event))
                self.assertTrue(service.emit_console_content("Test console"))
            calls = service.request_func.call_args_list
            self.assertIn("/channels/original-admin/messages", calls[0].args[1])
            self.assertIn("/channels/original-admin/messages", calls[1].args[1])
            self.assertIn("/channels/original-console/messages", calls[2].args[1])
            for call in calls:
                self.assertEqual(call.kwargs["headers"]["Authorization"], "Bot original-token")

    def test_factory_rejects_invalid_feature_numbers_before_database_startup(self):
        for setting in ("CHAT_EVENTS_POLL_SECONDS", "PRESENCE_LOOKUP_LIMIT", "APSWIFTLY_CONTROL_TIMEOUT_SECONDS"):
            with self.subTest(setting=setting), isolated_factory_environment(**{setting: "invalid"}), patch("services.database_initialization.initialize_application_database") as initialize, patch("services.scheduler.init_scheduler"), patch("services.discord_audit.init_discord_audit"):
                with self.assertRaises(ValueError):
                    create_app()
                initialize.assert_not_called()

    def test_authentication_does_not_reverse_import_composition_root(self):
        import blueprints.auth as auth
        tree = ast.parse(Path(auth.__file__).read_text())
        self.assertFalse(any(isinstance(node, ast.ImportFrom) and node.module == "app" for node in ast.walk(tree)))
        from app import AUTH_SESSION_DURATION
        from services.auth_config import AUTH_SESSION_DURATION as default_duration
        self.assertEqual(AUTH_SESSION_DURATION, default_duration)

    def test_direct_entrypoint_does_not_force_debug_mode(self):
        import app
        tree = ast.parse(Path(app.__file__).read_text())
        main_guard = tree.body[-1]
        server = Mock()
        namespace = {"create_app": lambda: server}
        exec(compile(ast.Module(body=main_guard.body, type_ignores=[]), app.__file__, "exec"), namespace)
        server.run.assert_called_once_with("localhost", 5000)

    def test_admin_fixtures_restore_previous_environment_even_if_setup_fails(self):
        from tests.test_admin_security import AdminSecurityTestCase
        from tests.test_apswiftly_admin import APSwiftlyAdminTestCase
        for fixture in (AdminSecurityTestCase, APSwiftlyAdminTestCase):
            class FailingFixture(fixture):
                def setUp(self):
                    super().setUp()
                    raise RuntimeError("simulated setup failure")
            for previous in (None, "previous-admins"):
                values = {} if previous is None else {"ADMIN_USER_IDS": previous}
                with self.subTest(fixture=fixture.__name__, previous=previous), patch.dict(os.environ, values, clear=True):
                    case = FailingFixture("test_format_service_state_display_active" if fixture is APSwiftlyAdminTestCase else "test_session_cookie_flags_are_hardened")
                    result = unittest.TestResult()
                    case.run(result)
                    self.assertEqual(len(result.errors), 1)
                    self.assertEqual(os.environ.get("ADMIN_USER_IDS"), previous)
