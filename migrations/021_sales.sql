-- 021_sales.sql
-- POS domain: immutable sales ledger. Corrections are mirror void sales.

BEGIN;

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cash_session_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  sale_number varchar(32) NOT NULL,
  total integer NOT NULL,
  payment_method varchar(20) NOT NULL CHECK (payment_method IN ('cash', 'mobile_money', 'mixed')),
  cash_amount integer NOT NULL DEFAULT 0,
  mobile_amount integer NOT NULL DEFAULT 0,
  mobile_msisdn varchar(20),
  mobile_reference varchar(64),
  customer_note varchar(200),
  is_void boolean NOT NULL DEFAULT false,
  voided_sale_id uuid,
  void_reason varchar(200),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,

  CONSTRAINT sales_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT sales_session_same_tenant
    FOREIGN KEY (tenant_id, cash_session_id)
    REFERENCES cash_sessions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_void_same_tenant
    FOREIGN KEY (tenant_id, voided_sale_id)
    REFERENCES sales (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT sales_total_consistent
    CHECK (total = cash_amount + mobile_amount),
  CONSTRAINT sales_total_sign
    CHECK (
      (is_void = false AND total >= 0 AND cash_amount >= 0 AND mobile_amount >= 0)
      OR
      (is_void = true AND total <= 0 AND cash_amount <= 0 AND mobile_amount <= 0)
    ),
  CONSTRAINT sales_payment_method_consistent
    CHECK (
      (payment_method = 'cash' AND mobile_amount = 0)
      OR (payment_method = 'mobile_money' AND cash_amount = 0)
      OR (payment_method = 'mixed' AND cash_amount <> 0 AND mobile_amount <> 0)
    ),
  CONSTRAINT sales_void_reference
    CHECK (
      (is_void = false AND voided_sale_id IS NULL AND void_reason IS NULL)
      OR (is_void = true AND voided_sale_id IS NOT NULL AND void_reason IS NOT NULL)
    ),
  CONSTRAINT sales_void_not_self
    CHECK (voided_sale_id IS NULL OR voided_sale_id <> id),
  CONSTRAINT sales_mobile_requires_ref
    CHECK (
      mobile_amount = 0
      OR mobile_msisdn IS NOT NULL
      OR mobile_reference IS NOT NULL
    )
);

CREATE UNIQUE INDEX idx_sales_void_unique
  ON sales (tenant_id, voided_sale_id)
  WHERE is_void = true;
CREATE UNIQUE INDEX idx_sales_number_unique
  ON sales (tenant_id, sale_number);
CREATE INDEX idx_sales_session ON sales (tenant_id, cash_session_id);
CREATE INDEX idx_sales_staff ON sales (tenant_id, staff_id);
CREATE INDEX idx_sales_tenant_created ON sales (tenant_id, created_at DESC);
CREATE INDEX idx_sales_sync_seq ON sales (tenant_id, sync_seq);

CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sales_set_sync_fields
  BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();
CREATE TRIGGER sales_forbid_update
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sales_forbid_delete
  BEFORE DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
