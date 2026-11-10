import type { Pool } from 'pg';

const APPROVAL_FUNCTION =
  'public.transition_device_approval(uuid,uuid,uuid,text,character varying)';

export async function assertDeviceAdminDatabaseIdentity(pool: Pool): Promise<void> {
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
    has_executor_membership: boolean;
    can_set_executor_role: boolean;
    has_unexpected_memberships: boolean;
    owns_database_objects: boolean;
    can_execute_approval: boolean;
    can_execute_enrollment: boolean;
    has_direct_table_privileges: boolean;
    sync_app_can_execute: boolean;
    function_owner_is_safe: boolean;
    function_owner_has_memberships: boolean;
    function_owner_owns_protected_tables: boolean;
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
      CASE WHEN pg_catalog.to_regrole('device_admin_executor') IS NULL THEN false
           ELSE pg_catalog.pg_has_role(session_user, 'device_admin_executor', 'USAGE') END AS has_executor_membership,
      CASE WHEN pg_catalog.to_regrole('device_admin_executor') IS NULL THEN true
           ELSE pg_catalog.pg_has_role(session_user, 'device_admin_executor', 'SET') END AS can_set_executor_role,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
          JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE member_role.rolname = session_user
           AND granted_role.rolname <> 'device_admin_executor'
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
      pg_catalog.has_function_privilege(session_user, $1, 'EXECUTE') AS can_execute_approval,
      pg_catalog.has_function_privilege(session_user, 'public.register_device_enrollment_with_credential(text,uuid,character varying,character varying,jsonb,text,character varying,uuid)', 'EXECUTE') AS can_execute_enrollment,
      pg_catalog.has_table_privilege(session_user, 'public.devices', 'SELECT')
        OR pg_catalog.has_table_privilege(session_user, 'public.devices', 'INSERT')
        OR pg_catalog.has_table_privilege(session_user, 'public.devices', 'UPDATE')
        OR pg_catalog.has_table_privilege(session_user, 'public.devices', 'DELETE')
        OR pg_catalog.has_table_privilege(session_user, 'public.device_credentials', 'SELECT')
        OR pg_catalog.has_table_privilege(session_user, 'public.device_credentials', 'UPDATE')
        OR pg_catalog.has_table_privilege(session_user, 'public.device_approval_events', 'INSERT')
        AS has_direct_table_privileges,
      pg_catalog.has_function_privilege('sync_app', $1, 'EXECUTE') AS sync_app_can_execute,
      COALESCE((
        SELECT r.rolname = 'device_admin_function_owner'
           AND NOT r.rolcanlogin
           AND NOT r.rolsuper
           AND NOT r.rolcreatedb
           AND NOT r.rolcreaterole
           AND NOT r.rolinherit
           AND NOT r.rolreplication
           AND NOT r.rolbypassrls
        FROM pg_catalog.pg_proc AS p
        JOIN pg_catalog.pg_roles AS r ON r.oid = p.proowner
        WHERE p.oid = $1::regprocedure
      ), false) AS function_owner_is_safe,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_proc AS p ON p.oid = $1::regprocedure
        WHERE membership.member = p.proowner
      ) AS function_owner_has_memberships,
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS c
          JOIN pg_catalog.pg_proc AS p ON p.oid = $1::regprocedure
         WHERE c.relowner = p.proowner
           AND c.relname IN ('devices', 'device_credentials', 'device_approval_events')
      ) AS function_owner_owns_protected_tables
  `, [APPROVAL_FUNCTION]);

  const identity = result.rows[0];
  if (!identity || identity.is_superuser || identity.can_bypass_rls ||
      identity.can_create_db || identity.can_create_role || identity.can_replicate ||
      !identity.can_inherit || identity.session_user !== identity.current_user ||
      identity.is_sync_app_member || !identity.has_executor_membership ||
      identity.can_set_executor_role || identity.has_unexpected_memberships ||
      identity.owns_database_objects || !identity.can_execute_approval ||
      identity.can_execute_enrollment || identity.has_direct_table_privileges || identity.sync_app_can_execute ||
      !identity.function_owner_is_safe || identity.function_owner_has_memberships ||
      identity.function_owner_owns_protected_tables) {
    throw new Error(
      'BOOTSTRAP_SECURITY_ERROR: DEVICE_ADMIN_DATABASE_URL must use a non-privileged INHERIT login, not a member of sync_app, inheriting device_admin_executor without SET ROLE, with EXECUTE only on the isolated device approval function.',
    );
  }
}
