#!/bin/sh
#
# Apply pending SQL migrations exactly once, then provision the two
# application logins from deployment secrets. The migration ledger also
# allows existing pre-ledger installations to advance beyond migration 030.
#
set -eu

: "${SYNC_APP_PASSWORD:?SYNC_APP_PASSWORD is required}"
: "${DEVICE_ENROLLMENT_PASSWORD:?DEVICE_ENROLLMENT_PASSWORD is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

DB_HOST=db
DB_NAME=sync_engine
DB_USER=postgres

psql_base() {
  psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" "$@"
}

echo "[migrate] checking schema and migration ledger"
ledger_before=$(psql_base -tA -c "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 0 ELSE 1 END")
legacy_schema=$(psql_base -tA -c "SELECT CASE WHEN to_regclass('public.check_ins') IS NULL THEN 0 ELSE 1 END")

psql_base -c "
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )
" > /dev/null

if [ "$ledger_before" = "0" ] && [ "$legacy_schema" = "1" ]; then
  echo "[migrate] legacy pre-ledger database detected; verifying migration-030 baseline"
  baseline_ok=$(psql_base -tA -c "
    SELECT CASE
      WHEN to_regclass('public.devices') IS NOT NULL
       AND to_regclass('public.device_pairing_codes') IS NOT NULL
       AND to_regclass('public.device_credentials') IS NULL
      THEN 1 ELSE 0 END
  ")
  if [ "$baseline_ok" != "1" ]; then
    echo "[migrate] ERROR: legacy schema is not at the expected pre-031 baseline."
    echo "[migrate] Refusing to guess which non-idempotent migrations have already run."
    exit 1
  fi

  for f in /migrations/*.sql; do
    name=$(basename "$f")
    version=$(printf '%s' "$name" | cut -d_ -f1)
    version_number=$(printf '%s' "$version" | sed 's/^0*//')
    [ -n "$version_number" ] || version_number=0
    if [ "$version_number" -le 30 ]; then
      psql_base -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name') ON CONFLICT (filename) DO NOTHING" > /dev/null
    fi
  done
  echo "[migrate] baseline 001-030 recorded"
fi

echo "[migrate] applying pending migrations"
for f in /migrations/*.sql; do
  name=$(basename "$f")
  applied=$(psql_base -tA -v filename="$name" -c "SELECT 1 FROM public.schema_migrations WHERE filename = :'filename' LIMIT 1")
  if [ "$applied" = "1" ]; then
    echo "[migrate]   already applied: $name"
    continue
  fi

  echo "[migrate]   applying: $name"
  psql_base -f "$f" > /dev/null
  psql_base -c "INSERT INTO public.schema_migrations (filename) VALUES ('$name')" > /dev/null
done

echo "[migrate] restricting migration ledger and enabling application login"
psql_base <<'EOSQL'
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, sync_app;
EOSQL
psql_base -v pw="$SYNC_APP_PASSWORD" <<'EOSQL'
ALTER ROLE sync_app LOGIN INHERIT PASSWORD :'pw';
ALTER ROLE sync_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE sync_engine TO sync_app;
EOSQL

echo "[migrate] provisioning isolated enrollment login"
enrollment_role_exists=$(psql_base -tA -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login') THEN 1 ELSE 0 END")
if [ "$enrollment_role_exists" = "1" ]; then
  psql_base -v pw="$DEVICE_ENROLLMENT_PASSWORD" <<'EOSQL'
ALTER ROLE device_enrollment_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
else
  psql_base -v pw="$DEVICE_ENROLLMENT_PASSWORD" <<'EOSQL'
CREATE ROLE device_enrollment_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
fi

psql_base <<'EOSQL'
REVOKE sync_app FROM device_enrollment_login;
GRANT device_enrollment_executor TO device_enrollment_login;
GRANT CONNECT ON DATABASE sync_engine TO device_enrollment_login;
EOSQL

echo "[migrate] verifying login separation"
separation_ok=$(psql_base -tA -c "
  SELECT CASE
    WHEN NOT pg_catalog.pg_has_role('device_enrollment_login', 'sync_app', 'MEMBER')
     AND pg_catalog.pg_has_role('device_enrollment_login', 'device_enrollment_executor', 'USAGE')
     AND pg_catalog.has_function_privilege(
       'device_enrollment_login',
       'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
       'EXECUTE'
     )
     AND NOT pg_catalog.has_function_privilege(
       'sync_app',
       'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
       'EXECUTE'
     )
    THEN 1 ELSE 0 END
")
if [ "$separation_ok" != "1" ]; then
  echo "[migrate] ERROR: PostgreSQL enrollment privilege boundary verification failed."
  exit 1
fi

echo "[migrate] done"
