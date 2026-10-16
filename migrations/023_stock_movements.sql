-- 023_stock_movements.sql
-- POS domain: immutable stock movement ledger; stock is SUM(quantity_delta).

BEGIN;

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  movement_type varchar(20) NOT NULL CHECK (movement_type IN (
    'sale', 'void', 'restock', 'loss', 'adjustment', 'return'
  )),
  quantity_delta integer NOT NULL,
  reference_id uuid,
  reference_type varchar(30),
  unit_cost integer,
  notes varchar(500),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  created_by uuid,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,

  CONSTRAINT stock_movements_product_same_tenant
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movements_staff_same_tenant
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movements_delta_nonzero CHECK (quantity_delta <> 0),
  CONSTRAINT stock_movements_sign_consistent CHECK (
    (movement_type = 'sale' AND quantity_delta < 0)
    OR (movement_type = 'void' AND quantity_delta > 0)
    OR (movement_type = 'restock' AND quantity_delta > 0)
    OR (movement_type = 'loss' AND quantity_delta < 0)
    OR (movement_type = 'adjustment')
    OR (movement_type = 'return' AND quantity_delta > 0)
  ),
  CONSTRAINT stock_movements_reference_required CHECK (
    (movement_type IN ('sale', 'void', 'adjustment')
      AND reference_id IS NOT NULL AND reference_type IS NOT NULL)
    OR movement_type IN ('restock', 'loss', 'return')
  ),
  CONSTRAINT stock_movements_reference_pair CHECK (
    (reference_id IS NULL AND reference_type IS NULL)
    OR (reference_id IS NOT NULL AND reference_type IS NOT NULL)
  ),
  CONSTRAINT stock_movements_unit_cost_nonnegative CHECK (unit_cost IS NULL OR unit_cost >= 0)
);

CREATE INDEX idx_stock_movements_product_time
  ON stock_movements (tenant_id, product_id, created_at DESC);
CREATE INDEX idx_stock_movements_reference
  ON stock_movements (tenant_id, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;
CREATE INDEX idx_stock_movements_sync_seq
  ON stock_movements (tenant_id, sync_seq);

CREATE TRIGGER stock_movements_set_sync_fields
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();
CREATE TRIGGER stock_movements_forbid_update
  BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movements_forbid_delete
  BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
