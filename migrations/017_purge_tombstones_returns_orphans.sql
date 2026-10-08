-- purge_tenant_tombstones v2: also return the object keys of the
-- attachments that will be cascaded away by the check_ins DELETE.
--
-- attachments.check_in_id references check_ins(id, tenant_id) with
-- ON DELETE CASCADE (migration 007). When the tombstone purge removes a
-- soft-deleted check-in, its attachment rows disappear in the same
-- statement, and the object keys are lost: no way to know which S3
-- objects became orphans. The function now collects them before the
-- DELETE and returns them in the JSONB payload.
--
-- The caller decides what to do with the keys. This function only
-- reports them; the S3 DELETE is a separate, best-effort step (see
-- SyncMaintenanceService.purgeTenantStorage).

BEGIN;

CREATE OR REPLACE FUNCTION purge_tenant_tombstones(
  p_tenant_id UUID,
  ttl_days    INT
)
RETURNS JSONB AS $$
DECLARE
  cutoff_ms        BIGINT;
  max_seq_deleted  BIGINT;
  deleted_checkins INT;
  deleted_missions INT;
  deleted_sites    INT;
  new_watermark    BIGINT;
  orphaned_keys    TEXT[];
BEGIN
  IF ttl_days < 0 THEN
    RAISE EXCEPTION 'ttl_days must be >= 0';
  END IF;

  cutoff_ms :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_days || ' days')::interval)) * 1000)::BIGINT;

  -- Collect the object keys before the DELETE cascades the attachment
  -- rows away. Independent of the attachment status: pending or
  -- uploaded, the row is going, and the caller must decide what to do
  -- with the object.
  SELECT COALESCE(array_agg(a.object_key), ARRAY[]::TEXT[])
    INTO orphaned_keys
  FROM attachments a
  JOIN check_ins ci
    ON ci.id = a.check_in_id
   AND ci.tenant_id = a.tenant_id
  WHERE ci.tenant_id = p_tenant_id
    AND ci.deleted_at IS NOT NULL
    AND ci.deleted_at < cutoff_ms;

  SELECT GREATEST(
    COALESCE((SELECT MAX(sync_seq) FROM check_ins WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms), 0),
    COALESCE((SELECT MAX(sync_seq) FROM missions  WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms), 0),
    COALESCE((SELECT MAX(sync_seq) FROM sites     WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms), 0)
  ) INTO max_seq_deleted;

  DELETE FROM check_ins WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms;
  GET DIAGNOSTICS deleted_checkins = ROW_COUNT;

  DELETE FROM missions  WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms;
  GET DIAGNOSTICS deleted_missions = ROW_COUNT;

  DELETE FROM sites     WHERE tenant_id = p_tenant_id AND deleted_at IS NOT NULL AND deleted_at < cutoff_ms;
  GET DIAGNOSTICS deleted_sites = ROW_COUNT;

  IF max_seq_deleted > 0 THEN
    INSERT INTO sync_purge_state (tenant_id, purged_up_to_seq, updated_at)
    VALUES (p_tenant_id, max_seq_deleted, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
    ON CONFLICT (tenant_id) DO UPDATE
      SET purged_up_to_seq = GREATEST(sync_purge_state.purged_up_to_seq, EXCLUDED.purged_up_to_seq),
          updated_at = EXCLUDED.updated_at
    RETURNING purged_up_to_seq INTO new_watermark;
  ELSE
    SELECT COALESCE(
      (SELECT purged_up_to_seq FROM sync_purge_state WHERE tenant_id = p_tenant_id),
      0
    ) INTO new_watermark;
  END IF;

  RETURN jsonb_build_object(
    'check_ins_deleted', deleted_checkins,
    'missions_deleted', deleted_missions,
    'sites_deleted', deleted_sites,
    'purged_up_to_seq', new_watermark,
    'orphaned_object_keys', to_jsonb(orphaned_keys)
  );
END;
$$ LANGUAGE plpgsql;

COMMIT;
