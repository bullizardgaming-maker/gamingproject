#!/usr/bin/env bash
# Restore drill: prove the backups actually restore. Run weekly from CI or a scheduler.
#
#   WALG_S3_PREFIX=... AWS_...=... PRIMARY_DATABASE_URL=postgres://... ./restore-drill.sh [recovery target time]
#
# 1. fetches the latest base backup into a scratch data directory
# 2. starts a throwaway Postgres that replays WAL up to the target (default: end of archive)
# 3. runs the integrity checks (migrations, append-only guards, ledger balance, escrow vs orders,
#    chat sequence numbers and hash chains) against it
# 4. on success records a `restore_drill` heartbeat on the primary; always tears the copy down
# It also prints how long the restore took: that is your real recovery time.
set -euo pipefail
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set}"
TARGET_TIME="${1:-}"
WORK="$(mktemp -d)"
NAME="bullizard-restore-drill-$$"
PORT="${DRILL_PORT:-55432}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker image inspect bullizard-postgres >/dev/null 2>&1 || docker build -t bullizard-postgres "$(dirname "$0")/../postgres"

started=$(date +%s)
docker run --rm -v "$WORK:/restore" --env-file <(env | grep -E '^(WALG_|AWS_)') \
  --entrypoint /bin/sh bullizard-postgres -c '
    wal-g backup-fetch /restore/data LATEST &&
    touch /restore/data/recovery.signal &&
    echo "restore_command = '"'"'wal-g wal-fetch %f %p'"'"'" >> /restore/data/postgresql.auto.conf &&
    echo "archive_mode = off" >> /restore/data/postgresql.auto.conf &&
    chown -R postgres:postgres /restore/data && chmod 700 /restore/data'
if [ -n "$TARGET_TIME" ]; then
  echo "recovery_target_time = '$TARGET_TIME'" >> "$WORK/data/postgresql.auto.conf"
  echo "recovery_target_action = 'promote'" >> "$WORK/data/postgresql.auto.conf"
fi

docker run -d --name "$NAME" -p "$PORT:5432" -v "$WORK/data:/var/lib/postgresql/data" \
  --env-file <(env | grep -E '^(WALG_|AWS_)') bullizard-postgres >/dev/null
for _ in $(seq 1 600); do
  if docker exec "$NAME" psql -U market -d market -tAc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null | grep -q t; then break; fi
  sleep 2
done
restored=$(date +%s)
echo "Restore + WAL replay took $((restored - started))s"

cd "$(dirname "$0")/../../apps/api"
DATABASE_URL="postgres://market:market@localhost:$PORT/market" PRIMARY_DATABASE_URL="${PRIMARY_DATABASE_URL:-}" npx tsx scripts/verify-restore.ts
