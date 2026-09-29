BEGIN;

CREATE OR REPLACE FUNCTION purge_sync_tables(
  ttl_idempotency_days INT,
  ttl_conflicts_days INT
)
RETURNS JSONB AS $$
DECLARE
  cutoff_conflicts BIGINT;
  deleted_idempotency INT;
  deleted_conflicts INT;
BEGIN
  cutoff_conflicts :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_conflicts_days || ' days')::interval)) * 1000)::BIGINT;

  DELETE FROM sync_idempotency_keys
  WHERE created_at < (clock_timestamp() - (ttl_idempotency_days || ' days')::interval);

  GET DIAGNOSTICS deleted_idempotency = ROW_COUNT;

  DELETE FROM sync_conflicts
  WHERE status = 'resolved'
    AND resolved_at IS NOT NULL
    AND resolved_at < cutoff_conflicts;

  GET DIAGNOSTICS deleted_conflicts = ROW_COUNT;

  RETURN jsonb_build_object(
    'idempotency_deleted', deleted_idempotency,
    'conflicts_deleted', deleted_conflicts
  );
END;
$$ LANGUAGE plpgsql;

COMMIT;