-- 038: remove the temporary schema-creation privilege used to transfer
-- ownership of the enrollment SECURITY DEFINER functions in migration 036.
BEGIN;

REVOKE CREATE ON SCHEMA public FROM device_enrollment_function_owner;

DO $verification$
BEGIN
  IF pg_catalog.has_schema_privilege(
    'device_enrollment_function_owner',
    'public',
    'CREATE'
  ) THEN
    RAISE EXCEPTION
      'SECURITY_MIGRATION_FAILED: device_enrollment_function_owner must not retain CREATE on schema public';
  END IF;
END
$verification$;

COMMIT;
