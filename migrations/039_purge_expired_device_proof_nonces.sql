-- 039: bounded, tenant-scoped cleanup for expired device proof nonces.
-- sync_app cannot DELETE nonce rows directly. The SECURITY DEFINER function
-- exposes only the narrow operation needed by the maintenance cycle.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_device_proof_nonces_tenant_expiry
  ON public.device_proof_nonces (tenant_id, expires_at);

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
  v_previous_tenant TEXT;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant id is required';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 10000';
  END IF;

  v_previous_tenant := current_setting('app.current_tenant_id', true);
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);

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
  PERFORM set_config('app.current_tenant_id', COALESCE(v_previous_tenant, ''), true);
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_device_proof_nonces(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_device_proof_nonces(UUID, INTEGER) TO sync_app;

COMMIT;
