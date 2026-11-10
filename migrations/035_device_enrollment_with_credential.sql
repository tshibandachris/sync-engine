-- 035: cryptographically bound, atomic device enrollment.
-- Pairing-code consumption, device creation, credential insertion, approval
-- event and initial proof jti are one PostgreSQL statement/transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_device_enrollment_with_credential(
  p_code_hash text,
  p_device_id uuid,
  p_name varchar,
  p_fingerprint varchar,
  p_hardware_info jsonb,
  p_public_key_pem text,
  p_key_thumbprint varchar,
  p_jti uuid
)
RETURNS TABLE (
  device_id uuid,
  tenant_id uuid,
  store_id uuid,
  pos_profile_id uuid,
  device_name varchar,
  approval_status varchar,
  credential_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_pairing RECORD;
  v_device RECORD;
  v_credential_id uuid;
BEGIN
  IF p_code_hash IS NULL OR length(p_code_hash) <> 64
     OR p_device_id IS NULL OR p_jti IS NULL
     OR p_name IS NULL OR length(trim(p_name)) = 0 OR length(p_name) > 120
     OR p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0 OR length(p_fingerprint) > 255
     OR p_hardware_info IS NULL OR jsonb_typeof(p_hardware_info) <> 'object'
     OR p_public_key_pem IS NULL OR length(trim(p_public_key_pem)) = 0
     OR length(p_public_key_pem) > 16384
     OR p_key_thumbprint IS NULL OR length(trim(p_key_thumbprint)) = 0
     OR length(p_key_thumbprint) > 128 THEN
    RAISE EXCEPTION 'Invalid cryptographic device enrollment arguments'
      USING ERRCODE = '22023';
  END IF;

  -- This conditional UPDATE is the one-time pairing-code lock. It is rolled
  -- back automatically if any subsequent write in this function fails.
  SELECT *
    INTO v_pairing
    FROM public.redeem_device_pairing_code(p_code_hash);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_OR_USED_PAIRING_CODE'
      USING ERRCODE = 'P1001';
  END IF;

  PERFORM set_config('app.current_tenant_id', v_pairing.tenant_id::text, true);

  -- Reuse the established 033 insertion path so its device/event invariants
  -- and immutable migration history remain intact.
  SELECT *
    INTO v_device
    FROM public.register_device_enrollment(
      p_device_id,
      v_pairing.tenant_id,
      v_pairing.store_id,
      v_pairing.pos_profile_id,
      p_name,
      p_fingerprint,
      p_hardware_info
    );

  v_credential_id := gen_random_uuid();

  INSERT INTO public.device_credentials (
    id, tenant_id, device_id, public_key_pem, key_thumbprint, algorithm, status
  )
  VALUES (
    v_credential_id, v_pairing.tenant_id, p_device_id,
    p_public_key_pem, p_key_thumbprint, 'ES256', 'active'
  );

  -- The nonce table has a composite FK to devices and tenant RLS. The jti is
  -- therefore bound to the exact newly-created device and tenant.
  INSERT INTO public.device_proof_nonces (
    tenant_id, device_id, jti, expires_at
  )
  VALUES (
    v_pairing.tenant_id, p_device_id, p_jti, clock_timestamp() + interval '2 minutes'
  );

  RETURN QUERY
    SELECT v_device.device_id, v_device.tenant_id, v_device.store_id,
           v_device.pos_profile_id, v_device.device_name,
           'pending_approval'::varchar, v_credential_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_device_enrollment_with_credential(
  text, uuid, varchar, varchar, jsonb, text, varchar, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_device_enrollment_with_credential(
  text, uuid, varchar, varchar, jsonb, text, varchar, uuid
) TO sync_app;

COMMIT;
