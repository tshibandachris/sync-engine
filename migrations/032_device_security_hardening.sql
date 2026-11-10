-- 032: harden device approval, credential lifecycle and audit retention.
-- This migration intentionally leaves sync_app with no approval or credential
-- write path until a verified server-side approval/PoP service exists.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Least-privilege writes for devices and credentials
-- ---------------------------------------------------------------------------

-- Device enrollment is the only current write path. It may create operational
-- fields, but it must not choose approval state or approval decision metadata.
REVOKE INSERT, UPDATE, DELETE ON TABLE devices FROM sync_app;
GRANT INSERT (
  id,
  tenant_id,
  store_id,
  pos_profile_id,
  name,
  fingerprint,
  hardware_info,
  is_active,
  created_at
) ON TABLE devices TO sync_app;

-- SELECT remains granted by the existing role setup and is still RLS-scoped.
-- No credential service with cryptographic proof-of-possession exists yet.
REVOKE INSERT, UPDATE, DELETE ON TABLE device_credentials FROM sync_app;

-- No event-writing service exists yet; the application role is read-only.
REVOKE INSERT, UPDATE, DELETE ON TABLE device_approval_events FROM sync_app;

-- ---------------------------------------------------------------------------
-- 2. Irreversible credential revocation (defense in depth)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_enforce_credential_revocation_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD: revoked credentials are read-only history'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'revoked' AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credential_lifecycle_lock ON public.device_credentials;
CREATE TRIGGER trg_credential_lifecycle_lock
  BEFORE UPDATE ON public.device_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_credential_revocation_lock();

-- ---------------------------------------------------------------------------
-- 3. Coherent event transitions
-- ---------------------------------------------------------------------------

ALTER TABLE public.device_approval_events
  ADD CONSTRAINT chk_event_transition_lifecycle
  CHECK (
    (event_type = 'requested'
      AND from_status IS NULL
      AND to_status = 'pending_approval')
    OR
    (event_type = 'approved'
      AND from_status IN ('pending_approval', 'rejected')
      AND to_status = 'approved')
    OR
    (event_type = 'rejected'
      AND from_status = 'pending_approval'
      AND to_status = 'rejected')
    OR
    (event_type = 'revoked'
      AND from_status = 'approved'
      AND to_status = 'revoked')
    OR
    (event_type = 'reactivated'
      AND from_status = 'revoked'
      AND to_status = 'approved')
  );

-- ---------------------------------------------------------------------------
-- 4. Preserve audit history when devices or tenants are deleted
-- ---------------------------------------------------------------------------

-- Exact constraint name established by migration 031.
ALTER TABLE public.device_approval_events
  DROP CONSTRAINT IF EXISTS fk_device_approval_events_device_tenant;
ALTER TABLE public.device_approval_events
  ADD CONSTRAINT fk_device_approval_events_device_tenant
  FOREIGN KEY (tenant_id, device_id)
  REFERENCES public.devices (tenant_id, id)
  ON DELETE RESTRICT;

-- The single-column tenant FK was generated from the inline REFERENCES clause
-- in migration 031.
ALTER TABLE public.device_approval_events
  DROP CONSTRAINT IF EXISTS device_approval_events_tenant_id_fkey;
ALTER TABLE public.device_approval_events
  ADD CONSTRAINT fk_device_approval_events_tenant
  FOREIGN KEY (tenant_id)
  REFERENCES public.tenants (id)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 5. Backfill only the missing initial request event
-- ---------------------------------------------------------------------------

INSERT INTO public.device_approval_events (
  tenant_id,
  device_id,
  event_type,
  from_status,
  to_status,
  actor_id,
  reason,
  created_at
)
SELECT
  d.tenant_id,
  d.id,
  'requested',
  NULL,
  'pending_approval',
  NULL,
  'Migration 032 backfill: initial device state tracking',
  COALESCE(d.created_at, clock_timestamp())
FROM public.devices AS d
WHERE d.approval_status = 'pending_approval'
  AND NOT EXISTS (
    SELECT 1
    FROM public.device_approval_events AS e
    WHERE e.tenant_id = d.tenant_id
      AND e.device_id = d.id
      AND e.event_type = 'requested'
      AND e.from_status IS NULL
      AND e.to_status = 'pending_approval'
  );

COMMIT;
