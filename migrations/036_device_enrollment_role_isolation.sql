-- 036: isolate the privileged enrollment function from the general sync_app login.
-- The executor is a NOLOGIN capability role. Production DBAs may pre-provision
-- it; restricted migration users must not need CREATEROLE when it already exists.
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
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'MIGRATION_FAILED: migration user lacks CREATEROLE; a DBA must pre-provision device_enrollment_executor with NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE and NOINHERIT.';
    END;
  ELSE
    IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreatedb
       OR v_role.rolcreaterole OR v_role.rolinherit THEN
      RAISE EXCEPTION
        'MIGRATION_FAILED: pre-provisioned device_enrollment_executor has unsafe role attributes; expected NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT.';
    END IF;
  END IF;
END
$migration$;

GRANT USAGE ON SCHEMA public TO device_enrollment_executor;

REVOKE ALL ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar)
  FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar)
  TO device_enrollment_executor;

COMMIT;
