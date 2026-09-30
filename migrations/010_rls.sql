BEGIN;

-- Remove the temporary default-tenant triggers. They silently route any
-- INSERT without an explicit tenant_id to the zero tenant, which masks
-- exactly the bug RLS is meant to catch.
DROP TRIGGER IF EXISTS trg_sites_default_tenant ON sites;
DROP TRIGGER IF EXISTS trg_missions_default_tenant ON missions;
DROP TRIGGER IF EXISTS trg_check_ins_default_tenant ON check_ins;
DROP TRIGGER IF EXISTS trg_sync_conflicts_default_tenant ON sync_conflicts;
DROP TRIGGER IF EXISTS trg_sync_idempotency_keys_default_tenant ON sync_idempotency_keys;
DROP TRIGGER IF EXISTS trg_attachments_default_tenant ON attachments;
DROP FUNCTION IF EXISTS set_default_tenant_id();

-- Enable RLS + FORCE on the 7 tenant-scoped tables.
ALTER TABLE sites                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE missions                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE missions                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE check_ins                ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins                FORCE  ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts           FORCE  ROW LEVEL SECURITY;
ALTER TABLE sync_idempotency_keys    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_idempotency_keys    FORCE  ROW LEVEL SECURITY;
ALTER TABLE attachments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments              FORCE  ROW LEVEL SECURITY;
ALTER TABLE sync_purge_state         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_purge_state         FORCE  ROW LEVEL SECURITY;

-- Policies: fail closed if app.current_tenant_id is not set.
-- current_setting(..., true) returns NULL when missing, NULLIF turns '' into NULL,
-- and "tenant_id = NULL" evaluates to NULL (filtered out), yielding zero rows.
CREATE POLICY tenant_isolation_sites ON sites
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_missions ON missions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_check_ins ON check_ins
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_sync_conflicts ON sync_conflicts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_sync_idempotency_keys ON sync_idempotency_keys
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_attachments ON attachments
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_sync_purge_state ON sync_purge_state
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
