#!/usr/bin/env python3
"""Import Appwrite upload bytes in explicit dry-run/copy/verify/promote stages."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv

from config import load_environment_config
from services.database import database_path, init_db
from scripts.storage_migration.promotion import promote
from scripts.storage_migration.runner import run_stage
from scripts.storage_migration.source import AppwriteSource, SourceConfig


def source_config(environment=None):
    environment = environment or load_environment_config()
    return SourceConfig(
        environment.appwrite_endpoint or "", environment.appwrite_project_id or "",
        {"avatars": environment.appwrite_profile_avatar_bucket_id,
         "shared_files": environment.appwrite_file_share_bucket_id,
         "note_media": environment.appwrite_notes_media_bucket_id,
         "chat_attachments": environment.appwrite_chat_attachments_bucket_id},
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("dry-run", "copy", "verify", "promote"))
    parser.add_argument("--database-path", type=Path)
    parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env")
    args = parser.parse_args(argv)
    try:
        load_dotenv(args.env_file, override=False)
        environment = load_environment_config()
        path = database_path(args.database_path)
        config = source_config(environment)
        if args.stage == "copy":
            init_db(path=path)
        if args.stage == "promote":
            summary = promote(path, config)
        else:
            source = AppwriteSource(config, environment.appwrite_api_key or "")
            summary = run_stage(args.stage, source, path)
        print(json.dumps(summary, sort_keys=True))
        return 1 if summary.get("failed") else 0
    except Exception as exc:
        # Deliberately omit exception text/tracebacks and remote responses.
        print(f"{type(exc).__name__}: migration stage failed; see the local manifest and runbook.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
