BEGIN;

-- ============================================================================
-- Migration 006 : Multi-Tenancy Schema, Composite FKs & Indexing (v0.4.1)
-- ============================================================================

ALTER TABLE sites ADD COLUMN tenant_id UUID;
ALTER TABLE missions ADD COLUMN tenant_id UUID;
ALTER TABLE check_ins ADD COLUMN tenant_id UUID;
ALTER TABLE sync_conflicts ADD COLUMN tenant_id UUID;
ALTER TABLE sync_idempotency_keys ADD COLUMN tenant_id UUID;

UPDATE sites SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id IS NULL;
UPDATE missions SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id IS NULL;
UPDATE check_ins SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id IS NULL;
UPDATE sync_conflicts SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id IS NULL;
UPDATE sync_idempotency_keys SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id IS NULL;

ALTER TABLE sites ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE missions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE check_ins ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sync_conflicts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sync_idempotency_keys ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE sites ADD CONSTRAINT sites_id_tenant_id_key UNIQUE (id, tenant_id);
ALTER TABLE missions ADD CONSTRAINT missions_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_site_id_fkey;
ALTER TABLE check_ins DROP CONSTRAINT IF EXISTS check_ins_mission_id_fkey;

ALTER TABLE missions
  ADD CONSTRAINT fk_missions_site_tenant
  FOREIGN KEY (site_id, tenant_id)
  REFERENCES sites (id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE check_ins
  ADD CONSTRAINT fk_check_ins_mission_tenant
  FOREIGN KEY (mission_id, tenant_id)
  REFERENCES missions (id, tenant_id)
  ON DELETE CASCADE;

DROP INDEX IF EXISTS sites_sync_seq_idx;
DROP INDEX IF EXISTS missions_sync_seq_idx;
DROP INDEX IF EXISTS check_ins_sync_seq_idx;

CREATE INDEX sites_tenant_sync_seq_idx ON sites (tenant_id, sync_seq ASC);
CREATE INDEX missions_tenant_sync_seq_idx ON missions (tenant_id, sync_seq ASC);
CREATE INDEX check_ins_tenant_sync_seq_idx ON check_ins (tenant_id, sync_seq ASC);

CREATE INDEX sync_conflicts_tenant_status_idx ON sync_conflicts (tenant_id, status);

ALTER TABLE sync_idempotency_keys
  DROP CONSTRAINT IF EXISTS sync_idempotency_keys_agent_id_idempotency_key_key;

CREATE UNIQUE INDEX sync_idempotency_keys_tenant_agent_key_idx
  ON sync_idempotency_keys (tenant_id, agent_id, idempotency_key);

-- ============================================================================
-- TRIGGER TEMPORAIRE : pose tenant_id par defaut si absent
-- A SUPPRIMER en v0.4.1c quand le code posera tenantId explicitement
-- ============================================================================

CREATE OR REPLACE FUNCTION set_default_tenant_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sites_default_tenant
  BEFORE INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION set_default_tenant_id();

CREATE TRIGGER trg_missions_default_tenant
  BEFORE INSERT ON missions
  FOR EACH ROW EXECUTE FUNCTION set_default_tenant_id();

CREATE TRIGGER trg_check_ins_default_tenant
  BEFORE INSERT ON check_ins
  FOR EACH ROW EXECUTE FUNCTION set_default_tenant_id();

CREATE TRIGGER trg_sync_conflicts_default_tenant
  BEFORE INSERT ON sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION set_default_tenant_id();

CREATE TRIGGER trg_sync_idempotency_keys_default_tenant
  BEFORE INSERT ON sync_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_default_tenant_id();

COMMIT;