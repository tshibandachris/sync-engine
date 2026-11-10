import type { Pool } from 'pg';

export async function assertEnrollmentDatabaseIdentity(pool: Pool): Promise<void> {
  const result = await pool.query<{
    session_user: string;
    is_superuser: boolean;
    is_sync_app_member: boolean;
    has_enrollment_capability: boolean;
  }>(`
    SELECT
      session_user,
      COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false) AS is_superuser,
      CASE WHEN pg_catalog.to_regrole('sync_app') IS NULL THEN false
           ELSE pg_catalog.pg_has_role(session_user, 'sync_app', 'MEMBER') END AS is_sync_app_member,
      CASE WHEN pg_catalog.to_regrole('device_enrollment_executor') IS NULL THEN false
           ELSE pg_catalog.pg_has_role(session_user, 'device_enrollment_executor', 'USAGE') END AS has_enrollment_capability
  `);
  const identity = result.rows[0];
  if (!identity || identity.is_superuser || identity.is_sync_app_member || !identity.has_enrollment_capability) {
    throw new Error(
      'BOOTSTRAP_SECURITY_ERROR: Device enrollment pool must use a non-superuser login that inherits device_enrollment_executor and is not a member of sync_app.',
    );
  }
}
