-- 031: additive foundation for server-side device approval and credentials.
-- Existing devices are deliberately backfilled as pending_approval. The legacy
-- is_active flag is operational metadata and is NOT evidence of approval.
BEGIN;

ALTER TABLE devices
  ADD COLUMN approval_status varchar(24) NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid,
  ADD COLUMN approval_note varchar(500),
  ADD CONSTRAINT devices_approval_status_check
    CHECK (approval_status IN ('pending_approval', 'approved', 'rejected', 'revoked')),
  ADD CONSTRAINT devices_approval_decision_consistency
    CHECK (
      (approval_status IN ('approved', 'revoked')
        AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
      OR
      (approval_status IN ('pending_approval', 'rejected')
        AND approved_at IS NULL AND approved_by IS NULL)
    ),
  ADD CONSTRAINT devices_tenant_id_unique UNIQUE (tenant_id, id);

CREATE INDEX idx_devices_tenant_approval_status
  ON devices (tenant_id, approval_status, created_at DESC);

-- A terminal may rotate credentials, but only one credential may be active.
-- Revoked public keys remain as history and must never become active again.
CREATE TABLE device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  algorithm varchar(16) NOT NULL DEFAULT 'ES256',
  public_key_pem text NOT NULL,
  key_thumbprint varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT device_credentials_algorithm_check
    CHECK (algorithm = 'ES256'),
  CONSTRAINT device_credentials_public_key_not_empty
    CHECK (length(trim(public_key_pem)) > 0),
  CONSTRAINT device_credentials_thumbprint_not_empty
    CHECK (length(trim(key_thumbprint)) > 0),
  CONSTRAINT device_credentials_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT device_credentials_revocation_consistency
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    ),
  CONSTRAINT fk_device_credentials_device_tenant
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT device_credentials_tenant_thumbprint_unique
    UNIQUE (tenant_id, key_thumbprint)
);

CREATE UNIQUE INDEX device_credentials_one_active_per_device
  ON device_credentials (tenant_id, device_id)
  WHERE status = 'active';

CREATE INDEX idx_device_credentials_tenant_device
  ON device_credentials (tenant_id, device_id, created_at DESC);

CREATE TABLE device_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  actor_id uuid,
  event_type varchar(24) NOT NULL,
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  reason varchar(500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_approval_events_type_check
    CHECK (event_type IN ('requested', 'approved', 'rejected', 'revoked', 'reactivated')),
  CONSTRAINT device_approval_events_status_check
    CHECK (
      to_status IN ('pending_approval', 'approved', 'rejected', 'revoked')
      AND (from_status IS NULL OR from_status IN ('pending_approval', 'approved', 'rejected', 'revoked'))
    ),
  CONSTRAINT device_approval_events_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT fk_device_approval_events_device_tenant
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_device_approval_events_tenant_device
  ON device_approval_events (tenant_id, device_id, created_at DESC);

-- RLS is fail-closed when app.current_tenant_id is absent.
ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_credentials ON device_credentials
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE device_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_approval_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_approval_events ON device_approval_events
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Default privileges from migration 011 are broad; narrow the new tables.
GRANT SELECT, INSERT, UPDATE ON device_credentials TO sync_app;
REVOKE DELETE ON device_credentials FROM sync_app;
GRANT SELECT, INSERT ON device_approval_events TO sync_app;
REVOKE UPDATE, DELETE ON device_approval_events FROM sync_app;

COMMIT;
