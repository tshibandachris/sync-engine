-- 044: FORCE ROW LEVEL SECURITY on the legacy sync tables.
-- Tables created from 018 onward are already FORCEd. The eight tables below only had
-- ENABLE ROW LEVEL SECURITY, so their owner (and anyone who inherits the owner's
-- rights) bypassed the tenant policies. FORCE makes the policies apply to the owner too.
--
-- Consequence for operators: a migration that reads or updates these tables as the
-- owner must set app.current_tenant_id first, or it sees zero rows (see CONTRIBUTING.md,
-- RLS backfill trap). SECURITY DEFINER functions touching these tables are owned by
-- maintenance_function_owner and were already subject to RLS.
BEGIN;

ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins FORCE ROW LEVEL SECURITY;
ALTER TABLE public.missions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sites FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_conflicts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_idempotency_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_purge_state FORCE ROW LEVEL SECURITY;

DO $verify$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_missing
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND c.relname IN ('attachments', 'check_ins', 'missions', 'sites', 'sync_conflicts', 'sync_idempotency_keys', 'sync_logs', 'sync_purge_state')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: row-level security is not forced on: %', v_missing;
  END IF;
END
$verify$;

COMMIT;
