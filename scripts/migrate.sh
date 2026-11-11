#!/bin/sh
#
# Apply pending SQL migrations exactly once, then provision the API, enrollment,
# device-admin and maintenance logins from independent deployment secrets. The migration ledger also
# allows existing pre-ledger installations to advance beyond migration 030.
#
set -eu

MIGRATIONS_ONLY=0
if [ "${1:-}" = "--migrations-only" ]; then
  MIGRATIONS_ONLY=1
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "[migrate] ERROR: unexpected argument: $1" >&2
  exit 2
fi

: "${SYNC_APP_PASSWORD:?SYNC_APP_PASSWORD is required}"
: "${DEVICE_ENROLLMENT_PASSWORD:?DEVICE_ENROLLMENT_PASSWORD is required}"
: "${DEVICE_ADMIN_PASSWORD:?DEVICE_ADMIN_PASSWORD is required}"
: "${MAINTENANCE_PASSWORD:?MAINTENANCE_PASSWORD is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

DB_HOST=${DB_HOST:-db}
DB_NAME=${DB_NAME:-sync_engine}
DB_USER=${DB_USER:-postgres}
MIGRATIONS_DIR=${MIGRATIONS_DIR:-/migrations}

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

ledger_entries=$(psql_base -tA -c "SELECT count(*) FROM public.schema_migrations")

if [ "$legacy_schema" = "1" ] && [ "$ledger_entries" = "0" ]; then
  echo "[migrate] legacy pre-ledger database detected; verifying migration-030 baseline"
  baseline_ok=$(psql_base -tA -c "
    SELECT CASE
      WHEN to_regclass('public.products') IS NOT NULL
       AND to_regclass('public.staff') IS NOT NULL
       AND to_regclass('public.cash_sessions') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_sessions' AND column_name = 'reconciliation_alert_reason')
       AND to_regclass('public.sales') IS NOT NULL
       AND to_regclass('public.sale_lines') IS NOT NULL
       AND to_regclass('public.stock_movements') IS NOT NULL
       AND to_regclass('public.inventory_counts') IS NOT NULL
       AND to_regclass('public.inventory_count_lines') IS NOT NULL
       AND to_regclass('public.courriers') IS NOT NULL
       AND to_regclass('public.courrier_attachments') IS NOT NULL
       AND to_regclass('public.courrier_assignments') IS NOT NULL
       AND to_regclass('public.courrier_audit_logs') IS NOT NULL
       AND to_regclass('public.devices') IS NOT NULL
       AND to_regclass('public.device_pairing_codes') IS NOT NULL
       AND to_regclass('public.device_credentials') IS NULL
      THEN 1 ELSE 0 END
  ")
  if [ "$baseline_ok" != "1" ]; then
    echo "[migrate] ERROR: legacy schema is not at the expected pre-031 baseline."
    echo "[migrate] Refusing to guess which non-idempotent migrations have already run."
    exit 1
  fi

  baseline_values=""
  for f in $MIGRATIONS_DIR/*.sql; do
    name=$(basename "$f")
    version=$(printf '%s' "$name" | cut -d_ -f1)
    version_number=$(printf '%s' "$version" | sed 's/^0*//')
    [ -n "$version_number" ] || version_number=0
    if [ "$version_number" -le 30 ]; then
      baseline_values="$baseline_values('$name'),"
    fi
  done
  baseline_values=${baseline_values%,}
  psql_base -c "
    BEGIN;
    INSERT INTO public.schema_migrations (filename)
    VALUES $baseline_values
    ON CONFLICT (filename) DO NOTHING;
    COMMIT;
  " > /dev/null
  echo "[migrate] baseline 001-030 recorded atomically"
fi

echo "[migrate] applying pending migrations (transactional ledger)"
for f in $MIGRATIONS_DIR/*.sql; do
  name=$(basename "$f")
  tmp=$(mktemp)

  # Migration files historically carry their own BEGIN/COMMIT. Remove only
  # standalone transaction-control lines so the migration and its ledger row
  # can commit atomically in one psql transaction.
  {
    printf '%s
' "BEGIN;"
    printf '%s
' "SELECT pg_advisory_xact_lock(7303::bigint);"
    printf '%s
' "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE filename = '$name') AS migration_already_applied \\gset"
    printf '%s
' "\\if :migration_already_applied"
    printf '%s
' "\\echo [migrate]   already applied: $name"
    printf '%s
' "\\else"
    awk '
      !/^[[:space:]]*BEGIN;[[:space:]]*$/ &&
      !/^[[:space:]]*COMMIT;[[:space:]]*$/ { print }
    ' "$f"
    printf '
INSERT INTO public.schema_migrations (filename) VALUES (\047%s\047);
' "$name"
    printf '%s
' "\\endif"
    printf '%s
' "COMMIT;"
  } > "$tmp"

  echo "[migrate]   checking/applying: $name"
  if ! psql_base -f "$tmp" > /dev/null; then
    rm -f "$tmp"
    echo "[migrate] ERROR: migration failed; transaction rolled back: $name"
    exit 1
  fi
  rm -f "$tmp"
done

if [ "$MIGRATIONS_ONLY" = "1" ]; then
  echo "[migrate] migrations-only test mode complete; login provisioning skipped"
  exit 0
fi

echo "[migrate] restricting migration ledger and enabling application login"
psql_base <<'EOSQL'
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, sync_app;
EOSQL
psql_base -v pw="$SYNC_APP_PASSWORD" -v db_name="$DB_NAME" <<'EOSQL'
ALTER ROLE sync_app LOGIN INHERIT PASSWORD :'pw';
ALTER ROLE sync_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE :"db_name" TO sync_app;
EOSQL

echo "[migrate] provisioning isolated enrollment login"
enrollment_role_exists=$(psql_base -tA -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login') THEN 1 ELSE 0 END")
if [ "$enrollment_role_exists" = "1" ]; then
  psql_base -v pw="$DEVICE_ENROLLMENT_PASSWORD" -v db_name="$DB_NAME" <<'EOSQL'
ALTER ROLE device_enrollment_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
else
  psql_base -v pw="$DEVICE_ENROLLMENT_PASSWORD" <<'EOSQL'
CREATE ROLE device_enrollment_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
fi

psql_base -v db_name="$DB_NAME" <<'EOSQL'
REVOKE sync_app FROM device_enrollment_login;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM device_enrollment_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM device_enrollment_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM device_enrollment_login;
GRANT device_enrollment_executor TO device_enrollment_login WITH INHERIT TRUE, SET FALSE;
GRANT CONNECT ON DATABASE :"db_name" TO device_enrollment_login;
EOSQL

echo "[migrate] provisioning isolated device admin login"
admin_role_exists=$(psql_base -tA -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'device_admin_login') THEN 1 ELSE 0 END")
if [ "$admin_role_exists" = "1" ]; then
  psql_base -v pw="$DEVICE_ADMIN_PASSWORD" -v db_name="$DB_NAME" <<'EOSQL'
ALTER ROLE device_admin_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
else
  psql_base -v pw="$DEVICE_ADMIN_PASSWORD" <<'EOSQL'
CREATE ROLE device_admin_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
fi

psql_base -v db_name="$DB_NAME" <<'EOSQL'
REVOKE sync_app FROM device_admin_login;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM device_admin_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM device_admin_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM device_admin_login;
GRANT device_admin_executor TO device_admin_login WITH INHERIT TRUE, SET FALSE;
GRANT CONNECT ON DATABASE :"db_name" TO device_admin_login;
EOSQL

echo "[migrate] provisioning dedicated maintenance login"
maintenance_role_exists=$(psql_base -tA -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'maintenance_login') THEN 1 ELSE 0 END")
if [ "$maintenance_role_exists" = "1" ]; then
  psql_base -v pw="$MAINTENANCE_PASSWORD" -v db_name="$DB_NAME" <<'EOSQL'
ALTER ROLE maintenance_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
else
  psql_base -v pw="$MAINTENANCE_PASSWORD" <<'EOSQL'
CREATE ROLE maintenance_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'pw';
EOSQL
fi

psql_base -v db_name="$DB_NAME" <<'EOSQL'
REVOKE sync_app FROM maintenance_login;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM maintenance_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM maintenance_login;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM maintenance_login;
GRANT maintenance_purge_executor TO maintenance_login WITH INHERIT TRUE, SET FALSE;
GRANT CONNECT ON DATABASE :"db_name" TO maintenance_login;
EOSQL

echo "[migrate] verifying maintenance role boundary"
maintenance_login_ok=$(psql_base -tA -c "
  SELECT CASE
    WHEN pg_catalog.pg_has_role('maintenance_login', 'maintenance_purge_executor', 'USAGE')
     AND NOT pg_catalog.pg_has_role('maintenance_login', 'sync_app', 'MEMBER')
     AND NOT (SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
                FROM pg_catalog.pg_roles WHERE rolname = 'maintenance_login')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.attachments', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.attachments', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.check_ins', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.missions', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.sites', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('maintenance_login', 'public.sync_purge_state', 'UPDATE')
     AND pg_catalog.has_table_privilege('maintenance_login', 'public.tenants', 'SELECT')
     AND pg_catalog.has_function_privilege('maintenance_login', 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE')
     AND pg_catalog.has_function_privilege('maintenance_login', 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE')
     AND pg_catalog.has_function_privilege('maintenance_login', 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE')
     AND pg_catalog.has_function_privilege('maintenance_login', 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE')
     AND pg_catalog.has_function_privilege('maintenance_login', 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE')
    THEN 1 ELSE 0 END
")
if [ "$maintenance_login_ok" != "1" ]; then
  echo "[migrate] ERROR: maintenance_login privilege boundary verification failed."
  exit 1
fi

purge_acl_violations=$(psql_base -tA -c "
  SELECT count(*)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND left(p.proname, 6) = 'purge_'
     AND (
       pg_catalog.has_function_privilege('sync_app', p.oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
           ) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
     )
")
if [ "$purge_acl_violations" != "0" ]; then
  echo "[migrate] ERROR: sync_app or PUBLIC can execute a purge_* function."
  exit 1
fi


echo "[migrate] verifying login separation"
separation_ok=$(psql_base -tA -c "
  SELECT CASE
    WHEN NOT pg_catalog.pg_has_role('device_enrollment_login', 'sync_app', 'MEMBER')
     AND pg_catalog.pg_has_role('device_enrollment_login', 'device_enrollment_executor', 'USAGE')
     AND NOT pg_catalog.pg_has_role('device_enrollment_login', 'device_enrollment_executor', 'SET')
     AND pg_catalog.has_function_privilege(
       'device_enrollment_login',
       'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
       'EXECUTE'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class AS c
        WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login')
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS p
        WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login')
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_namespace AS n
        WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login')
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_database AS d
        WHERE d.datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'device_enrollment_login')
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members AS membership
         JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
         JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = 'device_enrollment_login'
          AND granted_role.rolname <> 'device_enrollment_executor'
     )
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.devices', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.devices', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.devices', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'UPDATE')
     AND NOT pg_catalog.has_function_privilege('sync_app', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     AND NOT pg_catalog.has_function_privilege('sync_app', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE')
     AND NOT pg_catalog.has_function_privilege(
       'sync_app',
       'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
       'EXECUTE'
     )
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.devices', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.devices', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_credentials', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_credentials', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_approval_events', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_proof_nonces', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_enrollment_attempts', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_pairing_codes', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_pairing_codes', 'UPDATE')
     AND NOT pg_catalog.has_function_privilege('device_enrollment_executor', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     AND NOT pg_catalog.has_function_privilege('device_enrollment_executor', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE')
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = 'device_enrollment_function_owner'
          AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
          AND NOT r.rolcreaterole AND NOT r.rolinherit
          AND NOT r.rolreplication AND NOT r.rolbypassrls
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member = 'device_enrollment_function_owner'::regrole
     )
     AND NOT pg_catalog.pg_has_role('device_enrollment_function_owner', 'sync_app', 'MEMBER')
     AND NOT pg_catalog.pg_has_role('device_enrollment_function_owner', 'device_enrollment_executor', 'MEMBER')
     AND (
       SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'device_enrollment_function_owner'
         FROM pg_catalog.pg_proc AS p
        WHERE p.oid = 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)'::regprocedure
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class AS c
        WHERE c.relowner = 'device_enrollment_function_owner'::regrole
          AND c.relname IN (
            'tenants', 'devices', 'device_pairing_codes', 'device_credentials',
            'device_approval_events', 'device_proof_nonces', 'device_enrollment_attempts'
          )
     )
    THEN 1 ELSE 0 END
")
if [ "$separation_ok" != "1" ]; then
  echo "[migrate] ERROR: PostgreSQL enrollment privilege boundary verification failed."
  exit 1
fi

echo "[migrate] verifying device admin privilege boundary"
admin_separation_ok=$(psql_base -tA -c "
  SELECT CASE
    WHEN NOT pg_catalog.pg_has_role('device_admin_login', 'sync_app', 'MEMBER')
     AND pg_catalog.pg_has_role('device_admin_login', 'device_admin_executor', 'USAGE')
     AND NOT pg_catalog.pg_has_role('device_admin_login', 'device_admin_executor', 'SET')
     AND pg_catalog.has_function_privilege('device_admin_login', 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members AS m
       JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = m.member
       JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = m.roleid
       WHERE member_role.rolname = 'device_admin_login'
         AND granted_role.rolname <> 'device_admin_executor'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE relowner = 'device_admin_login'::regrole
     )
     AND NOT pg_catalog.has_table_privilege('device_admin_login', 'public.devices', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('device_admin_login', 'public.devices', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('device_admin_login', 'public.device_credentials', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('device_admin_login', 'public.device_approval_events', 'INSERT')
     AND NOT pg_catalog.has_function_privilege('sync_app', 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE')
    THEN 1 ELSE 0 END
")
if [ "$admin_separation_ok" != "1" ]; then
  echo "[migrate] ERROR: PostgreSQL device admin privilege boundary verification failed."
  exit 1
fi

echo "[migrate] verifying device proof nonce maintenance capability"
nonce_purge_owner_ok=$(psql_base -tA -c "
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.rolname = 'device_proof_maintenance_function_owner'
        AND NOT r.rolcanlogin
        AND NOT r.rolsuper
        AND NOT r.rolcreatedb
        AND NOT r.rolcreaterole
        AND NOT r.rolinherit
        AND NOT r.rolreplication
        AND NOT r.rolbypassrls
    )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members m
       WHERE m.member = 'device_proof_maintenance_function_owner'::regrole
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
       WHERE c.relowner = 'device_proof_maintenance_function_owner'::regrole
         AND c.relname = 'device_proof_nonces'
     )
     AND pg_catalog.has_table_privilege(
       'device_proof_maintenance_function_owner',
       'public.device_proof_nonces',
       'SELECT'
     )
     AND pg_catalog.has_table_privilege(
       'device_proof_maintenance_function_owner',
       'public.device_proof_nonces',
       'DELETE'
     )
     AND NOT pg_catalog.has_table_privilege(
       'device_proof_maintenance_function_owner',
       'public.device_proof_nonces',
       'UPDATE'
     )
     AND NOT pg_catalog.has_table_privilege('sync_app', 'public.device_proof_nonces', 'DELETE')
     AND pg_catalog.has_function_privilege(
       'maintenance_login',
       'public.purge_expired_device_proof_nonces(uuid,integer)',
       'EXECUTE'
     )
     AND NOT pg_catalog.has_function_privilege(
       'sync_app',
       'public.purge_expired_device_proof_nonces(uuid,integer)',
       'EXECUTE'
     )
     AND (
       SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'device_proof_maintenance_function_owner'
       FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.purge_expired_device_proof_nonces(uuid,integer)'::regprocedure
     )
    THEN 1 ELSE 0 END
")
if [ "$nonce_purge_owner_ok" != "1" ]; then
  echo "[migrate] nonce purge privilege diagnostic:"
  psql_base -c "
    SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'device_proof_maintenance_function_owner'
        AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
        AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls) AS owner_role_ok,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
        WHERE m.member = 'device_proof_maintenance_function_owner'::regrole) AS no_owner_membership,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relowner = 'device_proof_maintenance_function_owner'::regrole
          AND c.relname = 'device_proof_nonces') AS owner_not_table_owner,
      pg_catalog.has_table_privilege('device_proof_maintenance_function_owner', 'public.device_proof_nonces', 'SELECT') AS owner_select,
      pg_catalog.has_table_privilege('device_proof_maintenance_function_owner', 'public.device_proof_nonces', 'DELETE') AS owner_delete,
      NOT pg_catalog.has_table_privilege('device_proof_maintenance_function_owner', 'public.device_proof_nonces', 'UPDATE') AS owner_no_update,
      NOT pg_catalog.has_table_privilege('sync_app', 'public.device_proof_nonces', 'DELETE') AS app_no_delete,
      pg_catalog.has_function_privilege('maintenance_login', 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS maintenance_execute,
      NOT pg_catalog.has_function_privilege('sync_app', 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') AS app_no_execute,
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'device_proof_maintenance_function_owner'
        FROM pg_catalog.pg_proc p
        WHERE p.oid = 'public.purge_expired_device_proof_nonces(uuid,integer)'::regprocedure) AS function_owner_ok
  "
  echo "[migrate] ERROR: PostgreSQL nonce maintenance privilege boundary verification failed."
  exit 1
fi

echo "[migrate] done"
