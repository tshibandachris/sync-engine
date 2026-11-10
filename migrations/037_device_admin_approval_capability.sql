-- 037: isolated server-side device approval/rejection/revocation capability.
-- The general sync_app login receives no device mutation privileges.
BEGIN;

DO $roles$
DECLARE
  v_executor pg_catalog.pg_roles%ROWTYPE;
  v_owner pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO v_executor FROM pg_catalog.pg_roles WHERE rolname = 'device_admin_executor';
  IF NOT FOUND THEN
    CREATE ROLE device_admin_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF v_executor.rolcanlogin OR v_executor.rolsuper OR v_executor.rolcreatedb
     OR v_executor.rolcreaterole OR v_executor.rolinherit OR v_executor.rolreplication
     OR v_executor.rolbypassrls THEN
    RAISE EXCEPTION 'MIGRATION_FAILED: device_admin_executor has unsafe role attributes';
  END IF;

  SELECT * INTO v_owner FROM pg_catalog.pg_roles WHERE rolname = 'device_admin_function_owner';
  IF NOT FOUND THEN
    CREATE ROLE device_admin_function_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF v_owner.rolcanlogin OR v_owner.rolsuper OR v_owner.rolcreatedb
     OR v_owner.rolcreaterole OR v_owner.rolinherit OR v_owner.rolreplication
     OR v_owner.rolbypassrls THEN
    RAISE EXCEPTION 'MIGRATION_FAILED: device_admin_function_owner has unsafe role attributes';
  END IF;
END
$roles$;

GRANT USAGE, CREATE ON SCHEMA public TO device_admin_function_owner;
GRANT USAGE ON SCHEMA public TO device_admin_executor;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM device_admin_executor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM device_admin_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM device_admin_executor;

-- The function owner receives only the row operations required by the
-- tenant-scoped transition. FORCE RLS remains active because it is neither
-- a table owner nor a BYPASSRLS role.
GRANT SELECT, UPDATE ON TABLE public.devices TO device_admin_function_owner;
GRANT SELECT, INSERT ON TABLE public.device_approval_events TO device_admin_function_owner;
GRANT SELECT, UPDATE ON TABLE public.device_credentials TO device_admin_function_owner;

CREATE OR REPLACE FUNCTION public.transition_device_approval(
  p_tenant_id uuid,
  p_device_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason varchar
)
RETURNS TABLE (
  device_id uuid,
  approval_status varchar,
  approved_at timestamptz,
  approved_by uuid,
  changed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_device public.devices%ROWTYPE;
  v_to_status varchar(24);
  v_event_type varchar(24);
  v_reason varchar(500);
  v_changed_at timestamptz := clock_timestamp();
BEGIN
  IF p_tenant_id IS NULL OR p_device_id IS NULL OR p_actor_id IS NULL
     OR p_action NOT IN ('approve', 'reject', 'revoke')
     OR p_reason IS NOT NULL AND length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Invalid device approval transition arguments'
      USING ERRCODE = '22023';
  END IF;

  v_reason := NULLIF(trim(p_reason), '');
  IF p_action IN ('reject', 'revoke') AND v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required for rejection or revocation'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);

  SELECT d.* INTO v_device
    FROM public.devices AS d
   WHERE d.tenant_id = p_tenant_id
     AND d.id = p_device_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEVICE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  CASE p_action
    WHEN 'approve' THEN
      IF v_device.approval_status NOT IN ('pending_approval', 'rejected') THEN
        RAISE EXCEPTION 'DEVICE_TRANSITION_CONFLICT: cannot approve from %', v_device.approval_status
          USING ERRCODE = 'P0001';
      END IF;
      v_to_status := 'approved';
      v_event_type := 'approved';

    WHEN 'reject' THEN
      IF v_device.approval_status <> 'pending_approval' THEN
        RAISE EXCEPTION 'DEVICE_TRANSITION_CONFLICT: cannot reject from %', v_device.approval_status
          USING ERRCODE = 'P0001';
      END IF;
      v_to_status := 'rejected';
      v_event_type := 'rejected';

    WHEN 'revoke' THEN
      IF v_device.approval_status <> 'approved' THEN
        RAISE EXCEPTION 'DEVICE_TRANSITION_CONFLICT: cannot revoke from %', v_device.approval_status
          USING ERRCODE = 'P0001';
      END IF;
      v_to_status := 'revoked';
      v_event_type := 'revoked';

    ELSE
      RAISE EXCEPTION 'Unsupported device approval action' USING ERRCODE = '22023';
  END CASE;

  UPDATE public.devices AS d
     SET approval_status = v_to_status,
         approved_at = CASE
           WHEN v_to_status = 'approved' THEN v_changed_at
           WHEN v_to_status = 'revoked' THEN d.approved_at
           ELSE NULL
         END,
         approved_by = CASE
           WHEN v_to_status = 'approved' THEN p_actor_id
           WHEN v_to_status = 'revoked' THEN d.approved_by
           ELSE NULL
         END,
         approval_note = v_reason
   WHERE d.tenant_id = p_tenant_id
     AND d.id = p_device_id;

  IF p_action = 'revoke' THEN
    UPDATE public.device_credentials AS c
       SET status = 'revoked',
           revoked_at = v_changed_at
     WHERE c.tenant_id = p_tenant_id
       AND c.device_id = p_device_id
       AND c.status = 'active';
  END IF;

  INSERT INTO public.device_approval_events (
    tenant_id, device_id, actor_id, event_type,
    from_status, to_status, reason, metadata, created_at
  )
  VALUES (
    p_tenant_id, p_device_id, p_actor_id, v_event_type,
    v_device.approval_status, v_to_status, v_reason, '{}'::jsonb, v_changed_at
  );

  RETURN QUERY
    SELECT d.id, d.approval_status, d.approved_at, d.approved_by, v_changed_at
      FROM public.devices AS d
     WHERE d.tenant_id = p_tenant_id
       AND d.id = p_device_id;
END;
$function$;

ALTER FUNCTION public.transition_device_approval(uuid, uuid, uuid, text, varchar)
  OWNER TO device_admin_function_owner;

REVOKE ALL ON FUNCTION public.transition_device_approval(uuid, uuid, uuid, text, varchar)
  FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.transition_device_approval(uuid, uuid, uuid, text, varchar)
  TO device_admin_executor;

DO $verification$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
     WHERE member = 'device_admin_function_owner'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
     WHERE member = 'device_admin_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: device admin roles must not inherit other memberships';
  END IF;

  IF pg_catalog.has_table_privilege('device_admin_executor', 'public.devices', 'SELECT')
     OR pg_catalog.has_table_privilege('device_admin_executor', 'public.devices', 'UPDATE')
     OR pg_catalog.has_table_privilege('device_admin_executor', 'public.device_credentials', 'UPDATE')
     OR pg_catalog.has_table_privilege('device_admin_executor', 'public.device_approval_events', 'INSERT')
     OR pg_catalog.has_function_privilege('sync_app', 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('device_admin_executor', 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('device_admin_executor', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('device_admin_executor', 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: device admin executor privilege boundary is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
     WHERE c.relowner = 'device_admin_function_owner'::regrole
       AND c.relname IN ('devices', 'device_credentials', 'device_approval_events')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.transition_device_approval(uuid,uuid,uuid,text,character varying)'::regprocedure
       AND pg_catalog.pg_get_userbyid(p.proowner) <> 'device_admin_function_owner'
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: device admin function ownership is invalid';
  END IF;
END
$verification$;

COMMIT;
