"""Compose schema initialization with feature migration follow-up work."""

import logging

from flask import Flask

from services import database


logger = logging.getLogger(__name__)


def initialize_application_database(app: Flask | None = None, path: database.DatabasePath | None = None) -> set[str]:
    applied_versions = database.init_db(app=app, path=path)
    if "001_notes_preview_text" in applied_versions:
        from services.note_store import backfill_preview_texts

        db_path = path or (app.config.get("DATABASE_PATH") if app is not None else None)
        try:
            backfill_preview_texts(path=db_path)
        except Exception:
            logger.exception("Failed to backfill notes preview_text after migration")
    return applied_versions
