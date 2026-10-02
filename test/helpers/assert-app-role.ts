import { sql } from 'drizzle-orm';

// HTTP specs must run the application with the same kind of database role
// as production: not a superuser, not BYPASSRLS, and not an owner of the
// RLS-protected tables (unless FORCE ROW LEVEL SECURITY is on).
//
// Call it once in each spec's beforeAll, right after the Nest module is built:
//
//   await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
//
// If someone swaps pg.appDb back to pg.db, the spec fails immediately with
// a clear message instead of silently going back to bypassing RLS.

export async function assertRunsAsAppRole(
  db: { execute: (q: any) => Promise<{ rows: any[] }> },
) {
  const role = await db.execute(sql`
    SELECT current_user AS name,
           r.rolsuper AS superuser,
           r.rolbypassrls AS bypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const { name, superuser, bypassrls } = role.rows[0];
  if (superuser || bypassrls) {
    throw new Error(
      'HTTP tests must run as the RLS-subject role, but connected as "' +
        name +
        '" (superuser=' +
        superuser +
        ', bypassrls=' +
        bypassrls +
        '). Use pg.appDb for the DRIZZLE_DB provider.',
    );
  }

  const table = await db.execute(sql`
    SELECT c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           pg_get_userbyid(c.relowner) = current_user AS is_owner
    FROM pg_class c
    WHERE c.relname = 'check_ins' AND c.relkind = 'r'
  `);
  const t = table.rows[0];
  if (!t || !t.rls_enabled) {
    throw new Error(
      'RLS is not enabled on check_ins: the HTTP specs would not prove isolation.',
    );
  }
  if (t.is_owner && !t.rls_forced) {
    throw new Error(
      '"' + name + '" owns check_ins and RLS is not FORCEd: this role bypasses RLS.',
    );
  }
}
