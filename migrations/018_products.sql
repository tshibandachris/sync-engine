-- 018_products.sql
-- POS domain: tenant-scoped product catalog.
-- IDs may be supplied by offline clients; gen_random_uuid() is only a fallback.
-- The shared sync sequence and trigger keep this table on the existing incremental-sync protocol.

BEGIN;

CREATE OR REPLACE FUNCTION set_sync_fields()
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

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  sku varchar(64),
  barcode varchar(64),
  category varchar(80),
  price integer NOT NULL CHECK (price >= 0),
  cost integer CHECK (cost IS NULL OR cost >= 0),
  stock_alert integer NOT NULL DEFAULT 5 CHECK (stock_alert >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,
  CONSTRAINT products_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX idx_products_tenant ON products (tenant_id);
CREATE INDEX idx_products_sku ON products (tenant_id, sku)
  WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_products_barcode ON products (tenant_id, barcode)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_products_tenant_active ON products (tenant_id, is_active)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_products_sync_seq ON products (tenant_id, sync_seq);

CREATE TRIGGER products_set_sync_fields
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON products
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
