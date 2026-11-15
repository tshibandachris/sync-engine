#!/bin/sh
# Prove that a failed migration is rolled back and can be retried safely.
set -eu

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

psql_check() {
  psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tA "$@"
}

cat > "$tmp_dir/041_recovery_probe.sql" <<'SQL'
CREATE TABLE public.migration_recovery_probe (id integer PRIMARY KEY);
INSERT INTO public.migration_recovery_probe (id) VALUES (1);
SELECT 1 / 0;
SQL

echo "[migration-recovery] injecting a deliberate failure"
if MIGRATIONS_DIR="$tmp_dir" sh scripts/migrate.sh; then
  echo "[migration-recovery] ERROR: the intentionally broken migration unexpectedly succeeded" >&2
  exit 1
fi

failed_ledger_rows=$(psql_check -c "SELECT count(*) FROM public.schema_migrations WHERE filename = '041_recovery_probe.sql'")
failed_table=$(psql_check -c "SELECT COALESCE(to_regclass('public.migration_recovery_probe')::text, '')")
test "$failed_ledger_rows" = "0"
test -z "$failed_table"
echo "[migration-recovery] failure left neither DDL nor a ledger row"

cat > "$tmp_dir/041_recovery_probe.sql" <<'SQL'
CREATE TABLE public.migration_recovery_probe (id integer PRIMARY KEY);
INSERT INTO public.migration_recovery_probe (id) VALUES (1);
SQL

echo "[migration-recovery] retrying the corrected migration"
MIGRATIONS_DIR="$tmp_dir" sh scripts/migrate.sh

probe_rows=$(psql_check -c "SELECT count(*) FROM public.migration_recovery_probe")
ledger_rows=$(psql_check -c "SELECT count(*) FROM public.schema_migrations WHERE filename = '041_recovery_probe.sql'")
test "$probe_rows" = "1"
test "$ledger_rows" = "1"

echo "[migration-recovery] running the corrected migration a second time"
MIGRATIONS_DIR="$tmp_dir" sh scripts/migrate.sh
probe_rows=$(psql_check -c "SELECT count(*) FROM public.migration_recovery_probe")
ledger_rows=$(psql_check -c "SELECT count(*) FROM public.schema_migrations WHERE filename = '041_recovery_probe.sql'")
test "$probe_rows" = "1"
test "$ledger_rows" = "1"

echo "[migration-recovery] rollback, retry and replay checks passed"
