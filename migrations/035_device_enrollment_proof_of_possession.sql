-- 035: cryptographic proof-of-possession during device pairing.
-- The pairing code, device row, first ES256 credential and immutable audit
-- event are committed by one SECURITY DEFINER function. The sync_app role
-- receives no direct write privileges on credentials or approval events.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_device_enrollment_with_credential(
  p_code_hash text,
  p_expected_tenant_id uuid,
  p_device_id uuid,
  p_name varchar,
  p_fingerprint varchar,
  p_hardware_info jsonb,
  p_public_key_pem text,
  p_key_thumbprint varchar
)
RETURNS TABLE (
  result_device_id uuid,
  result_tenant_id uuid,
  result_store_id uuid,
  result_pos_profile_id uuid,
  result_device_name varchar,
  result_approval_status varchar,
  result_key_thumbprint varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_pairing public.device_pairing_codes%ROWTYPE;
  v_device public.devices%ROWTYPE;
BEGIN
  IF p_code_hash IS NULL OR length(p_code_hash) <> 64
     OR p_expected_tenant_id IS NULL OR p_device_id IS NULL
     OR p_name IS NULL OR length(trim(p_name)) = 0 OR length(p_name) > 120
     OR p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0 OR length(p_fingerprint) > 255
     OR p_hardware_info IS NULL OR jsonb_typeof(p_hardware_info) <> 'object'
     OR p_public_key_pem IS NULL OR length(p_public_key_pem) = 0 OR length(p_public_key_pem) > 4096
     OR p_key_thumbprint IS NULL OR length(p_key_thumbprint) <> 43 THEN
    RAISE EXCEPTION 'Invalid device enrollment arguments' USING ERRCODE = '22023';
  END IF;

  -- Atomic one-time pairing redemption, scoped to the authenticated agent's tenant.
  UPDATE public.device_pairing_codes AS pairing
     SET used_at = clock_timestamp()
   WHERE pairing.code_hash = p_code_hash
     AND pairing.tenant_id = p_expected_tenant_id
     AND pairing.used_at IS NULL
     AND pairing.expires_at > clock_timestamp()
  RETURNING pairing.* INTO v_pairing;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid, expired, consumed or cross-tenant pairing code'
      USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.current_tenant_id', v_pairing.tenant_id::text, true);

  INSERT INTO public.tenants (id, first_seen_at)
  VALUES (v_pairing.tenant_id, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.devices (
    id, tenant_id, store_id, pos_profile_id, name, fingerprint,
    hardware_info, is_active, approval_status, approved_at, approved_by, approval_note
  )
  VALUES (
    p_device_id, v_pairing.tenant_id, v_pairing.store_id, v_pairing.pos_profile_id,
    p_name, p_fingerprint, p_hardware_info, true, 'pending_approval', NULL, NULL, NULL
  )
  RETURNING * INTO v_device;

  INSERT INTO public.device_credentials (
    tenant_id, device_id, algorithm, public_key_pem, key_thumbprint, status
  )
  VALUES (
    v_pairing.tenant_id, p_device_id, 'ES256', p_public_key_pem, p_key_thumbprint, 'active'
  );

  INSERT INTO public.device_approval_events (
    tenant_id, device_id, actor_id, event_type, from_status, to_status, reason, metadata
  )
  VALUES (
    v_pairing.tenant_id, p_device_id, v_pairing.created_by,
    'requested', NULL, 'pending_approval',
    'Device enrollment with ES256 proof of possession',
    jsonb_build_object('key_thumbprint', p_key_thumbprint, 'algorithm', 'ES256')
  );

  RETURN QUERY SELECT v_device.id, v_device.tenant_id, v_device.store_id,
                      v_device.pos_profile_id, v_device.name,
                      v_device.approval_status, p_key_thumbprint;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar) TO sync_app;

-- Enrollment is now exclusively mediated by the credential-aware function.
-- No direct device INSERT is needed by the application role.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.devices FROM sync_app;

-- Close the older SECURITY DEFINER entry points that allowed device creation
-- without a registered key, or pairing-code consumption without enrollment.
REVOKE ALL ON FUNCTION public.register_device_enrollment(uuid, uuid, uuid, uuid, varchar, varchar, jsonb) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.redeem_device_pairing_code(text) FROM PUBLIC, sync_app;

COMMIT;
