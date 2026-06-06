#!/usr/bin/env bash
# Backs up the Actual Budget data volume to ~/backups, keeps 8 weeks of history.
set -euo pipefail

BACKUP_DIR="$HOME/backups"
mkdir -p "$BACKUP_DIR"

docker run --rm \
  -v budget-bot_actual-data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/actual-$(date +%F).tar.gz" -C / data

# retention: delete backups older than 56 days
find "$BACKUP_DIR" -name 'actual-*.tar.gz' -mtime +56 -delete

echo "backup done: $(ls -lh "$BACKUP_DIR" | tail -1)"
