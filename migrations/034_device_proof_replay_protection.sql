-- 034: shared, tenant-scoped replay protection for device proofs.
-- Nonces are immutable for the application role. Expired rows are removed only
-- by an administrative maintenance path, never by sync_app.
BEGIN;

CREATE TABLE public.device_proof_nonces (
  tenant_id UUID NOT NULL,
  device_id UUID NOT NULL,
  jti UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT pk_device_proof_nonces
    PRIMARY KEY (tenant_id, device_id, jti),
  CONSTRAINT fk_device_proof_nonces_device_tenant
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES public.devices (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_device_proof_nonces_expires_at
  ON public.device_proof_nonces USING btree (expires_at);

ALTER TABLE public.device_proof_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_proof_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY device_proof_nonces_tenant_isolation
  ON public.device_proof_nonces
  FOR ALL
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

REVOKE ALL ON TABLE public.device_proof_nonces FROM PUBLIC, sync_app;
GRANT SELECT, INSERT ON TABLE public.device_proof_nonces TO sync_app;

COMMIT;
