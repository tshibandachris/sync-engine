BEGIN;

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  check_in_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  uploaded_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_object_key_idx
  ON attachments (object_key);

CREATE INDEX IF NOT EXISTS attachments_tenant_check_in_idx
  ON attachments (tenant_id, check_in_id);

CREATE INDEX IF NOT EXISTS attachments_tenant_status_idx
  ON attachments (tenant_id, status);

ALTER TABLE check_ins
  ADD CONSTRAINT check_ins_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE attachments
  ADD CONSTRAINT fk_attachments_check_in_tenant
  FOREIGN KEY (check_in_id, tenant_id)
  REFERENCES check_ins (id, tenant_id)
  ON DELETE CASCADE;

COMMIT;
