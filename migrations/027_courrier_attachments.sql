-- 027_courrier_attachments.sql
-- Metadata for S3-backed files attached to correspondence records.
BEGIN;

CREATE TABLE courrier_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  courrier_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type varchar(100) NOT NULL
    CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded')),
  created_at bigint NOT NULL,
  uploaded_at bigint,
  CONSTRAINT fk_courrier_attachments_courrier_tenant
    FOREIGN KEY (tenant_id, courrier_id)
    REFERENCES courriers(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_courrier_attachments_tenant_courrier
  ON courrier_attachments (tenant_id, courrier_id, created_at DESC);

ALTER TABLE courrier_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE courrier_attachments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_courrier_attachments ON courrier_attachments
  FOR ALL
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

COMMIT;
