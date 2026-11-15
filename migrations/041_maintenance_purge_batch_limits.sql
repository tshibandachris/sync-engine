-- 041: close the legacy PUBLIC purge entry point and bound tenant retention batches.
BEGIN;

-- The legacy idempotency/conflict cleanup is retained, but is now
-- executed only through the maintenance capability and tenant RLS context.
GRANT SELECT, DELETE ON public.sync_idempotency_keys, public.sync_conflicts
  TO maintenance_function_owner;

CREATE OR REPLACE FUNCTION public.purge_sync_tables(
  ttl_idempotency_days integer,
  ttl_conflicts_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_tenant uuid;
  v_cutoff_idempotency timestamptz;
  v_cutoff_conflicts bigint;
  v_idempotency_ctids tid[] := ARRAY[]::tid[];
  v_conflict_ctids tid[] := ARRAY[]::tid[];
  deleted_idempotency integer := 0;
  deleted_conflicts integer := 0;
BEGIN
  v_tenant := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context is required for sync retention purge'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant::text, 4123)
  );
  IF ttl_idempotency_days IS NULL OR ttl_idempotency_days < 0
     OR ttl_conflicts_days IS NULL OR ttl_conflicts_days < 0 THEN
    RAISE EXCEPTION 'retention TTLs must be >= 0' USING ERRCODE = '22023';
  END IF;

  v_cutoff_idempotency := clock_timestamp() - make_interval(days => ttl_idempotency_days);
  v_cutoff_conflicts :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - make_interval(days => ttl_conflicts_days))) * 1000)::bigint;

  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO v_idempotency_ctids
    FROM (
      SELECT ctid
        FROM public.sync_idempotency_keys
       WHERE tenant_id = v_tenant AND created_at < v_cutoff_idempotency
       ORDER BY created_at
       LIMIT 5000
    ) selected;
  IF cardinality(v_idempotency_ctids) > 0 THEN
    DELETE FROM public.sync_idempotency_keys
     WHERE ctid = ANY(v_idempotency_ctids) AND tenant_id = v_tenant;
    GET DIAGNOSTICS deleted_idempotency = ROW_COUNT;
  END IF;

  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO v_conflict_ctids
    FROM (
      SELECT ctid
        FROM public.sync_conflicts
       WHERE tenant_id = v_tenant
         AND status = 'resolved'
         AND resolved_at IS NOT NULL
         AND resolved_at < v_cutoff_conflicts
       ORDER BY resolved_at
       LIMIT 5000
    ) selected;
  IF cardinality(v_conflict_ctids) > 0 THEN
    DELETE FROM public.sync_conflicts
     WHERE ctid = ANY(v_conflict_ctids) AND tenant_id = v_tenant;
    GET DIAGNOSTICS deleted_conflicts = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'idempotency_deleted', deleted_idempotency,
    'conflicts_deleted', deleted_conflicts
  );
END;
$function$;

ALTER FUNCTION public.purge_sync_tables(integer, integer)
  OWNER TO maintenance_function_owner;
ALTER FUNCTION public.purge_sync_tables(integer, integer)
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.purge_sync_tables(integer, integer)
  SET row_security TO on;
REVOKE ALL ON FUNCTION public.purge_sync_tables(integer, integer) FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.purge_sync_tables(integer, integer) TO maintenance_purge_executor;

CREATE OR REPLACE FUNCTION public.purge_tenant_tombstones(
  p_tenant_id uuid,
  ttl_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  cutoff_ms bigint;
  max_seq_deleted bigint := 0;
  deleted_checkins integer := 0;
  deleted_missions integer := 0;
  deleted_sites integer := 0;
  new_watermark bigint := 0;
  orphaned_keys text[] := ARRAY[]::text[];
  selected_ctids tid[] := ARRAY[]::tid[];
  selected_max_seq bigint := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant id is required' USING ERRCODE = '22023';
  END IF;
  IF ttl_days IS NULL OR ttl_days < 0 THEN
    RAISE EXCEPTION 'ttl_days must be >= 0' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(current_setting('app.current_tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant context does not match tombstone purge tenant' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text, 4123)
  );

  cutoff_ms :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_days || ' days')::interval)) * 1000)::bigint;

  -- A single invocation removes at most 5,000 expired rows per table.
  -- Child rows are handled before parents; a parent is not removed while
  -- any child remains, preventing a cascade from bypassing the batch cap.
  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO selected_ctids
    FROM (
      SELECT ctid
        FROM public.check_ins
       WHERE tenant_id = p_tenant_id
         AND deleted_at IS NOT NULL
         AND deleted_at < cutoff_ms
       ORDER BY deleted_at, id
       LIMIT 5000
    ) selected;

  IF cardinality(selected_ctids) > 0 THEN
    SELECT COALESCE(array_agg(a.object_key), ARRAY[]::text[])
      INTO orphaned_keys
      FROM public.attachments a
      JOIN public.check_ins ci
        ON ci.id = a.check_in_id
       AND ci.tenant_id = a.tenant_id
     WHERE ci.ctid = ANY(selected_ctids)
       AND ci.tenant_id = p_tenant_id;

    SELECT COALESCE(MAX(sync_seq), 0)
      INTO selected_max_seq
      FROM public.check_ins
     WHERE ctid = ANY(selected_ctids);
    max_seq_deleted := GREATEST(max_seq_deleted, selected_max_seq);

    DELETE FROM public.check_ins
     WHERE ctid = ANY(selected_ctids)
       AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS deleted_checkins = ROW_COUNT;
  END IF;

  selected_ctids := ARRAY[]::tid[];
  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO selected_ctids
    FROM (
      SELECT m.ctid
        FROM public.missions m
       WHERE m.tenant_id = p_tenant_id
         AND m.deleted_at IS NOT NULL
         AND m.deleted_at < cutoff_ms
         AND NOT EXISTS (
           SELECT 1 FROM public.check_ins ci
            WHERE ci.tenant_id = m.tenant_id AND ci.mission_id = m.id
         )
       ORDER BY m.deleted_at, m.id
       LIMIT 5000
    ) selected;

  IF cardinality(selected_ctids) > 0 THEN
    SELECT COALESCE(MAX(sync_seq), 0)
      INTO selected_max_seq
      FROM public.missions
     WHERE ctid = ANY(selected_ctids);
    max_seq_deleted := GREATEST(max_seq_deleted, selected_max_seq);

    DELETE FROM public.missions
     WHERE ctid = ANY(selected_ctids)
       AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS deleted_missions = ROW_COUNT;
  END IF;

  selected_ctids := ARRAY[]::tid[];
  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO selected_ctids
    FROM (
      SELECT s.ctid
        FROM public.sites s
       WHERE s.tenant_id = p_tenant_id
         AND s.deleted_at IS NOT NULL
         AND s.deleted_at < cutoff_ms
         AND NOT EXISTS (
           SELECT 1 FROM public.missions m
            WHERE m.tenant_id = s.tenant_id AND m.site_id = s.id
         )
       ORDER BY s.deleted_at, s.id
       LIMIT 5000
    ) selected;

  IF cardinality(selected_ctids) > 0 THEN
    SELECT COALESCE(MAX(sync_seq), 0)
      INTO selected_max_seq
      FROM public.sites
     WHERE ctid = ANY(selected_ctids);
    max_seq_deleted := GREATEST(max_seq_deleted, selected_max_seq);

    DELETE FROM public.sites
     WHERE ctid = ANY(selected_ctids)
       AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS deleted_sites = ROW_COUNT;
  END IF;

  IF max_seq_deleted > 0 THEN
    INSERT INTO public.sync_purge_state (tenant_id, purged_up_to_seq, updated_at)
    VALUES (p_tenant_id, max_seq_deleted, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT (tenant_id) DO UPDATE
      SET purged_up_to_seq = GREATEST(sync_purge_state.purged_up_to_seq, EXCLUDED.purged_up_to_seq),
          updated_at = EXCLUDED.updated_at
    RETURNING purged_up_to_seq INTO new_watermark;
  ELSE
    SELECT COALESCE(
      (SELECT purged_up_to_seq FROM public.sync_purge_state WHERE tenant_id = p_tenant_id),
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
$function$;

ALTER FUNCTION public.purge_tenant_tombstones(uuid, integer)
  OWNER TO maintenance_function_owner;
REVOKE ALL ON FUNCTION public.purge_tenant_tombstones(uuid, integer) FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.purge_tenant_tombstones(uuid, integer) TO maintenance_purge_executor;

CREATE OR REPLACE FUNCTION public.purge_tenant_sync_logs(
  p_tenant_id uuid,
  ttl_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  cutoff_ms bigint;
  deleted_count integer := 0;
  prev_tenant text;
  selected_ctids tid[] := ARRAY[]::tid[];
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant id is required' USING ERRCODE = '22023';
  END IF;
  IF ttl_days IS NULL OR ttl_days < 30 THEN
    RAISE EXCEPTION 'ttl_days must be >= 30 (got %)', ttl_days USING ERRCODE = '22023';
  END IF;

  prev_tenant := current_setting('app.current_tenant_id', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text, 4123)
  );
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);

  cutoff_ms :=
    (EXTRACT(EPOCH FROM (clock_timestamp() - (ttl_days || ' days')::interval)) * 1000)::bigint;

  SELECT COALESCE(array_agg(ctid), ARRAY[]::tid[])
    INTO selected_ctids
    FROM (
      SELECT ctid
        FROM public.sync_logs
       WHERE tenant_id = p_tenant_id
         AND started_at < cutoff_ms
       ORDER BY started_at, id
       LIMIT 5000
    ) selected;

  IF cardinality(selected_ctids) > 0 THEN
    DELETE FROM public.sync_logs
     WHERE ctid = ANY(selected_ctids)
       AND tenant_id = p_tenant_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  END IF;

  PERFORM set_config('app.current_tenant_id', COALESCE(prev_tenant, ''), true);
  RETURN jsonb_build_object('logs_deleted', deleted_count);
END;
$function$;

ALTER FUNCTION public.purge_tenant_sync_logs(uuid, integer)
  OWNER TO maintenance_function_owner;
ALTER FUNCTION public.purge_tenant_sync_logs(uuid, integer)
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.purge_tenant_sync_logs(uuid, integer)
  SET row_security TO on;
REVOKE ALL ON FUNCTION public.purge_tenant_sync_logs(uuid, integer) FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.purge_tenant_sync_logs(uuid, integer) TO maintenance_purge_executor;

COMMIT;
