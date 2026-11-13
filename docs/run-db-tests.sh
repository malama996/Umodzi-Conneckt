#!/usr/bin/env bash
# ============================================================================
# Umodzi Connect — one-shot database test run
#
# Creates a disposable local database, applies migrations 001-012, seeds the
# nine technician prototypes and the administrator, verifies PostGIS and the
# schema, starts the API, runs every database-backed test script, and writes
# docs/test-results.csv.
#
# The live Supabase database is never touched: this only ever connects to
# localhost, and it refuses to run against a non-local host.
#
# Requires: PGPASSWORD (the local postgres superuser password) in the env.
# Usage:    PGPASSWORD='...' bash docs/run-db-tests.sh
# ============================================================================
set -uo pipefail

PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"
DB_NAME="${DB_NAME:-umodzi_test}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
API_URL="http://localhost:3001"
# Absolute: the script cd's into backend/ before the loop, so relative paths break.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_CSV="$ROOT_DIR/docs/test-results.csv"
LOG_DIR="$ROOT_DIR/docs/test-logs"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${PGPASSWORD:-}" ] || fail "PGPASSWORD is not set (local postgres password)."
[ "$PGHOST" = "localhost" ] || [ "$PGHOST" = "127.0.0.1" ] || fail "refusing to run against non-local host: $PGHOST"
[ -x "$PSQL" ] || fail "psql not found at $PSQL"

PSQL_RUN=("$PSQL" -U "$PGUSER" -h "$PGHOST" -p "$PGPORT" -v ON_ERROR_STOP=1)

# Kill the API *and its children*. `kill $API_PID` only stops npm; the
# `tsx watch src/server.ts` child survives, keeps a pool connection open, and the
# next run dies at step 1 with "database is being accessed by other users".
stop_api() {
  [ -n "${API_PID:-}" ] || return 0
  taskkill //PID "$API_PID" //F //T >/dev/null 2>&1 || kill "$API_PID" 2>/dev/null
  API_PID=""
}

echo "=== 1/7 create disposable database: $DB_NAME ==="
# WITH (FORCE) terminates any session still holding the database, so a stray
# runner from an earlier attempt cannot block this one.
"${PSQL_RUN[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;" \
  || fail "could not create $DB_NAME (wrong password, or another session is connected)"

echo "=== 2/7 apply migrations 001-012 ==="
ENC_PW="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PGPASSWORD")"
DB_URL="postgresql://$PGUSER:$ENC_PW@$PGHOST:$PGPORT/$DB_NAME"
TEST_ADMIN_EMAIL="${TEST_ADMIN_EMAIL:-admin@umodzi.test}"
TEST_ADMIN_PASSWORD="${TEST_ADMIN_PASSWORD:-LocalTestAdmin2026!}"

DATABASE_URL="$DB_URL" MIGRATIONS_DATABASE_URL="$DB_URL" \
  npm run migrate -w backend || fail "migrations failed"

echo "=== 2b/7 seed the demo baseline (9 technician prototypes + administrator) ==="
# Without this the suites assert against a baseline the database does not have
# ("technicians back to the 9 seed prototypes") and abort at their first check.
DATABASE_URL="$DB_URL" ADMIN_EMAIL="$TEST_ADMIN_EMAIL" ADMIN_PASSWORD="$TEST_ADMIN_PASSWORD" \
  npm run seed -w backend || fail "seed failed"

echo "=== 3/7 verify PostGIS and schema ==="
"${PSQL_RUN[@]}" -d "$DB_NAME" -tAc "SELECT postgis_version();" || fail "PostGIS missing"
TABLES="$("${PSQL_RUN[@]}" -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
POLICIES="$("${PSQL_RUN[@]}" -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_policies;")"
GUARD="$("${PSQL_RUN[@]}" -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_indexes WHERE indexdef ILIKE '%accepted%';")"
echo "    tables=$TABLES policies=$POLICIES accepted-index=$GUARD"

# ---- shared environment for BOTH the API and every test script ------------
# The suites refuse to run without DATABASE_URL + ADMIN_EMAIL (+PASSWORD) and
# print "never Supabase" when it is missing. backend/.env does NOT contain
# DATABASE_URL, so without these exports every suite aborts at its guard.
export DATABASE_URL="$DB_URL" MIGRATIONS_DATABASE_URL="$DB_URL"
export STORAGE_PROVIDER=local STORAGE_DIR=var/uploads
export NODE_ENV=development JWT_SECRET="local-test-secret-not-a-real-credential-32chars"
export ADMIN_EMAIL="$TEST_ADMIN_EMAIL" ADMIN_PASSWORD="$TEST_ADMIN_PASSWORD"
export FRONTEND_ORIGIN="http://localhost:3000" API_BASE="$API_URL/api/v1"

echo "=== 4/7 start API ==="
mkdir -p "$LOG_DIR"
# The exports above are what make the API boot: backend/.env still says
# STORAGE_PROVIDER=supabase with a retired key, and dotenv never overrides a
# variable that is already in the environment.
PORT=3001 npm run dev -w backend > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!
trap 'stop_api' EXIT

READY=0
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w '' "$API_URL/health" 2>/dev/null; then READY=1; break; fi
  sleep 2
done
[ "$READY" = "1" ] || { tail -30 "$LOG_DIR/api.log"; fail "API did not become ready"; }
echo "    API ready (pid $API_PID)"

echo "=== 5/7 run database-backed scripts ==="
echo 'script,passed,failed,exit,result' > "$OUT_CSV"
cd "$ROOT_DIR/backend" || fail "backend/ missing"
TOTAL_P=0; TOTAL_F=0; RUN=0; NONZERO=0

for f in scripts/*.ts; do
  name="$(basename "$f")"
  # Skip non-test utilities and the scripts already executed without a database.
  case "$name" in
    task352-retire-service-key.ts|storage-tests.ts|task23-tests.ts|task33-classify-tests.ts) continue ;;
  esac
  # Per-script timeout: one hanging script must not stall the whole sweep.
  out="$(timeout 240 npx --no-install tsx "$f" 2>&1 </dev/null)"
  code=$?
  p="$(printf '%s\n' "$out" | sed -nE 's/^([0-9]+) passed.*/\1/p' | tail -1)"
  fl="$(printf '%s\n' "$out" | sed -nE 's/.* ([0-9]+) failed.*/\1/p' | tail -1)"
  [ -z "$p" ] && p=0
  [ -z "$fl" ] && fl=0
  result="$(printf '%s\n' "$out" | tail -1 | tr ',' ' ')"
  TOTAL_P=$((TOTAL_P+p)); TOTAL_F=$((TOTAL_F+fl)); RUN=$((RUN+1))
  [ "$code" -ne 0 ] && NONZERO=$((NONZERO+1))
  printf '%s\n' "$out" > "$LOG_DIR/${name%.ts}.log"
  echo "$name,$p,$fl,$code,\"$result\"" >> "$OUT_CSV"
  printf '  %-42s passed=%-4s failed=%-3s exit=%s\n' "$name" "$p" "$fl" "$code"
done
cd "$ROOT_DIR"

echo "=== 6/7 stop API and its children ==="
stop_api; trap - EXIT
sleep 2
echo "    sessions left on $DB_NAME: $("${PSQL_RUN[@]}" -d postgres -tAc "select count(*) from pg_stat_activity where datname='$DB_NAME';")"

echo "=== 7/7 summary ==="
echo "  scripts run : $RUN"
echo "  passed      : $TOTAL_P"
echo "  failed      : $TOTAL_F"
echo "  non-zero    : $NONZERO"
echo "  csv         : $OUT_CSV"
echo "  logs        : $LOG_DIR/"
[ "$TOTAL_F" -eq 0 ] && [ "$NONZERO" -eq 0 ] \
  && echo "  STATUS: ALL GREEN" \
  || echo "  STATUS: FAILURES PRESENT — inspect the logs above"
