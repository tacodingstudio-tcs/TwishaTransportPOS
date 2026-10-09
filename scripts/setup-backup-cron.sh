#!/usr/bin/env bash
# =============================================================================
# scripts/setup-backup-cron.sh
#
# Installs a nightly cron job that runs backup.sh automatically. Run this
# ONCE on whatever machine hosts your database (your dev machine for local
# testing, or your production server once deployed).
#
# Schedule: 2:00 AM IST daily — chosen to run after the day's billing
# activity ends and before the next business day starts, minimizing both
# load on the database during the dump and risk of catching mid-transaction
# data (pg_dump is transaction-consistent regardless, but quieter hours
# mean a faster, smaller dump).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup.sh"
LOG_FILE="${SCRIPT_DIR}/../backups/backup.log"

if [ ! -f "$BACKUP_SCRIPT" ]; then
  echo "ERROR: backup.sh not found at ${BACKUP_SCRIPT}"
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

# 2:00 AM IST = 20:30 UTC (previous day) — adjust if your server runs in a
# different timezone. Check with: timedatectl (Linux) or date (any system).
CRON_LINE="30 20 * * * cd ${SCRIPT_DIR}/.. && ${BACKUP_SCRIPT} >> ${LOG_FILE} 2>&1"

# Avoid adding a duplicate entry if this script is run more than once
EXISTING=$(crontab -l 2>/dev/null | grep -F "$BACKUP_SCRIPT" || true)

if [ -n "$EXISTING" ]; then
  echo "[setup] A backup cron entry already exists:"
  echo "  $EXISTING"
  echo "[setup] Skipping — remove it manually with 'crontab -e' first if you want to replace it."
  exit 0
fi

(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

echo "[setup] Cron job installed:"
echo "  $CRON_LINE"
echo ""
echo "[setup] Verify with: crontab -l"
echo "[setup] Logs will appear in: ${LOG_FILE}"
echo ""
echo "[setup] To set up cloud upload, export these before backups run:"
echo "  export B2_BUCKET=your-bucket-name"
echo "  (add to ~/.bashrc or /etc/environment so cron picks it up)"
echo ""
echo "[setup] IMPORTANT: cron runs with a minimal environment — environment"
echo "[setup] variables in your shell profile are NOT automatically available"
echo "[setup] to cron jobs. Either hardcode B2_BUCKET in backup.sh, or add"
echo "[setup] 'source /etc/environment' / explicit exports at the top of the"
echo "[setup] cron line itself."
