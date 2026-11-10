-- 036: isolate the atomic enrollment capability from the general sync_app login.
-- The migration never creates a LOGIN credential. A DBA provisions a dedicated
-- login and grants it membership in this NOLOGIN capability role.
BEGIN;

DO $migration$
DECLARE
  v_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO v_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'device_enrollment_executor';

  IF NOT FOUND THEN
    BEGIN
      CREATE ROLE device_enrollment_executor
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'MIGRATION_FAILED: pre-provision device_enrollment_executor as NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, then rerun migration 036.';
    END;
  ELSE
    IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreatedb
       OR v_role.rolcreaterole OR v_role.rolinherit OR v_role.rolreplication
       OR v_role.rolbypassrls THEN
      RAISE EXCEPTION
        'MIGRATION_FAILED: device_enrollment_executor has unsafe attributes; expected NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS.';
    END IF;
  END IF;
END
$migration$;

GRANT USAGE ON SCHEMA public TO device_enrollment_executor;

-- Remove the legacy direct-write and helper-function paths from the general app role.
-- Enrollment now enters only through the dedicated executor capability.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.devices FROM sync_app;
REVOKE ALL ON TABLE public.device_pairing_codes FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.redeem_device_pairing_code(text) FROM PUBLIC, sync_app;
REVOKE ALL ON FUNCTION public.register_device_enrollment(
  uuid, uuid, uuid, uuid, varchar, varchar, jsonb
) FROM PUBLIC, sync_app;

-- Exact signature from migration 035_device_enrollment_with_credential.sql.
REVOKE ALL ON FUNCTION public.register_device_enrollment_with_credential(
  text, uuid, varchar, varchar, jsonb, text, varchar, uuid
) FROM PUBLIC, sync_app;

GRANT EXECUTE ON FUNCTION public.register_device_enrollment_with_credential(
  text, uuid, varchar, varchar, jsonb, text, varchar, uuid
) TO device_enrollment_executor;

-- Fail the migration if the capability accidentally inherits the general role.
DO $verification$
BEGIN

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS enrollment
      JOIN pg_catalog.pg_proc AS redemption
        ON redemption.oid = 'public.redeem_device_pairing_code(text)'::regprocedure
      JOIN pg_catalog.pg_proc AS device_creation
        ON device_creation.oid = 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)'::regprocedure
     WHERE enrollment.oid = 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)'::regprocedure
       AND enrollment.prosecdef
       AND redemption.prosecdef
       AND device_creation.prosecdef
       AND enrollment.proowner = redemption.proowner
       AND enrollment.proowner = device_creation.proowner
       AND pg_catalog.has_function_privilege(
         pg_catalog.pg_get_userbyid(enrollment.proowner),
         redemption.oid,
         'EXECUTE'
       )
       AND pg_catalog.has_function_privilege(
         pg_catalog.pg_get_userbyid(enrollment.proowner),
         device_creation.oid,
         'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: enrollment and its SECURITY DEFINER helper functions must share an owner that can execute both helpers';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)'::regprocedure
       AND p.prosecdef
       AND pg_catalog.pg_get_userbyid(p.proowner) NOT IN ('sync_app', 'device_enrollment_executor', 'device_enrollment_login')
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: enrollment function must remain SECURITY DEFINER and must not be owned by sync_app';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
    WHERE member = 'device_enrollment_executor'::regrole
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: executor capability role must not inherit any other role';
  END IF;
  IF pg_catalog.pg_has_role('device_enrollment_executor', 'sync_app', 'MEMBER') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: executor must not be a member of sync_app';
  END IF;

  IF pg_catalog.has_table_privilege('sync_app', 'public.devices', 'INSERT')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'SELECT')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'UPDATE')
     OR pg_catalog.has_function_privilege('sync_app', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('sync_app', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: sync_app retains a direct device enrollment or pairing-code privilege';
  END IF;

  IF pg_catalog.has_function_privilege(
    'sync_app',
    'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: sync_app still has EXECUTE on the enrollment function';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'device_enrollment_executor',
    'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: executor lacks EXECUTE on the enrollment function';
  END IF;
END
$verification$;

COMMIT;
