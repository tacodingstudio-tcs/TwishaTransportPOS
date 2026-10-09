#!/usr/bin/env bash
# =============================================================================
# scripts/backup.sh
#
# Dumps the Postgres database, compresses it, and uploads it to Backblaze B2
# (or any S3-compatible storage — swap the upload command if using something
# else). Designed to run identically whether Postgres is in a local Docker
# container or a real server's native Postgres install.
#
# WHY THIS EXISTS:
#   Right now, docker-compose.yml stores all data in a named Docker volume.
#   `docker compose down -v`, a corrupted volume, a wiped server, or just
#   bad luck means a pilot customer's ENTIRE billing history — every
#   invoice, every payment, every customer balance — is gone permanently.
#   This script is the single most important reliability safeguard in the
#   whole platform: it costs nothing to run and prevents the one mistake
#   you cannot apologize your way out of.
#
# USAGE:
#   ./scripts/backup.sh                  — run once manually
#   ./scripts/backup.sh --local-only      — skip the B2 upload (just dump + compress)
#
# SCHEDULING:
#   See scripts/setup-backup-cron.sh — installs this to run nightly via cron.
# =============================================================================

set -euo pipefail  # exit immediately on any error, undefined variable, or pipe failure

# ── Configuration (override via environment variables) ──────────────────────
DB_CONTAINER="${DB_CONTAINER:-billing_postgres}"
DB_NAME="${DB_NAME:-billing_db}"
DB_USER="${DB_USER:-billing_app}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
B2_BUCKET="${B2_BUCKET:-}"               # set this to enable cloud upload
RETENTION_DAYS="${RETENTION_DAYS:-30}"   # how long to keep LOCAL backups
LOCAL_ONLY="${1:-}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="billing_db_${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"

mkdir -p "$BACKUP_DIR"

echo "[backup] Starting backup at $(date)"
echo "[backup] Target: ${BACKUP_PATH}"

# ── Step 1: Dump the database ────────────────────────────────────────────────
# pg_dump runs INSIDE the container if using Docker, or directly on the host
# if Postgres is natively installed (production VM scenario). Detect which.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DB_CONTAINER}$"; then
  echo "[backup] Using Docker container: ${DB_CONTAINER}"
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
    | gzip > "$BACKUP_PATH"
else
  echo "[backup] No matching Docker container found — using native pg_dump"
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip > "$BACKUP_PATH"
fi

# ── Step 2: Verify the dump isn't empty or corrupted ─────────────────────────
# A zero-byte or truncated backup is worse than no backup — it gives false
# confidence. Fail loudly here rather than silently uploading garbage.
BACKUP_SIZE=$(stat -f%z "$BACKUP_PATH" 2>/dev/null || stat -c%s "$BACKUP_PATH" 2>/dev/null)
if [ "$BACKUP_SIZE" -lt 1000 ]; then
  echo "[backup] ERROR: backup file is suspiciously small (${BACKUP_SIZE} bytes)."
  echo "[backup] This likely means pg_dump failed silently. Aborting — NOT uploading."
  rm -f "$BACKUP_PATH"
  exit 1
fi

# Verify the gzip archive itself isn't corrupted (catches truncated writes,
# disk-full mid-write, etc.) before trusting this file as a real backup.
if ! gzip -t "$BACKUP_PATH" 2>/dev/null; then
  echo "[backup] ERROR: backup file failed gzip integrity check. Aborting."
  exit 1
fi

echo "[backup] Dump successful: $(du -h "$BACKUP_PATH" | cut -f1)"

# ── Step 3: Upload to Backblaze B2 (skip if --local-only or B2_BUCKET unset) ─
if [ "$LOCAL_ONLY" != "--local-only" ] && [ -n "$B2_BUCKET" ]; then
  if command -v b2 &> /dev/null; then
    echo "[backup] Uploading to B2 bucket: ${B2_BUCKET}"
    b2 upload-file "$B2_BUCKET" "$BACKUP_PATH" "postgres/${BACKUP_FILE}"
    echo "[backup] Upload complete"
  else
    echo "[backup] WARNING: b2 CLI not installed — skipping cloud upload."
    echo "[backup] Install with: pip install b2 (or brew install b2-tools)"
    echo "[backup] Backup is still saved LOCALLY at ${BACKUP_PATH}"
  fi
else
  echo "[backup] Skipping cloud upload (--local-only or B2_BUCKET not configured)"
fi

# ── Step 4: Clean up old LOCAL backups beyond retention window ──────────────
# Cloud copies are retained separately per your B2 bucket lifecycle rules —
# this only prunes local disk to avoid filling up the server over time.
echo "[backup] Pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name "billing_db_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] Done at $(date)"
echo "[backup] ============================================="
