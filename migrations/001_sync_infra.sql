-- SYNC ENGINE / 001_sync_infra
-- Global monotone cursor shared by all synchronized tables.

CREATE SEQUENCE IF NOT EXISTS global_sync_seq
  START WITH 1
  INCREMENT BY 1;

CREATE OR REPLACE FUNCTION bump_global_sync_seq()
RETURNS TRIGGER AS $$
BEGIN
  NEW.sync_seq := nextval('global_sync_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Existing synchronized tables are expected to exist before this migration.
ALTER TABLE check_ins
  ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT nextval('global_sync_seq');

ALTER TABLE missions
  ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT nextval('global_sync_seq');

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT nextval('global_sync_seq');

CREATE INDEX IF NOT EXISTS check_ins_sync_seq_idx ON check_ins (sync_seq);
CREATE INDEX IF NOT EXISTS missions_sync_seq_idx ON missions (sync_seq);
CREATE INDEX IF NOT EXISTS sites_sync_seq_idx ON sites (sync_seq);

DROP TRIGGER IF EXISTS trg_check_ins_sync_seq ON check_ins;
CREATE TRIGGER trg_check_ins_sync_seq
BEFORE INSERT OR UPDATE ON check_ins
FOR EACH ROW EXECUTE FUNCTION bump_global_sync_seq();

DROP TRIGGER IF EXISTS trg_missions_sync_seq ON missions;
CREATE TRIGGER trg_missions_sync_seq
BEFORE INSERT OR UPDATE ON missions
FOR EACH ROW EXECUTE FUNCTION bump_global_sync_seq();

DROP TRIGGER IF EXISTS trg_sites_sync_seq ON sites;
CREATE TRIGGER trg_sites_sync_seq
BEFORE INSERT OR UPDATE ON sites
FOR EACH ROW EXECUTE FUNCTION bump_global_sync_seq();

-- Idempotency records for repeated client pushes.
CREATE TABLE IF NOT EXISTS sync_idempotency_keys (
  agent_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, idempotency_key)
);
