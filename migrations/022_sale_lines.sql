-- 022_sale_lines.sql
-- POS domain: immutable sale lines; product labels are snapshots from sale time.

BEGIN;

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name varchar(200) NOT NULL,
  product_sku varchar(64),
  quantity integer NOT NULL,
  unit_price integer NOT NULL,
  subtotal integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,

  CONSTRAINT sale_lines_sale_same_tenant
    FOREIGN KEY (tenant_id, sale_id)
    REFERENCES sales (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_lines_product_same_tenant
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_lines_quantity_nonzero CHECK (quantity <> 0),
  CONSTRAINT sale_lines_unit_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT sale_lines_subtotal_consistent CHECK (subtotal = quantity * unit_price)
);

CREATE INDEX idx_sale_lines_sale ON sale_lines (tenant_id, sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines (tenant_id, product_id);
CREATE INDEX idx_sale_lines_sync_seq ON sale_lines (tenant_id, sync_seq);

CREATE TRIGGER sale_lines_set_sync_fields
  BEFORE INSERT ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();
CREATE TRIGGER sale_lines_forbid_update
  BEFORE UPDATE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_lines_forbid_delete
  BEFORE DELETE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_lines
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
