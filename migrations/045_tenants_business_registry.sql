-- 045: promote the maintenance tenant registry into the business tenant registry.
-- Existing tenant UUIDs remain active for continuity; new rows are pending until
-- an explicitly authorized provisioning operation activates them.
-- This migration intentionally does not change withTenant() application behavior.
-- The removal of best-effort implicit registration is a separate application change.
--
-- Services are intentionally out of scope: there is no authoritative service catalogue
-- in migrations 001-044. V1 provisions no membership service IDs and creates no
-- membership_services table or placeholder service foreign key.

BEGIN;

-- Dedicated non-login capability boundary for future trusted tenant provisioning.
-- The executor receives no direct table privileges; writes will be exposed through
-- narrowly scoped SECURITY DEFINER functions owned by tenant_provisioning_function_owner.
DO $roles$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'tenant_provisioning_function_owner';
  IF NOT FOUND THEN
    CREATE ROLE tenant_provisioning_function_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: tenant_provisioning_function_owner has unsafe role attributes';
  END IF;

  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'tenant_provisioning_executor';
  IF NOT FOUND THEN
    CREATE ROLE tenant_provisioning_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: tenant_provisioning_executor has unsafe role attributes';
  END IF;
END
$roles$;

GRANT USAGE, CREATE ON SCHEMA public TO tenant_provisioning_function_owner;
GRANT USAGE ON SCHEMA public TO tenant_provisioning_executor;
REVOKE CREATE ON SCHEMA public FROM tenant_provisioning_function_owner;

ALTER TABLE public.tenants
  ADD COLUMN status text NOT NULL DEFAULT 'pending',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN created_by uuid,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text;

-- Preserve existing tenants: rows present before this migration are active.
UPDATE public.tenants
   SET status = 'active',
       created_at = CASE
         WHEN first_seen_at > 0
           THEN to_timestamp(first_seen_at::double precision / 1000.0)
         ELSE clock_timestamp()
       END
 WHERE status = 'pending';

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('pending', 'active', 'suspended')),
  ADD CONSTRAINT tenants_suspension_state_check
    CHECK (
      (status = 'suspended'
        AND suspended_at IS NOT NULL
        AND suspended_reason IS NOT NULL
        AND length(btrim(suspended_reason)) > 0)
      OR
      (status <> 'suspended'
        AND suspended_at IS NULL
        AND suspended_reason IS NULL)
    );

COMMENT ON TABLE public.tenants IS
  'Authoritative business tenant registry. Existing rows were backfilled active by migration 045; new tenants default to pending.';
COMMENT ON COLUMN public.tenants.status IS
  'Tenant lifecycle: pending, active, or suspended. Only trusted provisioning may transition lifecycle state.';
COMMENT ON COLUMN public.tenants.created_by IS
  'Optional UUID of the trusted administrative actor. Intentionally has no auth.users FK because Supabase Auth is external to this database schema.';
COMMENT ON COLUMN public.tenants.suspended_at IS
  'Timestamp of the current suspension; must be cleared when the tenant is reactivated.';
COMMENT ON COLUMN public.tenants.suspended_reason IS
  'Non-empty audit reason required while status is suspended.';
COMMENT ON TABLE public.tenants IS
  'Authoritative business tenant registry. Services are intentionally not modelled until an authoritative service catalogue exists.';

-- The runtime sync role may resolve an existing tenant but cannot create, alter,
-- or delete tenant registry rows. The legacy best-effort INSERT in withTenant()
-- is left untouched here and will be removed in a separate application change.
REVOKE ALL ON TABLE public.tenants FROM PUBLIC, sync_app;
GRANT SELECT ON TABLE public.tenants TO sync_app;
GRANT SELECT ON TABLE public.tenants TO tenant_provisioning_executor;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tenants TO tenant_provisioning_function_owner;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
     WHERE member IN (
       'tenant_provisioning_executor'::regrole,
       'tenant_provisioning_function_owner'::regrole
     )
        OR roleid IN (
       'tenant_provisioning_executor'::regrole,
       'tenant_provisioning_function_owner'::regrole
     )
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: tenant provisioning roles must not have role memberships';
  END IF;

  IF pg_catalog.has_table_privilege('sync_app', 'public.tenants', 'INSERT')
     OR pg_catalog.has_table_privilege('sync_app', 'public.tenants', 'UPDATE')
     OR pg_catalog.has_table_privilege('sync_app', 'public.tenants', 'DELETE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: sync_app retains tenant registry write privileges';
  END IF;

  IF pg_catalog.has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'INSERT')
     OR pg_catalog.has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'UPDATE')
     OR pg_catalog.has_table_privilege('tenant_provisioning_executor', 'public.tenants', 'DELETE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: tenant provisioning executor has direct table write privileges';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname = 'tenant_provisioning_function_owner'
       AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
       AND NOT r.rolcreaterole AND NOT r.rolinherit
       AND NOT r.rolreplication AND NOT r.rolbypassrls
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname = 'tenant_provisioning_executor'
       AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
       AND NOT r.rolcreaterole AND NOT r.rolinherit
       AND NOT r.rolreplication AND NOT r.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: tenant provisioning role attributes are unsafe';
  END IF;
END
$verify$;

COMMIT;
