-- 036: isolate the privileged enrollment function from the general sync_app login.
-- The executor is a NOLOGIN capability role. Operators provision a dedicated
-- LOGIN role for the enrollment connection and grant it membership; that
-- login must never be a member of sync_app.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'device_enrollment_executor') THEN
    CREATE ROLE device_enrollment_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE device_enrollment_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

REVOKE ALL ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar)
  FROM PUBLIC, sync_app;
GRANT EXECUTE ON FUNCTION public.register_device_enrollment_with_credential(text, uuid, uuid, varchar, varchar, jsonb, text, varchar)
  TO device_enrollment_executor;

COMMIT;
