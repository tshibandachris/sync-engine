#!/bin/sh
#
# Apply every migration in /migrations in sorted order, then enable the
# sync_app role with the password from the environment.
#
# Idempotent by design: on the second run, the presence of check_ins
# short-circuits the script. Migrations themselves are NOT idempotent
# (013 adds a column, 014 creates a table), so re-applying them would
# fail. The marker table doubles as a sanity check that a first run
# completed successfully: if check_ins exists, the first run made it
# past migration 001.
#
# Exits 0 on success, non-zero on any psql error.

set -eu

: "${SYNC_APP_PASSWORD:?SYNC_APP_PASSWORD is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

DB_HOST=db
DB_NAME=sync_engine
DB_USER=postgres

echo "[migrate] checking schema state"
already=$(psql -tA -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'check_ins'
" || true)

if [ "$already" = "1" ]; then
  echo "[migrate] schema already initialised, nothing to do"
  exit 0
fi

echo "[migrate] first run, applying migrations"
for f in $(ls /migrations/*.sql | sort); do
  echo "[migrate]   $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$f" > /dev/null
done

echo "[migrate] enabling sync_app for the application"
psql -v ON_ERROR_STOP=1 -v pw="$SYNC_APP_PASSWORD" -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<'EOSQL'
ALTER ROLE sync_app LOGIN PASSWORD :'pw';
ALTER ROLE sync_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE sync_engine TO sync_app;
EOSQL

echo "[migrate] done"
