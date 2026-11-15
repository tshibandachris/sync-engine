import type { Pool } from 'pg';

/**
 * Refuses to serve traffic unless the main API pool connects as a role that is
 * really subject to row-level security.
 *
 * Tenant isolation rests on RLS policies. A superuser or BYPASSRLS role skips
 * them, and a table owner skips them on every table that is not FORCEd. Managed
 * PostgreSQL offers a default admin/owner login, so pointing DATABASE_URL at it
 * would silently remove tenant isolation. The enrollment and device-admin pools
 * already have identity guards; this one covers the main pool.
 *
 * The error message never includes the connection string.
 */
export async function assertAppDatabaseIdentity(db: Pick<Pool, 'query'>): Promise<void> {
  const res = await db.query<{
    role: string;
    session_role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    membership_count: number;
    owns_relations: boolean;
    owns_functions: boolean;
    owns_schemas: boolean;
    owns_database: boolean;
  }>(
    'SELECT current_user AS role, session_user AS session_role, ' +
      'r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication, ' +
      '(SELECT count(*)::integer FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS membership_count, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid) AS owns_relations, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid) AS owns_functions, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid) AS owns_schemas, ' +
      'EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba = r.oid) AS owns_database ' +
      'FROM pg_catalog.pg_roles r WHERE r.rolname = session_user',
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error('Impossible de lire le role de connexion dans pg_roles : refus de demarrer.');
  }

  if (row.role !== row.session_role) {
    throw new Error(
      'Refus de demarrer : un SET ROLE est actif (session_user \"' + row.session_role +
        '\", current_user \"' + row.role + '\"). La connexion applicative doit se connecter directement avec son role.',
    );
  }

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      'Refus de demarrer : le role \"' + row.role + '\" est superuser ou BYPASSRLS, ' +
        'la RLS ne s\'appliquerait pas et l\'isolation entre commerces disparaitrait. ' +
        'DATABASE_URL doit utiliser le login applicatif sync_app.',
    );
  }

  if (row.rolcreatedb || row.rolcreaterole || row.rolreplication) {
    throw new Error(
      'Refus de demarrer : le role \"' + row.role + '\" a un privilege d\'administration ' +
        '(CREATEDB, CREATEROLE ou REPLICATION) que l\'API ne doit pas avoir.',
    );
  }

  if (row.owns_relations || row.owns_functions || row.owns_schemas || row.owns_database) {
    throw new Error(
      'Refus de demarrer : le role \"' + row.role + '\" est proprietaire de tables, fonctions, schemas ou de la base. ' +
        'Un proprietaire contourne la RLS des tables non FORCE. DATABASE_URL doit utiliser le login applicatif sync_app, ' +
        'jamais l\'administrateur de la base.',
    );
  }

  if (row.membership_count !== 0) {
    throw new Error(
      'Refus de demarrer : le role \"' + row.role + '\" a une appartenance a un autre role. ' +
        'Une appartenance heritee peut redonner les droits d\'un proprietaire ou d\'un role pg_*. ' +
        'Le login applicatif ne doit appartenir a aucun role.',
    );
  }
}
