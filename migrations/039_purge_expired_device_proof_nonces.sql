-- 039: bounded, tenant-scoped cleanup for expired device proof nonces.
-- sync_app cannot DELETE nonce rows directly. The SECURITY DEFINER function
-- exposes only the narrow operation needed by the maintenance cycle.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_device_proof_nonces_tenant_expiry
  ON public.device_proof_nonces (tenant_id, expires_at);

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'device_proof_maintenance_function_owner'
  ) THEN
    CREATE ROLE device_proof_maintenance_function_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$role$;

GRANT USAGE, CREATE ON SCHEMA public TO device_proof_maintenance_function_owner;
GRANT SELECT, DELETE ON TABLE public.device_proof_nonces TO device_proof_maintenance_function_owner;

CREATE OR REPLACE FUNCTION public.purge_expired_device_proof_nonces(
  p_tenant_id UUID,
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted INTEGER := 0;
  v_current_tenant UUID;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant id is required';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 10000';
  END IF;

  v_current_tenant := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  IF v_current_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant context does not match nonce purge tenant' USING ERRCODE = '42501';
  END IF;

  WITH expired AS (
    SELECT ctid
    FROM public.device_proof_nonces
    WHERE tenant_id = p_tenant_id
      AND expires_at <= clock_timestamp()
    ORDER BY expires_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.device_proof_nonces AS nonce
  USING expired
  WHERE nonce.ctid = expired.ctid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

ALTER FUNCTION public.purge_expired_device_proof_nonces(UUID, INTEGER)
  OWNER TO device_proof_maintenance_function_owner;
REVOKE CREATE ON SCHEMA public FROM device_proof_maintenance_function_owner;
REVOKE ALL ON FUNCTION public.purge_expired_device_proof_nonces(UUID, INTEGER) FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.purge_expired_device_proof_nonces(UUID, INTEGER) TO sync_app;

COMMIT;
