-- 020_cash_sessions.sql
-- POS domain: cash register sessions. Closed sessions remain as audit history.

BEGIN;

CREATE TABLE cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL,
  terminal_label varchar(40),
  opened_at bigint NOT NULL,
  closed_at bigint,
  opening_amount integer NOT NULL CHECK (opening_amount >= 0),
  closing_amount integer CHECK (closing_amount IS NULL OR closing_amount >= 0),
  expected_amount integer CHECK (expected_amount IS NULL OR expected_amount >= 0),
  difference integer,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  notes varchar(500),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sync_seq bigint NOT NULL,
  first_sync_seq bigint NOT NULL,
  CONSTRAINT cash_sessions_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cash_sessions_close_after_open
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT cash_sessions_closed_consistency
    CHECK (
      (status = 'open'
        AND closed_at IS NULL
        AND closing_amount IS NULL
        AND expected_amount IS NULL
        AND difference IS NULL)
      OR
      (status = 'closed'
        AND closed_at IS NOT NULL
        AND closing_amount IS NOT NULL
        AND expected_amount IS NOT NULL
        AND difference IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_cash_sessions_one_open_per_staff
  ON cash_sessions (tenant_id, staff_id)
  WHERE status = 'open';
CREATE INDEX idx_cash_sessions_tenant_opened
  ON cash_sessions (tenant_id, opened_at DESC);
CREATE INDEX idx_cash_sessions_staff_status
  ON cash_sessions (tenant_id, staff_id, status);
CREATE INDEX idx_cash_sessions_sync_seq
  ON cash_sessions (tenant_id, sync_seq);

CREATE TRIGGER cash_sessions_set_sync_fields
  BEFORE INSERT OR UPDATE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION set_sync_fields();

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cash_sessions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

COMMIT;
