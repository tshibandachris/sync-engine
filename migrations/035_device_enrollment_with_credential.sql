-- 035: cryptographically bound, atomic and retry-safe device enrollment.
-- Pairing-code consumption, device creation, credential insertion, approval
-- event, proof nonce and idempotency receipt commit in one transaction.
BEGIN;

CREATE TABLE public.device_enrollment_attempts (
  code_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  jti uuid NOT NULL UNIQUE,
  fingerprint varchar(255) NOT NULL,
  key_thumbprint varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT device_enrollment_attempts_code_hash_check
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fk_device_enrollment_attempts_device
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES public.devices (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_device_enrollment_attempts_credential
    FOREIGN KEY (credential_id)
    REFERENCES public.device_credentials (id)
    ON DELETE RESTRICT
);

ALTER TABLE public.device_enrollment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_enrollment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY device_enrollment_attempts_tenant_isolation
  ON public.device_enrollment_attempts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.device_enrollment_attempts FROM PUBLIC, sync_app;

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
  v_redeemed RECORD;
  v_attempt RECORD;
  v_device RECORD;
  v_credential_id uuid;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
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

  -- Lock the pairing-code row before deciding whether this is a first request
  -- or a retry after a lost HTTP response.
  SELECT id, tenant_id, store_id, pos_profile_id, used_at, expires_at
    INTO v_pairing
    FROM public.device_pairing_codes
    WHERE code_hash = p_code_hash
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_ACTIVATION_CODE' USING ERRCODE = 'P1001';
  END IF;

  PERFORM set_config('app.current_tenant_id', v_pairing.tenant_id::text, true);

  IF v_pairing.used_at IS NOT NULL THEN
    SELECT *
      INTO v_attempt
      FROM public.device_enrollment_attempts
      WHERE code_hash = p_code_hash;

    IF FOUND
       AND v_attempt.jti = p_jti
       AND v_attempt.fingerprint = p_fingerprint
       AND v_attempt.key_thumbprint = p_key_thumbprint THEN
      SELECT *
        INTO v_device
        FROM public.devices
        WHERE tenant_id = v_attempt.tenant_id
          AND id = v_attempt.device_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ENROLLMENT_RECEIPT_DEVICE_MISSING' USING ERRCODE = 'P1004';
      END IF;

      -- Return the same server identity and credential on an exact retry.
      -- Approval state is read from the authoritative device row.
      RETURN QUERY
        SELECT v_device.id, v_device.tenant_id, v_device.store_id,
               v_device.pos_profile_id, v_device.name,
               v_device.approval_status, v_attempt.credential_id;
      RETURN;
    END IF;

    RAISE EXCEPTION 'CODE_ALREADY_CONSUMED' USING ERRCODE = 'P1002';
  END IF;

  IF v_pairing.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'CODE_EXPIRED' USING ERRCODE = 'P1003';
  END IF;

  -- Keep the established one-time redemption function in the transaction.
  SELECT *
    INTO v_redeemed
    FROM public.redeem_device_pairing_code(p_code_hash);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_ACTIVATION_CODE' USING ERRCODE = 'P1001';
  END IF;

  SELECT *
    INTO v_device
    FROM public.register_device_enrollment(
      p_device_id,
      v_redeemed.tenant_id,
      v_redeemed.store_id,
      v_redeemed.pos_profile_id,
      p_name,
      p_fingerprint,
      p_hardware_info
    );

  v_credential_id := gen_random_uuid();

  INSERT INTO public.device_credentials (
    id, tenant_id, device_id, public_key_pem, key_thumbprint, algorithm, status
  )
  VALUES (
    v_credential_id, v_redeemed.tenant_id, p_device_id,
    p_public_key_pem, p_key_thumbprint, 'ES256', 'active'
  );

  INSERT INTO public.device_proof_nonces (
    tenant_id, device_id, jti, expires_at
  )
  VALUES (
    v_redeemed.tenant_id, p_device_id, p_jti, clock_timestamp() + interval '2 minutes'
  );

  INSERT INTO public.device_enrollment_attempts (
    code_hash, tenant_id, device_id, credential_id, jti, fingerprint, key_thumbprint
  )
  VALUES (
    p_code_hash, v_redeemed.tenant_id, p_device_id, v_credential_id,
    p_jti, p_fingerprint, p_key_thumbprint
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
