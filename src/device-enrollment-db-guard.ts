import type { Pool } from 'pg';

const ENROLLMENT_FUNCTION =
  'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)';

export async function assertEnrollmentDatabaseIdentity(pool: Pool): Promise<void> {
  const result = await pool.query<{
    session_user: string;
    current_user: string;
    is_superuser: boolean;
    can_bypass_rls: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_replicate: boolean;
    can_inherit: boolean;
    is_sync_app_member: boolean;
    has_unexpected_memberships: boolean;
    owns_database_objects: boolean;
    has_executor_membership: boolean;
    can_execute_enrollment: boolean;
    is_function_owner: boolean;
  }>(`
    SELECT
      session_user,
      current_user,
      COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), true) AS is_superuser,
      COALESCE((SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = session_user), true) AS can_bypass_rls,
      COALESCE((SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = session_user), true) AS can_create_db,
      COALESCE((SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = session_user), true) AS can_create_role,
      COALESCE((SELECT rolreplication FROM pg_catalog.pg_roles WHERE rolname = session_user), true) AS can_replicate,
      COALESCE((SELECT rolinherit FROM pg_catalog.pg_roles WHERE rolname = session_user), false) AS can_inherit,
      CASE WHEN pg_catalog.to_regrole('sync_app') IS NULL THEN true
           ELSE pg_catalog.pg_has_role(session_user, 'sync_app', 'MEMBER') END AS is_sync_app_member,
      CASE WHEN pg_catalog.to_regrole('device_enrollment_executor') IS NULL THEN false
           ELSE pg_catalog.pg_has_role(session_user, 'device_enrollment_executor', 'USAGE') END AS has_executor_membership,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
          JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE member_role.rolname = session_user
           AND granted_role.rolname <> 'device_enrollment_executor'
      ) AS has_unexpected_memberships,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS c
         WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS p
         WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace AS n
         WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_database AS d
         WHERE d.datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)
      ) AS owns_database_objects,
      pg_catalog.has_function_privilege(session_user, $1, 'EXECUTE') AS can_execute_enrollment,
      COALESCE((SELECT pg_catalog.pg_get_userbyid(p.proowner) = session_user
                  FROM pg_catalog.pg_proc AS p WHERE p.oid = $1::regprocedure), true) AS is_function_owner
  `, [ENROLLMENT_FUNCTION]);
  const identity = result.rows[0];
  if (!identity || identity.is_superuser || identity.can_bypass_rls ||
      identity.can_create_db || identity.can_create_role || identity.can_replicate ||
      !identity.can_inherit || identity.session_user !== identity.current_user ||
      identity.is_sync_app_member || identity.has_unexpected_memberships || identity.owns_database_objects || !identity.has_executor_membership ||
      !identity.can_execute_enrollment || identity.is_function_owner) {
    throw new Error(
      'BOOTSTRAP_SECURITY_ERROR: DEVICE_ENROLLMENT_DATABASE_URL must use a non-privileged INHERIT login, not a member of sync_app, inheriting device_enrollment_executor, with EXECUTE on the exact enrollment function.',
    );
  }
}
