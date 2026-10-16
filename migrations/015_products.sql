-- 015_products.sql
-- POS domain: tenant-scoped product catalog.
-- IDs may be supplied by offline clients; gen_random_uuid() is only a fallback.
-- Apply through the repository's existing migration runner, not drizzle-kit push.

BEGIN;

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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_products_tenant
  ON products (tenant_id);

CREATE INDEX idx_products_sku
  ON products (tenant_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX idx_products_barcode
  ON products (tenant_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX idx_products_tenant_active
  ON products (tenant_id, is_active)
  WHERE deleted_at IS NULL;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON products
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMIT;
