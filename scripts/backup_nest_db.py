#!/usr/bin/env python3
"""Daily Nest/APSwiftly database backup with Discord server-log notifications."""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv

from config import load_environment_config
from services.discord_audit import DiscordAuditEvent, emit_backup_event, send_audit_event_sync
from services.database import nest_instance_dir
from services.storage_backend import storage_setting
from scripts.storage_backup import verify_backup


DEFAULT_BACKUP_DIR = Path("/var/backups/nest-db")
MAX_BACKUPS = 7

SQLITE_DATABASES = (
    ("nest.sqlite3", "nest.sqlite3"),
    ("calendar.sqlite3", "calendar.sqlite3"),
)

APSWIFTLY_DATA_DIR = ("apswiftly", "apswiftly")


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _directory_size(path: Path) -> int | None:
    try:
        return sum(file_path.stat().st_size for file_path in path.rglob("*") if file_path.is_file())
    except OSError:
        return None


def _directory_has_data(path: Path) -> bool:
    if not path.is_dir():
        return False
    for file_path in path.rglob("*"):
        if file_path.is_file() and file_path.name != ".DS_Store":
            return True
    return False


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
        return False, f"[ERROR] Required database {source.name} not found"

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as source_conn:
            source_conn.execute("PRAGMA busy_timeout = 5000")
            with closing(sqlite3.connect(destination)) as dest_conn:
                destination.chmod(0o600)
                source_conn.backup(dest_conn)
                dest_conn.commit()

        # The completed snapshot is immutable during validation. This avoids
        # creating WAL/SHM sidecars in the backup set when the source database
        # uses WAL mode.
        with closing(
            sqlite3.connect(f"file:{destination}?mode=ro&immutable=1", uri=True)
        ) as check_conn:
            integrity_rows = check_conn.execute("PRAGMA integrity_check").fetchall()
            if integrity_rows != [("ok",)]:
                raise sqlite3.DatabaseError(f"integrity_check failed: {integrity_rows!r}")
            foreign_key_rows = check_conn.execute("PRAGMA foreign_key_check").fetchall()
            if foreign_key_rows:
                raise sqlite3.IntegrityError(
                    f"foreign_key_check failed: {foreign_key_rows!r}"
                )
    except sqlite3.Error as exc:
        try:
            destination.unlink(missing_ok=True)
        except OSError:
            pass
        return False, f"[ERROR] Failed to backup {source.name}: {exc}"

    size_label = _format_bytes(_file_size(destination))
    return True, f"[SUCCESS] {source.name} backed up ({size_label})"


def _backup_directory(source: Path, destination: Path, *, label: str) -> tuple[bool, str]:
    if not source.is_dir():
        return False, f"[WARN] {label} not found, skipping"

    if not _directory_has_data(source):
        return False, f"[WARN] {label} is empty, skipping"

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".DS_Store"))
    except OSError as exc:
        return False, f"[ERROR] Failed to backup {label}: {exc}"

    size_label = _format_bytes(_directory_size(destination))
    return True, f"[SUCCESS] {label} backed up ({size_label})"


def _rotate_backups(backup_dir: Path, max_backups: int) -> list[str]:
    backup_dirs = sorted(backup_dir.glob("backup_*"), key=lambda path: path.name)
    messages: list[str] = []
    delete_count = len(backup_dirs) - max_backups
    if delete_count <= 0:
        return messages

    for old_backup in backup_dirs[:delete_count]:
        messages.append(f"[ROTATE] Deleting old backup: {old_backup}")
        shutil.rmtree(old_backup)
    return messages


def run_backup(*, instance_dir: Path, backup_dir: Path, max_backups: int, notify_discord: bool,
               preserve_history: bool = False, storage_keyring: Path | None = None) -> int:
    if max_backups < 1:
        raise ValueError("max_backups must be at least 1")

    timestamp = _utc_timestamp()
    backup_subdir = backup_dir / f"backup_{timestamp}"
    staging_subdir = backup_dir / f".backup_{timestamp}.incomplete"
    log_lines: list[str] = []
    errors = 0
    backed_up: list[str] = []
    skipped: list[str] = []
    backup_sizes: dict[str, int | None] = {}

    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging_subdir.mkdir(mode=0o700, exist_ok=False)

    for source_name, dest_name in SQLITE_DATABASES:
        destination = staging_subdir / dest_name
        ok, message = _backup_database(instance_dir / source_name, destination)
        log_lines.append(message)
        print(message)
        if ok:
            backed_up.append(source_name)
            backup_sizes[source_name] = _file_size(destination)
        elif "[ERROR]" in message:
            errors += 1
        elif "[WARN]" in message:
            skipped.append(source_name)

    apswiftly_source, apswiftly_dest = APSWIFTLY_DATA_DIR
    keyring = storage_keyring or storage_setting("NEST_UPLOAD_KEYRING_PATH")
    key_path = Path(keyring).resolve() if keyring else None
    apswiftly_path = instance_dir / apswiftly_source
    keys_in_data = bool(key_path and (
        key_path.is_relative_to(apswiftly_path.resolve())
        or (key_path.exists() and any(path.samefile(key_path) for path in apswiftly_path.rglob("*") if path.is_file()))
    ))
    if keys_in_data or (key_path and key_path.is_relative_to(backup_dir.resolve())):
        ok, message = False, "[ERROR] Upload keys must be stored separately from backed-up data directories"
    else:
        ok, message = _backup_directory(
            instance_dir / apswiftly_source,
            staging_subdir / apswiftly_dest,
            label="APSwiftly database (aoi.db)",
        )
    log_lines.append(message)
    print(message)
    if ok:
        backed_up.append(apswiftly_source)
        backup_sizes[apswiftly_source] = _directory_size(staging_subdir / apswiftly_dest)
    elif "[ERROR]" in message:
        errors += 1
    elif "[WARN]" in message:
        skipped.append(apswiftly_source)

    required_databases = {source_name for source_name, _ in SQLITE_DATABASES}
    required_complete = required_databases.issubset(backed_up)
    if errors == 0 and required_complete:
        try:
            verification = verify_backup(staging_subdir, keyring_path=storage_keyring)
            message = f"[SUCCESS] Restore verified ({verification['objects']} uploads, {verification['bytes']} bytes)"
        except Exception:
            errors += 1
            message = "[ERROR] Restore verification failed; check the separately protected upload keyring and database integrity"
        log_lines.append(message)
        print(message)
    published = errors == 0 and required_complete

    if published:
        staging_subdir.rename(backup_subdir)
        if skipped:
            summary = f"[WARNING] Backup created with optional data skipped: {backup_subdir}"
            color = "yellow"
        else:
            summary = f"[SUCCESS] Full backup created: {backup_subdir}"
            color = "green"
    else:
        shutil.rmtree(staging_subdir, ignore_errors=True)
        summary = f"[ERROR] Backup failed; incomplete snapshot discarded: {backup_subdir}"
        color = "red"

    log_lines.append(summary)
    print(summary)

    rotate_lines = _rotate_backups(backup_dir, max_backups) if published and not preserve_history else []
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
            "skipped": ", ".join(skipped) or "none",
            "apswiftly_included": "yes" if apswiftly_source in backed_up else "no",
            "errors": errors,
            "retention": max_backups,
            "total_sets": len(remaining),
        }
        for source_name, size in backup_sizes.items():
            metadata[f"{source_name}_size"] = _format_bytes(size)

        title = "Database Backup Created"
        if skipped:
            title = "Database Backup Created With Optional Data Skipped"
        if not published:
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

    return 0 if published else 1


def main(argv: list[str] | None = None) -> int:
    env_parser = argparse.ArgumentParser(add_help=False)
    env_parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env")
    environment_args, _ = env_parser.parse_known_args(argv)
    try:
        load_dotenv(environment_args.env_file)
    except OSError:
        print("[ERROR] Backup environment file is unreadable; grant the backup account minimum read access", file=sys.stderr)
        return 1
    configured = load_environment_config()
    parser = argparse.ArgumentParser(description="Back up Nest SQLite databases and APSwiftly aoi.db data.")
    parser.add_argument("--env-file", type=Path, default=environment_args.env_file)
    parser.add_argument("--instance-dir", type=Path, default=Path(nest_instance_dir()))
    parser.add_argument("--backup-dir", type=Path, default=Path(configured.nest_backup_dir))
    parser.add_argument("--max-backups", type=int, default=int(configured.nest_backup_retention_raw))
    parser.add_argument("--no-discord", action="store_true")
    parser.add_argument("--preserve-history", action="store_true", help="Do not rotate existing sets during a migration diagnostic.")
    parser.add_argument("--storage-keyring", type=Path, help="Separately protected keys for upload restore verification.")
    args = parser.parse_args(argv)

    return run_backup(
        instance_dir=args.instance_dir,
        backup_dir=args.backup_dir,
        max_backups=args.max_backups,
        notify_discord=not args.no_discord,
        preserve_history=args.preserve_history,
        storage_keyring=args.storage_keyring,
    )


if __name__ == "__main__":
    raise SystemExit(main())
