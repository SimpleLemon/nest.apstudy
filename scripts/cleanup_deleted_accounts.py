#!/usr/bin/env python3
"""Complete durable account Auth deletions, without sending notifications."""

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
from services.account_deletion_completion import account_deletion_counts, cleanup_pending_accounts
from services.storage_backend import require_mutations_enabled
from services.storage_errors import StorageMutationPaused
from scripts.storage_migration.references import readonly_connection, table_columns


def deletion_counts(path, *, account_user_id=None):
    """Read deployed intent without creating a database or running migrations."""
    with closing(readonly_connection(path)) as conn:
        if "auth_deleted_at" not in table_columns(conn, "storage_account_deletions"):
            raise RuntimeError("Account deletion completion schema must be deployed before cleanup.")
        return account_deletion_counts(conn, account_user_id=account_user_id)


def run_cleanup(path, *, status_only=False, account_user_id=None, limit=100,
                delete_auth=None, cleanup_functions=None):
    initial = deletion_counts(path, account_user_id=account_user_id)
    app = Flask("nest_account_deletion_completion")
    app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = load_environment_config()
    app.config["DATABASE_PATH"] = str(path)
    completed, failed = 0, 0
    with app.app_context():
        try:
            require_mutations_enabled()
            paused = False
        except StorageMutationPaused:
            paused = True
        if not status_only:
            if paused:
                failed = 1
            else:
                try:
                    result = cleanup_pending_accounts(
                        account_user_id=account_user_id, limit=limit,
                        delete_auth=delete_auth, cleanup_functions=cleanup_functions,
                    )
                    completed, failed = result["completed"], result["failed"]
                except StorageMutationPaused:
                    paused, failed = True, 1
    final = initial if status_only else deletion_counts(path, account_user_id=account_user_id)
    return {"stage": "status" if status_only else "completion", "paused": paused, "failed": failed,
            "completed": completed, "accounts": final, "pending": final["pending"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-path", type=Path)
    parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env")
    parser.add_argument("--status", action="store_true", help="Read intent counts without SDK calls or mutations.")
    parser.add_argument("--account-user-id", help="Limit completion and counts to one deleted account.")
    parser.add_argument("--limit", type=int, default=100, help="Maximum eligible accounts to complete in this pass.")
    args = parser.parse_args(argv)
    previous_disable = logging.root.manager.disable
    try:
        # Emit only sanitized JSON; SDK exception bodies can contain secrets.
        logging.disable(logging.CRITICAL)
        load_dotenv(args.env_file, override=False)
        result = run_cleanup(database_path(args.database_path), status_only=args.status,
                             account_user_id=args.account_user_id, limit=args.limit)
        print(json.dumps(result, sort_keys=True))
        return 1 if result["failed"] or result["pending"] else 0
    except Exception as exc:
        print(json.dumps({"failed": 1, "error_type": type(exc).__name__,
                          "message": "Account completion failed; no secret response was printed."}, sort_keys=True))
        return 1
    finally:
        logging.disable(previous_disable)


if __name__ == "__main__":
    raise SystemExit(main())
