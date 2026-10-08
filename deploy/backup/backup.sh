#!/usr/bin/env bash
# Daily base backup (WAL segments are archived continuously by archive_command).
# Run inside the postgres container, e.g. from cron or a scheduled task:
#   docker compose exec postgres /backup/backup.sh
# Keeps 14 full backups and the WAL needed to restore to any point since the oldest.
set -euo pipefail
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set}"

wal-g backup-push "${PGDATA:-/var/lib/postgresql/data}"
wal-g delete retain FULL 14 --confirm

# Record success in the app's heartbeat table so the "backup is stale" alert can fire.
psql -v ON_ERROR_STOP=1 -c "INSERT INTO worker_heartbeats (job, last_ok_at) VALUES ('db_backup', now())
  ON CONFLICT (job) DO UPDATE SET last_ok_at = now()"
