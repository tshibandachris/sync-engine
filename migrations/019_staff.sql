-- 019_staff.sql
-- POS domain: tenant-scoped staff (owners, managers, cashiers).
-- Business projection of a user, not an authentication table.
-- auth_subject may link to an external identity provider; local PINs are stored only as hashes.

BEGIN;

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_name varchar(120) NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  pin_hash varchar(255),
  auth_subject uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,
  CONSTRAINT staff_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX idx_staff_tenant ON staff (tenant_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_tenant_role ON staff (tenant_id, role)
  WHERE deleted_at IS NULL AND is_active = true;
CREATE UNIQUE INDEX idx_staff_auth_subject ON staff (auth_subject)
  WHERE auth_subject IS NOT NULL;
CREATE INDEX idx_staff_sync_seq ON staff (tenant_id, sync_seq);

CREATE TRIGGER staff_set_sync_fields
  BEFORE INSERT OR UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON staff
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
