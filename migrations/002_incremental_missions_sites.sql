BEGIN;

CREATE SEQUENCE IF NOT EXISTS global_sync_seq;

-- ============================================================
-- MISSIONS
-- ============================================================

ALTER TABLE missions ADD COLUMN IF NOT EXISTS created_at BIGINT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS updated_at BIGINT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS sync_seq BIGINT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS first_sync_seq BIGINT;

-- ============================================================
-- SITES
-- ============================================================

ALTER TABLE sites ADD COLUMN IF NOT EXISTS created_at BIGINT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS updated_at BIGINT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS sync_seq BIGINT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS first_sync_seq BIGINT;

-- ============================================================
-- CHECK_INS
-- first_sync_seq volontairement absent
-- ============================================================

ALTER TABLE check_ins ADD COLUMN IF NOT EXISTS sync_seq BIGINT;

-- ============================================================
-- INITIALISATION CHECK_INS
-- ============================================================

UPDATE check_ins
SET sync_seq = nextval('global_sync_seq')
WHERE sync_seq IS NULL;

-- ============================================================
-- RECALAGE DE LA SEQUENCE
-- ============================================================

SELECT setval(
    'global_sync_seq',
    GREATEST(
        COALESCE((SELECT MAX(sync_seq) FROM check_ins), 0),
        COALESCE((SELECT MAX(sync_seq) FROM missions), 0),
        COALESCE((SELECT MAX(sync_seq) FROM sites), 0),
        COALESCE((SELECT last_value FROM global_sync_seq), 0)
    ),
    true
);

-- ============================================================
-- INITIALISATION MISSIONS / SITES
-- ============================================================

UPDATE missions
SET
    sync_seq = nextval('global_sync_seq')
WHERE sync_seq IS NULL;

UPDATE sites
SET
    sync_seq = nextval('global_sync_seq')
WHERE sync_seq IS NULL;

-- ============================================================
-- FIRST SYNC SEQ
-- ============================================================

UPDATE missions
SET first_sync_seq = sync_seq
WHERE first_sync_seq IS NULL;

UPDATE sites
SET first_sync_seq = sync_seq
WHERE first_sync_seq IS NULL;

-- ============================================================
-- NOT NULL
-- ============================================================

ALTER TABLE missions
    ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE missions
    ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE missions
    ALTER COLUMN sync_seq SET NOT NULL;

ALTER TABLE missions
    ALTER COLUMN first_sync_seq SET NOT NULL;

ALTER TABLE sites
    ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE sites
    ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE sites
    ALTER COLUMN sync_seq SET NOT NULL;

ALTER TABLE sites
    ALTER COLUMN first_sync_seq SET NOT NULL;

ALTER TABLE check_ins
    ALTER COLUMN sync_seq SET NOT NULL;

-- ============================================================
-- TRIGGER MISSIONS / SITES
-- ============================================================

CREATE OR REPLACE FUNCTION sync_missions_sites_seq()
RETURNS TRIGGER AS $$
DECLARE
    now_ms BIGINT;
BEGIN
    now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;

    NEW.sync_seq := nextval('global_sync_seq');
    NEW.updated_at := now_ms;

    IF TG_OP = 'INSERT' THEN
        NEW.first_sync_seq := NEW.sync_seq;
        NEW.created_at := COALESCE(NEW.created_at, now_ms);
    ELSE
        NEW.first_sync_seq := OLD.first_sync_seq;
        NEW.created_at := OLD.created_at;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGER CHECK_INS
-- ============================================================

CREATE OR REPLACE FUNCTION sync_check_ins_seq()
RETURNS TRIGGER AS $$
BEGIN
    NEW.sync_seq := nextval('global_sync_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS trg_missions_incremental_sync ON missions;
DROP TRIGGER IF EXISTS trg_sites_incremental_sync ON sites;
DROP TRIGGER IF EXISTS trg_check_ins_incremental_sync ON check_ins;

CREATE TRIGGER trg_missions_incremental_sync
BEFORE INSERT OR UPDATE ON missions
FOR EACH ROW
EXECUTE FUNCTION sync_missions_sites_seq();

CREATE TRIGGER trg_sites_incremental_sync
BEFORE INSERT OR UPDATE ON sites
FOR EACH ROW
EXECUTE FUNCTION sync_missions_sites_seq();

CREATE TRIGGER trg_check_ins_incremental_sync
BEFORE INSERT OR UPDATE ON check_ins
FOR EACH ROW
EXECUTE FUNCTION sync_check_ins_seq();

-- ============================================================
-- INDEX
-- ============================================================

CREATE INDEX IF NOT EXISTS missions_agent_sync_seq_idx
ON missions(agent_id, sync_seq);

CREATE INDEX IF NOT EXISTS sites_sync_seq_idx
ON sites(sync_seq);

CREATE INDEX IF NOT EXISTS check_ins_agent_sync_seq_idx
ON check_ins(agent_id, sync_seq);

COMMIT;