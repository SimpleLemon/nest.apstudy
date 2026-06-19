#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/nest.apstudy.org"
LOG_FILE="/home/deployer/backup-nest-db.log"

cd "$APP_DIR"
source "$APP_DIR/.venv/bin/activate"
export FLASK_ENV="${FLASK_ENV:-production}"

python "$APP_DIR/scripts/backup_nest_db.py" >> "$LOG_FILE" 2>&1
