-- 028_courrier_workflow_and_audit.sql
-- Tenant-isolated assignments and append-only audit trail for Courrier.
BEGIN;

CREATE TABLE courrier_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  courrier_id uuid NOT NULL,
  agent_id uuid,
  service_id uuid,
  assigned_by uuid NOT NULL,
  assigned_at bigint NOT NULL,
  revoked_at bigint,
  CONSTRAINT courrier_assignments_exactly_one_target
    CHECK ((agent_id IS NOT NULL AND service_id IS NULL)
        OR (agent_id IS NULL AND service_id IS NOT NULL)),
  CONSTRAINT fk_courrier_assignments_courrier_tenant
    FOREIGN KEY (tenant_id, courrier_id)
    REFERENCES courriers(tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX courrier_assignments_active_agent_unique
  ON courrier_assignments (tenant_id, courrier_id, agent_id)
  WHERE agent_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX courrier_assignments_active_service_unique
  ON courrier_assignments (tenant_id, courrier_id, service_id)
  WHERE service_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_courrier_assignments_tenant_courrier
  ON courrier_assignments (tenant_id, courrier_id, assigned_at DESC);

CREATE TABLE courrier_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  courrier_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action varchar(80) NOT NULL,
  from_status varchar(20),
  to_status varchar(20),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL,
  CONSTRAINT fk_courrier_audit_logs_courrier_tenant
    FOREIGN KEY (tenant_id, courrier_id)
    REFERENCES courriers(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_courrier_audit_logs_tenant_courrier
  ON courrier_audit_logs (tenant_id, courrier_id, created_at DESC);

ALTER TABLE courrier_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE courrier_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_courrier_assignments ON courrier_assignments
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE courrier_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE courrier_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_courrier_audit_logs ON courrier_audit_logs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Runtime access: assignment lifecycle is mutable; audit history is append-only.
GRANT SELECT, INSERT, UPDATE ON courrier_assignments TO sync_app;
GRANT SELECT, INSERT ON courrier_audit_logs TO sync_app;

COMMIT;
