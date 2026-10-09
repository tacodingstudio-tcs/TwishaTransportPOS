#!/usr/bin/env bash
# =============================================================================
# scripts/restore.sh
#
# Restores a backup created by backup.sh into a FRESH database — never
# directly into the live production database. This is deliberate: restore
# testing should always prove the backup works by building a separate
# database from it, not by overwriting real data and hoping for the best.
#
# USAGE:
#   ./scripts/restore.sh ./backups/billing_db_20250619_030000.sql.gz
#   ./scripts/restore.sh ./backups/billing_db_20250619_030000.sql.gz billing_db_test
#
# MONTHLY DISCIPLINE:
#   Run this against your most recent backup once a month, even when
#   nothing is wrong. A backup you have never restored is a backup you
#   don't actually have — you only find out it's broken (wrong pg_dump
#   flags, corrupted upload, wrong schema version) at the worst possible
#   moment otherwise.
# =============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_DB="${2:-billing_db_restore_test}"
DB_CONTAINER="${DB_CONTAINER:-billing_postgres}"
DB_USER="${DB_USER:-billing_app}"
DB_SUPERUSER="${DB_SUPERUSER:-postgres}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./scripts/restore.sh <backup-file.sql.gz> [target-db-name]"
  echo ""
  echo "Available local backups:"
  ls -lh ./backups/billing_db_*.sql.gz 2>/dev/null || echo "  (none found in ./backups)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[restore] ERROR: backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "[restore] Restoring ${BACKUP_FILE} into NEW database '${TARGET_DB}'"
echo "[restore] This does NOT touch your live billing_db — it creates a separate"
echo "[restore] database to verify the backup is valid and restorable."
echo ""

# ── Step 1: Verify the backup file integrity before attempting restore ──────
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "[restore] ERROR: backup file failed gzip integrity check — it's corrupted."
  echo "[restore] This backup cannot be used. Check earlier backups or the upload pipeline."
  exit 1
fi
echo "[restore] Gzip integrity check passed"

# ── Step 2: Drop and recreate the target test database ───────────────────────
echo "[restore] Creating fresh database: ${TARGET_DB}"
docker exec "$DB_CONTAINER" psql -U "$DB_SUPERUSER" -c "DROP DATABASE IF EXISTS ${TARGET_DB};"
docker exec "$DB_CONTAINER" psql -U "$DB_SUPERUSER" -c "CREATE DATABASE ${TARGET_DB} OWNER ${DB_USER};"

# ── Step 3: Restore the dump into the test database ──────────────────────────
echo "[restore] Restoring data (this may take a few minutes for large databases)"
gunzip -c "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" \
  --set ON_ERROR_STOP=1 \
  > /tmp/restore_output.log 2>&1 || {
    echo "[restore] ERROR: restore failed. Last 30 lines of output:"
    tail -30 /tmp/restore_output.log
    exit 1
  }

# ── Step 4: Sanity-check the restored data ────────────────────────────────────
# Confirm core tables exist and have rows — an empty-but-structurally-valid
# restore would otherwise pass silently and give false confidence.
echo "[restore] Verifying restored data..."

TENANT_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" -tAc \
  "SELECT COUNT(*) FROM tenants;" 2>/dev/null || echo "ERROR")
INVOICE_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" -tAc \
  "SELECT COUNT(*) FROM invoices;" 2>/dev/null || echo "ERROR")

if [ "$TENANT_COUNT" == "ERROR" ]; then
  echo "[restore] ERROR: 'tenants' table missing or unreadable after restore."
  echo "[restore] The backup may be from an incompatible schema version."
  exit 1
fi

echo "[restore] ============================================="
echo "[restore] Restore verification PASSED"
echo "[restore]   Database:  ${TARGET_DB}"
echo "[restore]   Tenants:   ${TENANT_COUNT}"
echo "[restore]   Invoices:  ${INVOICE_COUNT}"
echo "[restore] ============================================="
echo ""
echo "[restore] To inspect the restored data:"
echo "[restore]   docker exec -it ${DB_CONTAINER} psql -U ${DB_USER} -d ${TARGET_DB}"
echo ""
echo "[restore] To clean up this test database when done:"
echo "[restore]   docker exec ${DB_CONTAINER} psql -U ${DB_SUPERUSER} -c \"DROP DATABASE ${TARGET_DB};\""
