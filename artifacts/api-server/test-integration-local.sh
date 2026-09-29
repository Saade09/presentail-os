#!/usr/bin/env bash
# Run the API-server integration tests against a throwaway local PostgreSQL
# instance. No external database setup required.
#
# Usage (from anywhere in the repo):
#   pnpm --filter @workspace/api-server run test:integration:local
#   # or directly:
#   bash artifacts/api-server/test-integration-local.sh

set -euo pipefail

# ── configuration ─────────────────────────────────────────────────────────────
PG_USER=postgres
PG_DB=testdb
PG_DB_INITDB_CHECK=testdb_initdb_check
PG_DATADIR="$(mktemp -d /tmp/pg-integration-XXXXXX)"
SOCKET_DIR="${PG_DATADIR}/socket"

# Pick a free port dynamically so concurrent runs and leftover processes don't
# collide.  Fall back to 5433 only if Python is unavailable, but then verify
# the port is actually free before proceeding.
if command -v python3 &>/dev/null; then
  PG_PORT=$(python3 -c \
    "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")
else
  PG_PORT=5433
fi

# Verify the chosen port is not already in use.
if command -v ss &>/dev/null; then
  _in_use=$(ss -tln "sport = :${PG_PORT}" 2>/dev/null | grep -c "LISTEN" || true)
elif command -v lsof &>/dev/null; then
  _in_use=$(lsof -iTCP:"${PG_PORT}" -sTCP:LISTEN -t 2>/dev/null | wc -l || true)
else
  _in_use=0
fi

if [ "${_in_use}" -gt 0 ]; then
  echo "ERROR: port ${PG_PORT} is already in use." >&2
  echo "  Kill the process holding the port, or let another run finish, then retry." >&2
  exit 1
fi

export DATABASE_URL="postgres://${PG_USER}@localhost:${PG_PORT}/${PG_DB}"
export INITDB_CHECK_DATABASE_URL="postgres://${PG_USER}@localhost:${PG_PORT}/${PG_DB_INITDB_CHECK}"

# ── cleanup on exit (success or failure) ──────────────────────────────────────
cleanup() {
  local exit_code=$?
  echo ""
  echo "→ Stopping PostgreSQL…"
  pg_ctl stop -D "${PG_DATADIR}" -m fast -s 2>/dev/null || true
  rm -rf "${PG_DATADIR}"
  echo "→ Cleanup complete."
  exit "${exit_code}"
}
trap cleanup EXIT

# ── locate repo root ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── initialise a fresh PostgreSQL cluster ─────────────────────────────────────
echo "→ Initialising PostgreSQL data directory…"
initdb \
  -D "${PG_DATADIR}" \
  --username="${PG_USER}" \
  --auth=trust \
  --no-instructions \
  > /dev/null

mkdir -p "${SOCKET_DIR}"

echo "→ Starting PostgreSQL on port ${PG_PORT}…"
pg_ctl start \
  -D "${PG_DATADIR}" \
  -s \
  -l "${PG_DATADIR}/postgres.log" \
  -o "-p ${PG_PORT} -k ${SOCKET_DIR}" \
  -w

echo "→ Waiting for PostgreSQL to accept connections…"
_pg_ready=0
for _attempt in $(seq 1 10); do
  if pg_isready -h localhost -p "${PG_PORT}" -U "${PG_USER}" -q 2>/dev/null; then
    _pg_ready=1
    break
  fi
  sleep 0.5
done
if [ "${_pg_ready}" -eq 0 ]; then
  echo "ERROR: PostgreSQL on port ${PG_PORT} did not accept connections after 10 attempts (5 s)." >&2
  exit 1
fi

echo "→ Creating database '${PG_DB}'…"
createdb -h localhost -p "${PG_PORT}" -U "${PG_USER}" "${PG_DB}"

# pg_trgm is required by GIN trigram index definitions in the Drizzle schema
# (idx_products_*_trgm). Must be installed before drizzle-kit push runs.
echo "→ Enabling pg_trgm extension…"
psql -h localhost -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" > /dev/null

# ── apply schema ──────────────────────────────────────────────────────────────
echo "→ Pushing Drizzle schema…"
(cd "${REPO_ROOT}" && DATABASE_URL="${DATABASE_URL}" pnpm --filter @workspace/db run push-force)

# ── boot initDb-only database ─────────────────────────────────────────────────
# Create a second fresh database and run initDb against it — no Drizzle push.
# This lets initDb.schema.integration.test.ts verify that every Drizzle schema
# table is also created by initDb on a completely fresh deployment.
echo "→ Creating initDb-check database '${PG_DB_INITDB_CHECK}'…"
createdb -h localhost -p "${PG_PORT}" -U "${PG_USER}" "${PG_DB_INITDB_CHECK}"

echo "→ Running initDb against '${PG_DB_INITDB_CHECK}' (no Drizzle push)…"
(
  cd "${REPO_ROOT}"
  DATABASE_URL="${INITDB_CHECK_DATABASE_URL}" \
    pnpm --filter @workspace/api-server exec tsx \
      ./src/scripts/run-initdb.ts
)

# ── run integration tests ─────────────────────────────────────────────────────
echo "→ Running integration tests…"
(cd "${REPO_ROOT}" && DATABASE_URL="${DATABASE_URL}" INITDB_CHECK_DATABASE_URL="${INITDB_CHECK_DATABASE_URL}" pnpm --filter @workspace/api-server run test:integration "$@")
