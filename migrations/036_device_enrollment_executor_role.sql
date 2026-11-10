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

DO $owner_role$
DECLARE
  v_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO v_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'device_enrollment_function_owner';

  IF NOT FOUND THEN
    BEGIN
      CREATE ROLE device_enrollment_function_owner
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'MIGRATION_FAILED: pre-provision device_enrollment_function_owner as NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS, then rerun migration 036.';
    END;
  ELSE
    IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreatedb
       OR v_role.rolcreaterole OR v_role.rolinherit OR v_role.rolreplication
       OR v_role.rolbypassrls THEN
      RAISE EXCEPTION
        'MIGRATION_FAILED: device_enrollment_function_owner has unsafe attributes.';
    END IF;
  END IF;
END
$owner_role$;

GRANT USAGE, CREATE ON SCHEMA public TO device_enrollment_function_owner;

-- The SECURITY DEFINER owner is deliberately distinct from the executor
-- capability inherited by the API login. It receives only the table rights
-- required by the atomic function; FORCE RLS remains effective because this
-- role is neither a superuser nor BYPASSRLS and does not own the protected
-- tenant tables.
GRANT SELECT, UPDATE ON TABLE public.device_pairing_codes TO device_enrollment_function_owner;
GRANT SELECT, INSERT ON TABLE public.tenants TO device_enrollment_function_owner;
GRANT SELECT, INSERT ON TABLE public.devices TO device_enrollment_function_owner;
GRANT SELECT, INSERT ON TABLE public.device_credentials TO device_enrollment_function_owner;
GRANT INSERT ON TABLE public.device_approval_events TO device_enrollment_function_owner;
GRANT INSERT ON TABLE public.device_proof_nonces TO device_enrollment_function_owner;
GRANT SELECT, INSERT ON TABLE public.device_enrollment_attempts TO device_enrollment_function_owner;

ALTER FUNCTION public.redeem_device_pairing_code(text)
  OWNER TO device_enrollment_function_owner;
ALTER FUNCTION public.register_device_enrollment(
  uuid, uuid, uuid, uuid, varchar, varchar, jsonb
) OWNER TO device_enrollment_function_owner;
ALTER FUNCTION public.register_device_enrollment_with_credential(
  text, uuid, varchar, varchar, jsonb, text, varchar, uuid
) OWNER TO device_enrollment_function_owner;


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

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'device_enrollment_function_owner'
       AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
            OR rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: function owner role must be non-login, non-superuser, NOINHERIT and must not bypass RLS';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members
     WHERE member = 'device_enrollment_function_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: function owner role must not inherit any other role';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.oid IN (
       'public.redeem_device_pairing_code(text)'::regprocedure,
       'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)'::regprocedure,
       'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)'::regprocedure
     )
       AND pg_catalog.pg_get_userbyid(p.proowner) <> 'device_enrollment_function_owner'
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: every enrollment SECURITY DEFINER function must be owned by device_enrollment_function_owner';
  END IF;

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
       AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = pg_catalog.pg_get_userbyid(enrollment.proowner))
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
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_roles AS r ON r.oid = c.relowner
     WHERE r.rolname = 'device_enrollment_function_owner'
       AND c.relname IN (
         'tenants', 'devices', 'device_pairing_codes', 'device_credentials',
         'device_approval_events', 'device_proof_nonces', 'device_enrollment_attempts'
       )
  ) THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: SECURITY DEFINER owner must not own tenant or enrollment tables; FORCE RLS must remain effective';
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
     OR pg_catalog.has_table_privilege('sync_app', 'public.devices', 'UPDATE')
     OR pg_catalog.has_table_privilege('sync_app', 'public.devices', 'DELETE')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'SELECT')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'INSERT')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'UPDATE')
     OR pg_catalog.has_table_privilege('sync_app', 'public.device_pairing_codes', 'DELETE')
     OR pg_catalog.has_function_privilege('sync_app', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('sync_app', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: sync_app retains a direct device enrollment or pairing-code privilege';
  END IF;

  IF pg_catalog.has_table_privilege('device_enrollment_executor', 'public.tenants', 'SELECT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.devices', 'SELECT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.devices', 'INSERT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_credentials', 'SELECT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_credentials', 'INSERT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_approval_events', 'INSERT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_proof_nonces', 'INSERT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_enrollment_attempts', 'SELECT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_pairing_codes', 'SELECT')
     OR pg_catalog.has_table_privilege('device_enrollment_executor', 'public.device_pairing_codes', 'UPDATE')
     OR pg_catalog.has_function_privilege('device_enrollment_executor', 'public.redeem_device_pairing_code(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('device_enrollment_executor', 'public.register_device_enrollment(uuid,uuid,uuid,uuid,character varying,character varying,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY_MIGRATION_FAILED: executor capability must not have direct table or helper-function access';
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
