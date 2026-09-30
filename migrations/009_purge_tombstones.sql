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
BEGIN
  IF ttl_days < 0 THEN
    RAISE EXCEPTION 'ttl_days must be >= 0';
  END IF;

  cutoff_ms :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_days || ' days')::interval)) * 1000)::BIGINT;

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
    'purged_up_to_seq', new_watermark
  );
END;
$$ LANGUAGE plpgsql;

COMMIT;
