import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertAppDatabaseIdentity } from '../src/app-db-guard.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

// Faux pool qui renvoie des lignes fixes : couvre chaque branche sans creer de role.
const fakePool = (rows: Array<Record<string, unknown>>): Pool =>
  ({ query: async () => ({ rows }) }) as unknown as Pool;

const healthyRow = {
  role: 'sync_app',
  session_role: 'sync_app',
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  membership_count: 0,
  owns_relations: false,
  owns_functions: false,
  owns_schemas: false,
  owns_database: false,
};

describe('assertAppDatabaseIdentity', () => {
  it('accepte un role applicatif sans privilege ni propriete', async () => {
    await expect(assertAppDatabaseIdentity(fakePool([healthyRow]))).resolves.toBeUndefined();
  });

  it('refuse si le role est introuvable dans pg_roles', async () => {
    await expect(assertAppDatabaseIdentity(fakePool([]))).rejects.toThrow(/pg_roles/);
  });

  it('refuse un superuser, en nommant le role', async () => {
    const pool = fakePool([{ ...healthyRow, role: 'postgres', session_role: 'postgres', rolsuper: true }]);
    await expect(assertAppDatabaseIdentity(pool)).rejects.toThrow(/postgres/);
  });

  it('refuse un role BYPASSRLS', async () => {
    await expect(assertAppDatabaseIdentity(fakePool([{ ...healthyRow, rolbypassrls: true }]))).rejects.toThrow(/BYPASSRLS/);
  });

  it.each(['rolcreatedb', 'rolcreaterole', 'rolreplication'])('refuse le privilege %s', async (field) => {
    await expect(assertAppDatabaseIdentity(fakePool([{ ...healthyRow, [field]: true }]))).rejects.toThrow(/privilege/);
  });

  it.each(['owns_relations', 'owns_functions', 'owns_schemas', 'owns_database'])(
    'refuse un role proprietaire (%s)',
    async (field) => {
      await expect(assertAppDatabaseIdentity(fakePool([{ ...healthyRow, [field]: true }]))).rejects.toThrow(/proprietaire/);
    },
  );

  it('refuse toute appartenance a un autre role', async () => {
    await expect(assertAppDatabaseIdentity(fakePool([{ ...healthyRow, membership_count: 1 }]))).rejects.toThrow(/appartenance/);
  });

  it('refuse un SET ROLE actif (session_user different de current_user)', async () => {
    await expect(assertAppDatabaseIdentity(fakePool([{ ...healthyRow, session_role: 'postgres' }]))).rejects.toThrow(/SET ROLE/);
  });

  it('refuse le role superuser reel du conteneur de test', async () => {
    await expect(assertAppDatabaseIdentity(pg.pool as Pool)).rejects.toThrow(/superuser/);
  });

  it('accepte le vrai role applicatif sync_app', async () => {
    await expect(assertAppDatabaseIdentity(pg.appPool as Pool)).resolves.toBeUndefined();
  });

  it('refuse le login de maintenance (appartenance a un role executeur)', async () => {
    await expect(assertAppDatabaseIdentity(pg.maintenancePool as Pool)).rejects.toThrow(/appartenance/);
  });
});

describe('row-level security is forced on every RLS-protected table', () => {
  it('no public table has RLS enabled without FORCE', async () => {
    const res = await pg.pool.query(
      `SELECT c.relname
         FROM pg_catalog.pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity
        ORDER BY c.relname`,
    );
    expect(res.rows.map((r: { relname: string }) => r.relname)).toEqual([]);
  });
});
