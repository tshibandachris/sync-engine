-- Registered POS devices created by the one-time pairing flow.
BEGIN;

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  pos_profile_id uuid,
  name varchar(120) NOT NULL,
  fingerprint varchar(255) NOT NULL,
  hardware_info jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT devices_fingerprint_not_empty CHECK (length(trim(fingerprint)) > 0),
  CONSTRAINT devices_hardware_info_object CHECK (jsonb_typeof(hardware_info) = 'object'),
  CONSTRAINT devices_tenant_fingerprint_unique UNIQUE (tenant_id, fingerprint)
);

CREATE INDEX idx_devices_tenant_store ON devices (tenant_id, store_id);
CREATE INDEX idx_devices_tenant_active ON devices (tenant_id, is_active);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_devices ON devices
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON devices TO sync_app;

-- The unauthenticated enrollment request does not know its tenant yet, so
-- code redemption is exposed only through this narrow atomic SECURITY DEFINER
-- function instead of granting the API role direct access to pairing codes.
CREATE OR REPLACE FUNCTION public.redeem_device_pairing_code(p_code_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, store_id uuid, pos_profile_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS '
  UPDATE public.device_pairing_codes
  SET used_at = clock_timestamp()
  WHERE code_hash = p_code_hash
    AND used_at IS NULL
    AND expires_at > clock_timestamp()
  RETURNING device_pairing_codes.id,
            device_pairing_codes.tenant_id,
            device_pairing_codes.store_id,
            device_pairing_codes.pos_profile_id;
';
REVOKE ALL ON FUNCTION public.redeem_device_pairing_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_device_pairing_code(text) TO sync_app;

COMMIT;
