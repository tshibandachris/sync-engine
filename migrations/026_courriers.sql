-- 026_courriers.sql
-- Courrier domain: tenant-isolated correspondence records.
-- agent_id is the authenticated actor/creator UUID from the identity provider;
-- it intentionally has no FK to a local auth table because the current backend
-- obtains agent identity from the validated JWT.
-- Uses the same incremental-sync sequence contract as the existing POS tables.

BEGIN;

CREATE TABLE courriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  subject varchar(200) NOT NULL,
  body text NOT NULL DEFAULT '',
  confidentiality varchar(20) NOT NULL DEFAULT 'interne'
    CHECK (confidentiality IN ('public', 'interne', 'confidentiel', 'secret')),
  status varchar(20) NOT NULL DEFAULT 'enregistre'
    CHECK (status IN ('enregistre', 'affecte', 'en_cours', 'repondu', 'clos', 'archive')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,
  CONSTRAINT courriers_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX idx_courriers_tenant ON courriers (tenant_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_courriers_tenant_agent ON courriers (tenant_id, agent_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_courriers_tenant_confidentiality ON courriers (tenant_id, confidentiality, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_courriers_sync_seq ON courriers (tenant_id, sync_seq);

CREATE TRIGGER courriers_set_sync_fields
  BEFORE INSERT OR UPDATE ON courriers
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

-- FORCE also applies RLS to the table owner (superusers/BYPASSRLS roles still
-- bypass RLS by PostgreSQL design; runtime connections must use a non-bypass role).
ALTER TABLE courriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE courriers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_courriers ON courriers
  FOR ALL
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

COMMIT;
