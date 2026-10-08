#!/usr/bin/env python3
"""Drain durable Appwrite deletion queues before cutover, without notifications."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from contextlib import closing
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv
from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services.database import database_path
from services.storage_backend import require_mutations_enabled
from services.storage_errors import StorageMutationPaused
from scripts.storage_migration.references import readonly_connection, table_columns

NAMESPACES = ("avatars", "shared_files", "note_media", "chat_attachments")


def queue_counts(path, *, account_user_id=None, object_ids=None):
    """Read existing queues without creating a database or running migrations."""
    clauses, values = [], []
    if account_user_id is not None:
        clauses.append("account_user_id=?")
        values.append(account_user_id)
    if object_ids is not None:
        clauses.append("object_id IN (" + ",".join("?" for _ in object_ids) + ")" if object_ids else "0=1")
        values.extend(object_ids)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with closing(readonly_connection(path)) as conn:
        if not table_columns(conn, "storage_legacy_deletions"):
            raise RuntimeError("Compatibility queue schema must be deployed before draining.")
        rows = conn.execute(
            "SELECT namespace,COUNT(*) FROM storage_legacy_deletions" + where + " GROUP BY namespace", values,
        ).fetchall()
    counts = dict(rows)
    return {namespace: counts.get(namespace, 0) for namespace in NAMESPACES}


def _cleanup_functions():
    # Load configured feature clients only after the explicit environment file.
    from services.avatar_storage import cleanup_legacy_avatars
    from services.file_share_store import cleanup_legacy_files
    from services.note_media import cleanup_legacy_media
    from services.chat_attachments import cleanup_legacy_attachments

    return {"avatars": cleanup_legacy_avatars, "shared_files": cleanup_legacy_files,
            "note_media": cleanup_legacy_media, "chat_attachments": cleanup_legacy_attachments}


def run_cleanup(path, *, status_only=False, account_user_id=None, object_ids=None, cleanup_functions=None):
    """Wait for each scoped API cleanup to settle, then read authoritative counts."""
    scope = {"account_user_id": account_user_id, "object_ids": object_ids}
    initial = queue_counts(path, **scope)
    app = Flask("nest_legacy_storage_queue_drain")
    app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = load_environment_config()
    app.config["DATABASE_PATH"] = str(path)
    results = {namespace: {"completed": 0, "pending": initial[namespace]} for namespace in NAMESPACES}
    failures = 0
    with app.app_context():
        try:
            require_mutations_enabled()
            paused = False
        except StorageMutationPaused:
            paused = True
        if not status_only:
            if paused:
                failures = 1
            else:
                functions = cleanup_functions if cleanup_functions is not None else _cleanup_functions()
                for namespace in NAMESPACES:
                    try:
                        result = functions[namespace](**scope)
                        results[namespace]["completed"] = result["completed"]
                    except Exception as exc:
                        results[namespace]["error_type"] = type(exc).__name__
                        failures += 1
                        if isinstance(exc, StorageMutationPaused):
                            paused = True
                            break
    final = queue_counts(path, **scope)
    for namespace in NAMESPACES:
        results[namespace]["pending"] = final[namespace]
    return {"stage": "status" if status_only else "drain", "paused": paused,
            "namespaces": results, "pending": sum(final.values()), "failed": failures}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-path", type=Path)
    parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env")
    parser.add_argument("--status", action="store_true", help="Read queue counts without remote calls or mutations.")
    parser.add_argument("--account-user-id", help="Limit drain and final counts to one account's durable work.")
    parser.add_argument("--object-id", action="append", help="Limit drain and counts to these object IDs; repeat as needed.")
    args = parser.parse_args(argv)
    previous_disable = logging.root.manager.disable
    try:
        # Transports may log exception bodies; this CLI emits only sanitized JSON.
        logging.disable(logging.CRITICAL)
        load_dotenv(args.env_file, override=False)
        result = run_cleanup(database_path(args.database_path), status_only=args.status,
                             account_user_id=args.account_user_id, object_ids=args.object_id)
        print(json.dumps(result, sort_keys=True))
        return 1 if result["failed"] or result["pending"] else 0
    except Exception as exc:
        print(json.dumps({"failed": 1, "error_type": type(exc).__name__,
                          "message": "Storage queue operation failed; no secret response was printed."}, sort_keys=True))
        return 1
    finally:
        logging.disable(previous_disable)


if __name__ == "__main__":
    raise SystemExit(main())
