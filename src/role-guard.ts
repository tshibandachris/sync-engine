import type { Pool } from 'pg';

/**
 * Refuses to run under a role that bypasses row-level security.
 *
 * The maintenance runner deletes data tenant by tenant, relying on RLS (and on the
 * SECURITY DEFINER guards) to keep each purge inside its tenant. Under a superuser or a
 * BYPASSRLS role the policies silently stop applying: nothing fails, the purge just loses
 * its isolation. A wrong DATABASE_URL must therefore stop the run, not pass unnoticed.
 *
 * The error message never includes the connection string.
 */
export async function assertNonPrivilegedRole(db: Pick<Pool, 'query'>): Promise<void> {
  const res = await db.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error('Impossible de lire le role courant dans pg_roles : refus de continuer.');
  }

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      'Refus de demarrer : le role "' +
        row.role +
        '" est superuser ou BYPASSRLS, la RLS ne s\'appliquerait pas a la maintenance. ' +
        'Utilise le role sync_app dans DATABASE_URL.',
    );
  }
}
