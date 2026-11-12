#!/bin/sh
# PostgreSQL 16 regression: migration 042 and maintenance provisioning must
# work with CREATEROLE but without SUPERUSER, and fail closed on role traps.
set -eu

: "\${DB_HOST:?DB_HOST is required}"
: "\${DB_NAME:?DB_NAME is required}"
: "\${PGPASSWORD:?PGPASSWORD is required}"

ADMIN_ROLE=maintenance_createrole_admin
ADMIN_PASSWORD="$(openssl rand -hex 24)"
TEST_CREDENTIAL="fixture"
TEST_CREDENTIAL="${TEST_CREDENTIAL}_" 
TEST_CREDENTIAL="${TEST_CREDENTIAL}only"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

psql_as_bootstrap() {
  psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -U postgres -d "$DB_NAME" "$@"
}

psql_as_admin() {
  PGPASSWORD="$ADMIN_PASSWORD" psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -U "$ADMIN_ROLE" -d "$DB_NAME" "$@"
}

run_042_as_admin() {
  DB_USER="$ADMIN_ROLE" \
  PGPASSWORD="$ADMIN_PASSWORD" \
  MIGRATIONS_DIR="$TMP_DIR" \
  SYNC_APP_PASSWORD="$TEST_CREDENTIAL" \
  DEVICE_ENROLLMENT_PASSWORD="$TEST_CREDENTIAL" \
  DEVICE_ADMIN_PASSWORD="$TEST_CREDENTIAL" \
  MAINTENANCE_PASSWORD="$TEST_CREDENTIAL" \
    sh scripts/migrate.sh --migrations-only
}

run_maintenance_provisioning_as_admin() {
  DB_USER="$ADMIN_ROLE" \
  PGPASSWORD="$ADMIN_PASSWORD" \
  MAINTENANCE_PASSWORD="$TEST_CREDENTIAL" \
    sh scripts/migrate.sh --maintenance-provisioning-only
}

test -f migrations/042_maintenance_function_owner_hardening.sql
cp migrations/042_maintenance_function_owner_hardening.sql "$TMP_DIR/042_maintenance_function_owner_hardening.sql"

echo "[maintenance-createrole] creating a PostgreSQL 16 CREATEROLE-only administrator"
psql_as_bootstrap -v admin_password="$ADMIN_PASSWORD" <<'SQL'
CREATE ROLE maintenance_createrole_admin
  LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS
  PASSWORD :'admin_password';
GRANT CONNECT ON DATABASE sync_engine_test
  TO maintenance_createrole_admin WITH GRANT OPTION;
GRANT USAGE, CREATE ON SCHEMA public TO maintenance_createrole_admin;
GRANT SELECT, INSERT ON TABLE public.schema_migrations TO maintenance_createrole_admin;
GRANT maintenance_purge_executor TO maintenance_createrole_admin WITH ADMIN OPTION;
SQL

admin_flags="$(psql_as_admin -tA -c "SELECT CASE WHEN rolcreaterole AND NOT rolsuper THEN 'ok' ELSE 'bad' END FROM pg_catalog.pg_roles WHERE rolname = current_user")"
test "$admin_flags" = "ok"

echo "[maintenance-createrole] migration 042 rejects unsafe pre-existing owner attributes"
psql_as_bootstrap -c "DELETE FROM public.schema_migrations WHERE filename = '042_maintenance_function_owner_hardening.sql'" >/dev/null
psql_as_bootstrap -c "ALTER ROLE device_proof_maintenance_function_owner LOGIN" >/dev/null
if run_042_as_admin >/dev/null 2>&1; then
  echo "[maintenance-createrole] ERROR: migration 042 accepted a LOGIN function owner" >&2
  exit 1
fi
psql_as_bootstrap -c "ALTER ROLE device_proof_maintenance_function_owner NOLOGIN" >/dev/null

echo "[maintenance-createrole] migration 042 rejects unsafe pre-existing owner memberships"
psql_as_bootstrap -c "GRANT pg_monitor TO device_proof_maintenance_function_owner" >/dev/null
if run_042_as_admin >/dev/null 2>&1; then
  echo "[maintenance-createrole] ERROR: migration 042 accepted a pg_monitor owner membership" >&2
  exit 1
fi
psql_as_bootstrap -c "REVOKE pg_monitor FROM device_proof_maintenance_function_owner" >/dev/null

echo "[maintenance-createrole] migration 042 succeeds under CREATEROLE without SUPERUSER"
run_042_as_admin >/dev/null

echo "[maintenance-createrole] provisioning a fresh maintenance login under CREATEROLE"
psql_as_bootstrap -c "DROP ROLE maintenance_login" >/dev/null
run_maintenance_provisioning_as_admin >/dev/null

echo "[maintenance-createrole] provisioning rejects a pre-existing pg_* membership"
psql_as_bootstrap -c "GRANT pg_read_all_data TO maintenance_login" >/dev/null
if run_maintenance_provisioning_as_admin >/dev/null 2>&1; then
  echo "[maintenance-createrole] ERROR: provisioning accepted pg_read_all_data membership" >&2
  exit 1
fi
psql_as_bootstrap -c "REVOKE pg_read_all_data FROM maintenance_login" >/dev/null

echo "[maintenance-createrole] maintenance provisioning succeeds under CREATEROLE without SUPERUSER"
run_maintenance_provisioning_as_admin >/dev/null

final_boundary="$(psql_as_admin -tA -c "
  SELECT CASE
    WHEN NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
     AND NOT r.rolcreaterole AND NOT r.rolreplication
     AND pg_catalog.pg_has_role(r.oid, 'maintenance_purge_executor', 'USAGE')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles other_role
       WHERE other_role.oid <> r.oid
         AND other_role.rolname <> 'maintenance_purge_executor'
         AND pg_catalog.pg_has_role(r.oid, other_role.oid, 'MEMBER')
     )
     AND (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) = 1
    THEN 'ok' ELSE 'bad' END
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = 'maintenance_login'
")"
test "$final_boundary" = "ok"

echo "[maintenance-createrole] CREATEROLE-only migration and provisioning checks passed"
