-- 013 : dénormalise check_ins.site_id pour qu'un site reste dans le pull
-- tant qu'un check-in historique y renvoie, même après réaffectation de la mission.
ALTER TABLE check_ins ADD COLUMN site_id UUID;

-- Le trigger réassigne sync_seq sur UPDATE : sans DISABLE, le backfill ferait
-- ressortir tous les check-ins existants au prochain pull de chaque client.
ALTER TABLE check_ins DISABLE TRIGGER trg_check_ins_incremental_sync;

-- Backfill approximatif : site COURANT de la mission. Faux pour les check-ins
-- antérieurs à une réaffectation (dette connue, voir HANDOFF.md).
DO $$
DECLARE
  updated_count bigint;
  remaining bigint;
BEGIN
  UPDATE check_ins ci
  SET site_id = m.site_id
  FROM missions m
  WHERE m.id = ci.mission_id
    AND m.tenant_id = ci.tenant_id
    AND ci.site_id IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  SELECT count(*) INTO remaining
  FROM check_ins ci
  JOIN missions m ON m.id = ci.mission_id AND m.tenant_id = ci.tenant_id
  WHERE ci.site_id IS NULL AND m.site_id IS NOT NULL;

  RAISE NOTICE '013 backfill : % lignes mises à jour, % sans site_id', updated_count, remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION '013 : backfill incomplet (RLS FORCE ?), % check-ins sans site_id', remaining;
  END IF;
END $$;

ALTER TABLE check_ins ENABLE TRIGGER trg_check_ins_incremental_sync;

CREATE INDEX idx_check_ins_agent_site ON check_ins (tenant_id, agent_id, site_id);