#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/nest.apstudy.org"
LOCK_FILE="$APP_DIR/instance/.backup-nest-db.lock"

cd "$APP_DIR"
source "$APP_DIR/.venv/bin/activate"
export FLASK_ENV="${FLASK_ENV:-production}"

exec 9>"$LOCK_FILE"
if ! flock --nonblock 9; then
    echo "[ERROR] Backup skipped because another backup process holds $LOCK_FILE"
    exit 1
fi

exec python "$APP_DIR/scripts/backup_nest_db.py"
