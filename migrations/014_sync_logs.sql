-- Sync operation log. One row per /sync/* request that reached the
-- controller, with the timing, the counts, and the outcome.
--
-- Written by an interceptor after the response is produced (or after an
-- exception is thrown). Never blocks or rolls back the operation: a log
-- write failure is logged to stderr, not propagated.
--
-- Retention: 30 days. Purged by a job modelled on
-- purge_tenant_tombstones (migration 009). Documented in HANDOFF.md.

CREATE TABLE sync_logs (
  id             UUID    PRIMARY KEY,
  request_id     UUID    NOT NULL,
  tenant_id      UUID    NOT NULL,
  agent_id       UUID,
  operation      TEXT    NOT NULL,
  status_code    BIGINT  NOT NULL,
  started_at     BIGINT  NOT NULL,
  duration_ms    BIGINT  NOT NULL,
  records_in     BIGINT  NOT NULL DEFAULT 0,
  records_out    BIGINT  NOT NULL DEFAULT 0,
  conflicts      BIGINT  NOT NULL DEFAULT 0,
  errors         BIGINT  NOT NULL DEFAULT 0,
  idempotency    TEXT,
  schema_version TEXT,
  error_code     TEXT
);

CREATE INDEX idx_sync_logs_tenant_time ON sync_logs (tenant_id, started_at DESC);
CREATE INDEX idx_sync_logs_agent_time  ON sync_logs (agent_id, started_at DESC);

-- Same isolation as the rest: the app can only write and read its own
-- tenant's logs. Cross-tenant queries go through a superuser or an ops
-- role, not through sync_app.
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_sync_logs ON sync_logs
  FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON sync_logs TO sync_app;
