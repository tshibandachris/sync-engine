-- 024_pos_reconciliation.sql
-- Reconciliation is a derived view; historical close fields remain immutable.

BEGIN;

ALTER TABLE cash_sessions
  ADD COLUMN IF NOT EXISTS reconciled_expected_amount integer,
  ADD COLUMN IF NOT EXISTS reconciled_difference integer,
  ADD COLUMN IF NOT EXISTS reconciled_at bigint,
  ADD COLUMN IF NOT EXISTS reconciliation_alert boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_alert_reason varchar(32);

ALTER TABLE cash_sessions
  DROP CONSTRAINT IF EXISTS cash_sessions_reconciliation_alert_reason_check;
ALTER TABLE cash_sessions
  ADD CONSTRAINT cash_sessions_reconciliation_alert_reason_check
  CHECK (reconciliation_alert_reason IS NULL OR reconciliation_alert_reason IN
    ('missing_sales', 'late_sales', 'amount_mismatch', 'no_sales_received'));

COMMIT;
