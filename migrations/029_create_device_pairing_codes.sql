BEGIN;

CREATE TABLE device_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  pos_profile_id uuid,
  code_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT device_pairing_codes_hash_not_empty
    CHECK (length(code_hash) > 0),
  CONSTRAINT device_pairing_codes_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT device_pairing_codes_usage_after_creation
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX idx_device_pairing_codes_tenant_expiry
  ON device_pairing_codes (tenant_id, expires_at);

CREATE INDEX idx_device_pairing_codes_tenant_store
  ON device_pairing_codes (tenant_id, store_id);

COMMIT;
