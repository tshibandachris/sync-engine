-- Purge sync_logs older than ttl_days for one tenant.
--
-- sync_logs is append-only for sync_app: migration 014 revoked every
-- privilege except SELECT and INSERT. The purge therefore cannot run as
-- sync_app directly; it needs a SECURITY DEFINER function that executes
-- the DELETE with the privileges of the migration role.
--
-- FORCE ROW LEVEL SECURITY still applies inside the function, even for
-- the owner, so the function sets app.current_tenant_id itself. This
-- makes the call self-contained: no need for the caller to open a
-- withTenant block first, though doing so is harmless.
--
-- SET search_path closes the classic SECURITY DEFINER attack: an
-- untrusted schema earlier in the path cannot shadow pg_catalog or the
-- public table the function deletes from.

BEGIN;

CREATE OR REPLACE FUNCTION purge_tenant_sync_logs(
  p_tenant_id UUID,
  ttl_days    INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  cutoff_ms     BIGINT;
  deleted_count INT;
  prev_tenant   TEXT;
BEGIN
  -- Plancher : sync_logs est une piste d'audit, append-only pour sync_app. La fenêtre de
  -- rétention est une règle de la base, pas un choix de l'appelant : ttl_days = 0 l'effacerait.
  IF ttl_days IS NULL OR ttl_days < 30 THEN
    RAISE EXCEPTION 'ttl_days must be >= 30 (got %)', ttl_days;
  END IF;

  -- set_config(..., true) dure jusqu'à la fin de la transaction, pas de la fonction :
  -- on restaure le contexte de l'appelant pour ne pas basculer le reste de sa transaction.
  prev_tenant := current_setting('app.current_tenant_id', true);
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);

  cutoff_ms :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_days || ' days')::interval)) * 1000)::BIGINT;

  DELETE FROM sync_logs
  WHERE tenant_id = p_tenant_id
    AND started_at < cutoff_ms;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  PERFORM set_config('app.current_tenant_id', COALESCE(prev_tenant, ''), true);

  RETURN jsonb_build_object('logs_deleted', deleted_count);
END;
$$;

-- Default EXECUTE is granted to PUBLIC. Remove it: only sync_app may
-- invoke the purge. The owner keeps implicit EXECUTE.
REVOKE ALL ON FUNCTION purge_tenant_sync_logs(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant_sync_logs(UUID, INT) TO sync_app;

COMMIT;
