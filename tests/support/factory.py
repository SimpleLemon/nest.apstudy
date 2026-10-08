"""Disposable app-factory environment and unrelated background worker guards."""

import os
import tempfile
from contextlib import contextmanager
from unittest.mock import patch

from flask import Flask


@contextmanager
def isolated_factory_environment(**overrides):
    """Keep factory database, instance files, and configuration inside one fixture."""
    with tempfile.TemporaryDirectory() as directory:
        instance_path = os.path.join(directory, "instance")
        values = {
            "DATABASE_PATH": os.path.join(directory, "nest.sqlite3"),
            "NEST_INSTANCE_DIR": instance_path,
            "FLASK_SECRET_KEY": "test-factory-secret",
            "FLASK_ENV": "testing",
            "FLASK_DEBUG": "0",
            "APSTUDY_ALLOW_INSECURE_HTTP": "0",
            "SCHEDULER_ENABLED": "0",
            "DISCORD_AUDIT_ENABLED": "0",
        }
        values.update(overrides)

        def temporary_flask(*args, **kwargs):
            kwargs["instance_path"] = instance_path
            return Flask(*args, **kwargs)

        with patch.dict(os.environ, values, clear=True), patch("app.Flask", side_effect=temporary_flask):
            yield directory
