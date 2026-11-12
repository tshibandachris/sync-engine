import type { Pool } from 'pg';

/**
 * Refuses to run under a role that bypasses row-level security or inherits
 * any capability other than the dedicated maintenance purge executor.
 *
 * The membership check intentionally enumerates pg_roles and uses pg_has_role,
 * so direct and transitive memberships are covered, including predefined pg_*
 * roles. PostgreSQL 16 membership options are checked as well.
 *
 * The error message never includes the connection string.
 */
export async function assertNonPrivilegedRole(db: Pick<Pool, 'query'>): Promise<void> {
  const res = await db.query<{
    role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    has_allowed_membership: boolean;
    has_unexpected_membership: boolean;
    allowed_membership_options_ok: boolean;
    direct_membership_count: number;
  }>(
    'SELECT current_role.rolname AS role, ' +
      'current_role.rolsuper, current_role.rolbypassrls, ' +
      'pg_catalog.pg_has_role(current_role.oid, allowed_role.oid, \\'USAGE\\') AS has_allowed_membership, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_roles other_role ' +
      'WHERE other_role.oid <> current_role.oid AND other_role.oid <> allowed_role.oid ' +
      'AND pg_catalog.pg_has_role(current_role.oid, other_role.oid, \\'MEMBER\\')) AS has_unexpected_membership, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership ' +
      'WHERE membership.member = current_role.oid AND membership.roleid = allowed_role.oid ' +
      'AND NOT membership.admin_option AND membership.inherit_option AND NOT membership.set_option) ' +
      'AS allowed_membership_options_ok, ' +
      '(SELECT count(*)::integer FROM pg_catalog.pg_auth_members membership ' +
      'WHERE membership.member = current_role.oid) AS direct_membership_count ' +
      'FROM pg_catalog.pg_roles current_role CROSS JOIN pg_catalog.pg_roles allowed_role ' +
      'WHERE current_role.rolname = current_user AND allowed_role.rolname = \\'maintenance_purge_executor\\'',
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error('Impossible de lire le role courant ou le role de maintenance dans pg_roles : refus de continuer.');
  }

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      'Refus de demarrer : le role "' +
        row.role +
        '" est superuser ou BYPASSRLS, la RLS ne s\'appliquerait pas a la maintenance. ' +
        'Utilise le role maintenance_login dans MAINTENANCE_DATABASE_URL.',
    );
  }

  if (
    !row.has_allowed_membership ||
    row.has_unexpected_membership ||
    !row.allowed_membership_options_ok ||
    row.direct_membership_count !== 1
  ) {
    throw new Error(
      'Refus de demarrer : maintenance_login doit avoir exactement une appartenance, ' +
        'maintenance_purge_executor (INHERIT, sans SET ROLE ni ADMIN OPTION). ' +
        'Les appartenances directes ou indirectes, y compris pg_*, sont interdites.',
    );
  }
}
