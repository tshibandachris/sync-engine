-- 016 : registre des tenants, pour que la maintenance (purges) sache quels tenants parcourir.
--
-- Toutes les autres tables sont en FORCE ROW LEVEL SECURITY : sans contexte tenant, elles
-- n'exposent aucune ligne, donc aucune d'elles ne peut servir à lister les tenants.
-- Cette table n'a PAS de RLS, volontairement.
BEGIN;

CREATE TABLE tenants (
  id            UUID   PRIMARY KEY,
  first_seen_at BIGINT NOT NULL
);

-- Les privilèges par défaut de la migration 011 donnent SELECT/INSERT/UPDATE/DELETE à
-- sync_app sur toute nouvelle table : on repart de zéro. Inscription seule, pas de
-- modification ni de suppression.
REVOKE ALL ON tenants FROM PUBLIC, sync_app;
GRANT SELECT, INSERT ON tenants TO sync_app;

-- Backfill au mieux. Si le rôle des migrations est soumis à FORCE ROW LEVEL SECURITY, il ne
-- voit aucune ligne et n'insère rien : l'inscription automatique rattrape les tenants actifs.
-- first_seen_at = date de la migration pour les tenants rattrapés ici (approximatif).
DO $$
DECLARE
  registered BIGINT;
BEGIN
  INSERT INTO tenants (id, first_seen_at)
  SELECT t, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
  FROM (
    SELECT tenant_id AS t FROM sites
    UNION SELECT tenant_id FROM missions
    UNION SELECT tenant_id FROM check_ins
    UNION SELECT tenant_id FROM sync_conflicts
    UNION SELECT tenant_id FROM sync_purge_state
    UNION SELECT tenant_id FROM sync_logs
  ) s
  WHERE t IS NOT NULL
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS registered = ROW_COUNT;

  RAISE NOTICE '016 backfill : % tenant(s) enregistré(s)', registered;
END $$;

COMMIT;
