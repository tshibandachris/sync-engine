-- 033: atomic device enrollment plus immutable initial approval request event.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_device_enrollment(
  p_device_id uuid,
  p_tenant_id uuid,
  p_store_id uuid,
  p_pos_profile_id uuid,
  p_name varchar,
  p_fingerprint varchar,
  p_hardware_info jsonb
)
RETURNS TABLE (
  device_id uuid,
  tenant_id uuid,
  store_id uuid,
  pos_profile_id uuid,
  device_name varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_device public.devices%ROWTYPE;
BEGIN
  IF p_device_id IS NULL OR p_tenant_id IS NULL OR p_store_id IS NULL
     OR p_name IS NULL OR length(trim(p_name)) = 0
     OR p_fingerprint IS NULL OR length(trim(p_fingerprint)) = 0
     OR p_hardware_info IS NULL OR jsonb_typeof(p_hardware_info) <> 'object' THEN
    RAISE EXCEPTION 'Invalid device enrollment arguments' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);

  INSERT INTO public.tenants (id, first_seen_at)
  VALUES (p_tenant_id, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.devices (
    id, tenant_id, store_id, pos_profile_id, name, fingerprint,
    hardware_info, is_active, approval_status, approved_at, approved_by, approval_note
  )
  VALUES (
    p_device_id, p_tenant_id, p_store_id, p_pos_profile_id, p_name, p_fingerprint,
    p_hardware_info, true, 'pending_approval', NULL, NULL, NULL
  )
  RETURNING * INTO v_device;

  INSERT INTO public.device_approval_events (
    tenant_id, device_id, actor_id, event_type, from_status, to_status, reason, metadata
  )
  VALUES (
    p_tenant_id, p_device_id, NULL, 'requested', NULL, 'pending_approval',
    'Device self-enrollment via activation code', '{}'::jsonb
  );

  RETURN QUERY SELECT v_device.id, v_device.tenant_id, v_device.store_id,
                      v_device.pos_profile_id, v_device.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_device_enrollment(uuid, uuid, uuid, uuid, varchar, varchar, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_device_enrollment(uuid, uuid, uuid, uuid, varchar, varchar, jsonb) TO sync_app;

COMMIT;
