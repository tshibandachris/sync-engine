-- 024_inventory_counts.sql
-- POS domain: physical counts. Application completes a count and inserts one
-- adjustment movement per non-zero difference in the same transaction.

BEGIN;

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_progress', 'completed', 'cancelled')),
  started_at bigint NOT NULL,
  completed_at bigint,
  started_by uuid NOT NULL,
  completed_by uuid,
  notes varchar(500),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,

  CONSTRAINT inventory_counts_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT inventory_counts_started_by_same_tenant
    FOREIGN KEY (tenant_id, started_by)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_counts_completed_by_same_tenant
    FOREIGN KEY (tenant_id, completed_by)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_counts_completion_consistent CHECK (
    (status IN ('draft', 'in_progress', 'cancelled')
      AND completed_at IS NULL AND completed_by IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_inventory_counts_one_active
  ON inventory_counts (tenant_id)
  WHERE status IN ('draft', 'in_progress');
CREATE INDEX idx_inventory_counts_tenant_started
  ON inventory_counts (tenant_id, started_at DESC);
CREATE INDEX idx_inventory_counts_sync_seq
  ON inventory_counts (tenant_id, sync_seq);

CREATE TRIGGER inventory_counts_set_sync_fields
  BEFORE INSERT OR UPDATE ON inventory_counts
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

ALTER TABLE inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_counts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TABLE inventory_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inventory_count_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name varchar(200) NOT NULL,
  theoretical_qty integer NOT NULL,
  counted_qty integer,
  difference integer,
  counted_at bigint,
  counted_by uuid,
  notes varchar(200),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,

  CONSTRAINT inventory_count_lines_count_same_tenant
    FOREIGN KEY (tenant_id, inventory_count_id)
    REFERENCES inventory_counts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT inventory_count_lines_product_same_tenant
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_count_lines_staff_same_tenant
    FOREIGN KEY (tenant_id, counted_by)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_count_lines_counted_consistent CHECK (
    (counted_qty IS NULL AND difference IS NULL AND counted_at IS NULL AND counted_by IS NULL)
    OR
    (counted_qty IS NOT NULL AND difference IS NOT NULL AND counted_at IS NOT NULL AND counted_by IS NOT NULL)
  ),
  CONSTRAINT inventory_count_lines_difference_consistent
    CHECK (difference IS NULL OR difference = counted_qty - theoretical_qty)
);

CREATE UNIQUE INDEX idx_inventory_count_lines_unique
  ON inventory_count_lines (tenant_id, inventory_count_id, product_id);
CREATE INDEX idx_inventory_count_lines_count
  ON inventory_count_lines (tenant_id, inventory_count_id);
CREATE INDEX idx_inventory_count_lines_sync_seq
  ON inventory_count_lines (tenant_id, sync_seq);

CREATE TRIGGER inventory_count_lines_set_sync_fields
  BEFORE INSERT OR UPDATE ON inventory_count_lines
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

ALTER TABLE inventory_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_count_lines
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
