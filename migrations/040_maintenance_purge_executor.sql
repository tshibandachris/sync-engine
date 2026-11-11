-- 040: dedicated least-privilege database capability for scheduled maintenance.
-- The login receives only this NOLOGIN capability; tenant data access is mediated
-- by narrow SECURITY DEFINER functions and FORCE RLS, not broad sync_app membership.
BEGIN;

DO $roles$
DECLARE r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'maintenance_function_owner';
  IF NOT FOUND THEN
    CREATE ROLE maintenance_function_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: maintenance_function_owner has unsafe role attributes';
  END IF;

  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'maintenance_purge_executor';
  IF NOT FOUND THEN
    CREATE ROLE maintenance_purge_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: maintenance_purge_executor has unsafe role attributes';
  END IF;
END
$roles$;

GRANT USAGE, CREATE ON SCHEMA public TO maintenance_function_owner;
GRANT USAGE ON SCHEMA public TO maintenance_purge_executor;

-- Only the maintenance function owner receives underlying table privileges.
-- FORCE RLS remains active; this role is neither a table owner nor BYPASSRLS.
GRANT SELECT, DELETE ON public.attachments TO maintenance_function_owner;
GRANT SELECT, DELETE ON public.check_ins TO maintenance_function_owner;
GRANT SELECT, DELETE ON public.missions TO maintenance_function_owner;
GRANT SELECT, DELETE ON public.sites TO maintenance_function_owner;
GRANT SELECT, INSERT, UPDATE ON public.sync_purge_state TO maintenance_function_owner;

CREATE OR REPLACE FUNCTION public.purge_tenant_pending_attachments(
  p_tenant_id uuid,
  p_ttl_days integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_current_tenant uuid;
  v_deleted integer := 0;
  v_cutoff_ms bigint;
BEGIN
  IF p_tenant_id IS NULL OR p_ttl_days IS NULL OR p_ttl_days < 0 THEN
    RAISE EXCEPTION 'Invalid pending attachment purge arguments' USING ERRCODE = '22023';
  END IF;
  v_current_tenant := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  IF v_current_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant context does not match pending attachment purge tenant'
      USING ERRCODE = '42501';
  END IF;
  v_cutoff_ms := (extract(epoch FROM (clock_timestamp() - make_interval(days => p_ttl_days))) * 1000)::bigint;
  DELETE FROM public.attachments
   WHERE tenant_id = p_tenant_id
     AND status = 'pending'
     AND created_at < v_cutoff_ms;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_tenant_attachment_object_keys(p_tenant_id uuid)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_current_tenant uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant id is required' USING ERRCODE = '22023';
  END IF;
  v_current_tenant := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  IF v_current_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant context does not match attachment listing tenant'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.object_key
      FROM public.attachments AS a
     WHERE a.tenant_id = p_tenant_id;
END;
$function$;

ALTER FUNCTION public.purge_tenant_tombstones(uuid, integer) OWNER TO maintenance_function_owner;
ALTER FUNCTION public.purge_tenant_tombstones(uuid, integer) SECURITY DEFINER;
ALTER FUNCTION public.purge_tenant_tombstones(uuid, integer) SET search_path TO pg_catalog, public;
ALTER FUNCTION public.purge_tenant_tombstones(uuid, integer) SET row_security TO on;

ALTER FUNCTION public.purge_tenant_pending_attachments(uuid, integer) OWNER TO maintenance_function_owner;
ALTER FUNCTION public.list_tenant_attachment_object_keys(uuid) OWNER TO maintenance_function_owner;
REVOKE CREATE ON SCHEMA public FROM maintenance_function_owner;

REVOKE ALL ON FUNCTION public.purge_tenant_tombstones(uuid, integer) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.purge_tenant_pending_attachments(uuid, integer) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.list_tenant_attachment_object_keys(uuid) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.purge_tenant_sync_logs(uuid, integer) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.purge_expired_device_proof_nonces(uuid, integer) FROM PUBLIC, sync_app;

GRANT EXECUTE ON FUNCTION public.purge_tenant_tombstones(uuid, integer) TO maintenance_purge_executor;
GRANT EXECUTE ON FUNCTION public.purge_tenant_pending_attachments(uuid, integer) TO maintenance_purge_executor;
GRANT EXECUTE ON FUNCTION public.list_tenant_attachment_object_keys(uuid) TO maintenance_purge_executor;
GRANT EXECUTE ON FUNCTION public.purge_tenant_sync_logs(uuid, integer) TO maintenance_purge_executor;
GRANT EXECUTE ON FUNCTION public.purge_expired_device_proof_nonces(uuid, integer) TO maintenance_purge_executor;

-- The login can enumerate tenant UUIDs only; it has no direct access to tenant tables.
GRANT SELECT ON public.tenants TO maintenance_purge_executor;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE member = 'maintenance_purge_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: maintenance capability must not inherit another role';
  END IF;
  IF pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.attachments', 'SELECT')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.attachments', 'DELETE')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.tenants', 'INSERT')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.check_ins', 'DELETE')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.missions', 'DELETE')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.sites', 'DELETE')
     OR pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.sync_purge_state', 'UPDATE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: maintenance executor has direct tenant-table privileges';
  END IF;
  IF NOT pg_catalog.has_table_privilege('maintenance_purge_executor', 'public.tenants', 'SELECT')
     OR NOT pg_catalog.has_function_privilege('maintenance_purge_executor', 'public.purge_tenant_tombstones(uuid,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('maintenance_purge_executor', 'public.purge_tenant_pending_attachments(uuid,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('maintenance_purge_executor', 'public.list_tenant_attachment_object_keys(uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('maintenance_purge_executor', 'public.purge_tenant_sync_logs(uuid,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('maintenance_purge_executor', 'public.purge_expired_device_proof_nonces(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: maintenance executor is missing a required purge capability';
  END IF;
END
$verify$;

COMMIT;
