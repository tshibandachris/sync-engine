import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { pgErrorChain } from './helpers/pg-error.js';
import { withTenant } from '../src/with-tenant.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

const registered = async (id: string): Promise<number> =>
  (await pg.pool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [id])).rows[0].n;

describe('non-régression withTenant après migration 045', () => {
  it("intercepte le refus d'INSERT, journalise l'erreur et laisse réussir la requête métier", async () => {
    const tenantId = randomUUID();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await registered(tenantId)).toBe(0);

      const result = await withTenant(pg.appDb, tenantId, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'business-query-ok';
      });

      expect(result).toBe('business-query-ok');
      expect(await registered(tenantId)).toBe(0);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toBe('[tenants] registration failed:');
      expect(pgErrorChain(errSpy.mock.calls[0][1])).toMatch(/permission denied.*tenants|42501/is);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('ne met pas en cache un tenant dont l’inscription a été refusée', async () => {
    const tenantId = randomUUID();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withTenant(pg.appDb, tenantId, async () => 'first');
      await withTenant(pg.appDb, tenantId, async () => 'second');
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(await registered(tenantId)).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('un identifiant mal formé ne déclenche pas de tentative d’inscription', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(withTenant(pg.appDb, 'not-a-uuid', async () => 'ok')).resolves.toBe('ok');
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
