#!/usr/bin/env python3
"""Verify a database backup using separately recovered upload keys; no notifications."""

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.storage_backup import verify_backup


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup_dir", type=Path)
    parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env",
                        help="Source identities and app URL; existing process settings take precedence.")
    parser.add_argument("--keyring", type=Path, required=True,
                        help="Protected keyring recovered independently of this backup.")
    parser.add_argument("--restore-dir", type=Path,
                        help="New disposable directory; omitted uses a private temporary directory.")
    args = parser.parse_args(argv)
    try:
        load_dotenv(args.env_file, override=False)
        result = verify_backup(args.backup_dir, keyring_path=args.keyring, restore_dir=args.restore_dir)
    except Exception as exc:
        print(f"{type(exc).__name__}: backup verification failed; no recovery bytes were published.", file=sys.stderr)
        return 1
    print(json.dumps({"verified": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
