import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertNonPrivilegedRole } from '../src/role-guard.js';

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

describe('assertNonPrivilegedRole', () => {
  it('refuse un superuser, en nommant le role', async () => {
    const pool = fakePool([{ role: 'postgres', rolsuper: true, rolbypassrls: false }]);
    await expect(assertNonPrivilegedRole(pool)).rejects.toThrow(/postgres/);
  });

  it('refuse un role BYPASSRLS qui nest pas superuser', async () => {
    const pool = fakePool([{ role: 'ops', rolsuper: false, rolbypassrls: true }]);
    await expect(assertNonPrivilegedRole(pool)).rejects.toThrow(/ops/);
  });

  it('accepte un role ordinaire', async () => {
    const pool = fakePool([{ role: 'sync_app', rolsuper: false, rolbypassrls: false }]);
    await expect(assertNonPrivilegedRole(pool)).resolves.toBeUndefined();
  });

  it('refuse si le role courant est introuvable dans pg_roles', async () => {
    await expect(assertNonPrivilegedRole(fakePool([]))).rejects.toThrow(/pg_roles/);
  });

  it('refuse le role superuser reel du conteneur de test', async () => {
    await expect(assertNonPrivilegedRole(pg.pool as Pool)).rejects.toThrow(/superuser ou BYPASSRLS/);
  });

  it('accepte le vrai role sync_app', async () => {
    await expect(assertNonPrivilegedRole(pg.appPool as Pool)).resolves.toBeUndefined();
  });
});
