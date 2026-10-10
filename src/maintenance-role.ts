import type { Pool } from 'pg';

export interface RoleAssertion {
  name: string;
  superuser: boolean;
  bypassrls: boolean;
}

/**
 * Reads the current role and its RLS-relevant attributes. Separate from
 * assertMaintenanceRole so a test can inspect the values without
 * triggering the throw.
 */
export async function fetchMaintenanceRole(pool: Pool): Promise<RoleAssertion> {
  const res = await pool.query<{
    name: string;
    superuser: boolean;
    bypassrls: boolean;
  }>(
    `SELECT current_user AS name,
            r.rolsuper     AS superuser,
            r.rolbypassrls AS bypassrls
     FROM pg_roles r
     WHERE r.rolname = current_user`,
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error('maintenance: could not read the current role from pg_roles');
  }
  return {
    name: String(row.name),
    superuser: row.superuser === true,
    bypassrls: row.bypassrls === true,
  };
}

/**
 * Refuses to run the maintenance cycle as a superuser or BYPASSRLS role.
 *
 * Both attributes make RLS invisible: the purge functions would touch
 * every tenant's rows, with no error and no trace. A dedicated
 * maintenance role that is neither superuser nor BYPASSRLS, with
 * EXECUTE only on the purge functions, is the safe choice.
 *
 * Called once by bootstrapMaintenance before runMaintenanceCycle.
 */
export async function assertMaintenanceRole(pool: Pool): Promise<void> {
  const role = await fetchMaintenanceRole(pool);
  if (role.superuser || role.bypassrls) {
    throw new Error(
      'Maintenance runner refused to start as "' +
        role.name +
        '" (superuser=' +
        role.superuser +
        ', bypassrls=' +
        role.bypassrls +
        '). A privileged role bypasses RLS: the purges would silently ' +
        'touch every tenant. Use sync_app or a dedicated maintenance role.',
    );
  }
}