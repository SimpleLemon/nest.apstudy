#!/usr/bin/env python3
"""Daily SQLite backup for Nest.APStudy with Discord server-log notifications."""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv

load_dotenv(ROOT_DIR / ".env")

from services.discord_audit import DiscordAuditEvent, emit_backup_event, send_audit_event_sync
from services.database import nest_instance_dir


DEFAULT_INSTANCE_DIR = Path(nest_instance_dir())
DEFAULT_BACKUP_DIR = Path(os.environ.get("NEST_BACKUP_DIR", "/var/backups/nest-db"))
MAX_BACKUPS = int(os.environ.get("NEST_BACKUP_RETENTION", "7"))

DATABASES = (
    ("nest.sqlite3", "nest.sqlite3"),
    ("calendar.sqlite3", "calendar.sqlite3"),
    ("apswiftly/aoi.db", "apswiftly/aoi.db"),
)


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _format_bytes(num_bytes: int | None) -> str:
    if num_bytes is None:
        return "unknown"
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def _backup_database(source: Path, destination: Path) -> tuple[bool, str]:
    if not source.is_file():
        return False, f"[WARN] {source.name} not found, skipping"

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_conn:
            source_conn.execute("PRAGMA busy_timeout = 5000")
            with sqlite3.connect(destination) as dest_conn:
                source_conn.backup(dest_conn)
    except sqlite3.Error as exc:
        return False, f"[ERROR] Failed to backup {source.name}: {exc}"

    size_label = _format_bytes(_file_size(destination))
    return True, f"[SUCCESS] {source.name} backed up ({size_label})"


def _rotate_backups(backup_dir: Path, max_backups: int) -> list[str]:
    backup_dirs = sorted(backup_dir.glob("backup_*"), key=lambda path: path.name)
    messages: list[str] = []
    delete_count = len(backup_dirs) - max_backups
    if delete_count <= 0:
        return messages

    for old_backup in backup_dirs[:delete_count]:
        messages.append(f"[ROTATE] Deleting old backup: {old_backup}")
        for child in old_backup.iterdir():
            child.unlink(missing_ok=True)
        old_backup.rmdir()
    return messages


def run_backup(*, instance_dir: Path, backup_dir: Path, max_backups: int, notify_discord: bool) -> int:
    timestamp = _utc_timestamp()
    backup_subdir = backup_dir / f"backup_{timestamp}"
    log_lines: list[str] = []
    errors = 0
    backed_up: list[str] = []

    backup_subdir.mkdir(parents=True, exist_ok=True)

    for source_name, dest_name in DATABASES:
        ok, message = _backup_database(instance_dir / source_name, backup_subdir / dest_name)
        log_lines.append(message)
        print(message)
        if ok:
            backed_up.append(source_name)
        elif "[ERROR]" in message:
            errors += 1

    if errors == 0 and backed_up:
        summary = f"[SUCCESS] Full backup created: {backup_subdir}"
        color = "green"
    elif backed_up:
        summary = f"[WARNING] Backup completed with {errors} error(s): {backup_subdir}"
        color = "yellow"
    else:
        summary = f"[ERROR] Backup failed with no databases copied: {backup_subdir}"
        color = "red"

    log_lines.append(summary)
    print(summary)

    rotate_lines = _rotate_backups(backup_dir, max_backups)
    for line in rotate_lines:
        log_lines.append(line)
        print(line)

    remaining = sorted(backup_dir.glob("backup_*"), key=lambda path: path.name)
    info_lines = [
        "[INFO] Current backups:",
        *[str(path) for path in remaining],
        f"[INFO] Total backup sets: {len(remaining)}",
    ]
    for line in info_lines:
        log_lines.append(line)
        print(line)

    if notify_discord:
        metadata = {
            "backup_path": str(backup_subdir),
            "databases": ", ".join(backed_up) or "none",
            "errors": errors,
            "retention": max_backups,
            "total_sets": len(remaining),
        }
        for source_name in backed_up:
            size = _file_size(backup_subdir / source_name)
            metadata[f"{source_name}_size"] = _format_bytes(size)

        title = "Database Backup Created" if errors == 0 else "Database Backup Completed With Errors"
        if not backed_up:
            title = "Database Backup Failed"

        event = DiscordAuditEvent(
            channel="server_logs",
            title=title,
            actor="System",
            target=str(backup_subdir),
            metadata=metadata,
            color=color,
        )
        sent = send_audit_event_sync(event)
        if not sent:
            emit_backup_event(
                title,
                target=str(backup_subdir),
                metadata={**metadata, "delivery": "queued_fallback"},
                color=color,
            )

    return 1 if errors or not backed_up else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Back up Nest.APStudy SQLite databases.")
    parser.add_argument("--instance-dir", type=Path, default=DEFAULT_INSTANCE_DIR)
    parser.add_argument("--backup-dir", type=Path, default=DEFAULT_BACKUP_DIR)
    parser.add_argument("--max-backups", type=int, default=MAX_BACKUPS)
    parser.add_argument("--no-discord", action="store_true")
    args = parser.parse_args(argv)

    return run_backup(
        instance_dir=args.instance_dir,
        backup_dir=args.backup_dir,
        max_backups=args.max_backups,
        notify_discord=not args.no_discord,
    )


if __name__ == "__main__":
    raise SystemExit(main())
