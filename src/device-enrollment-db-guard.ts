import type { Pool } from 'pg';

const ENROLLMENT_FUNCTION =
  'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)';

export async function assertEnrollmentDatabaseIdentity(pool: Pool): Promise<void> {
  const result = await pool.query<{
    session_user: string;
    current_user: string;
    is_superuser: boolean;
    is_sync_app_member: boolean;
    has_executor_membership: boolean;
    can_execute_enrollment: boolean;
  }>(`
    SELECT
      session_user,
      current_user,
      COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false) AS is_superuser,
      CASE WHEN pg_catalog.to_regrole('sync_app') IS NULL THEN true
           ELSE pg_catalog.pg_has_role(session_user, 'sync_app', 'MEMBER') END AS is_sync_app_member,
      CASE WHEN pg_catalog.to_regrole('device_enrollment_executor') IS NULL THEN false
           ELSE pg_catalog.pg_has_role(session_user, 'device_enrollment_executor', 'USAGE') END AS has_executor_membership,
      pg_catalog.has_function_privilege(session_user, $1, 'EXECUTE') AS can_execute_enrollment
  `, [ENROLLMENT_FUNCTION]);
  const identity = result.rows[0];
  if (!identity || identity.is_superuser || identity.session_user !== identity.current_user ||
      identity.is_sync_app_member || !identity.has_executor_membership ||
      !identity.can_execute_enrollment) {
    throw new Error(
      'BOOTSTRAP_SECURITY_ERROR: DEVICE_ENROLLMENT_DATABASE_URL must use a non-superuser login inheriting device_enrollment_executor, not a member of sync_app, with EXECUTE on the exact enrollment function.',
    );
  }
}
