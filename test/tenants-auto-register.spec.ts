import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { withTenant } from '../src/with-tenant.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

// Vérifications par le superuser (pas de RLS sur tenants de toute façon).
const registered = async (id: string): Promise<number> =>
  (await pg.pool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [id])).rows[0].n;

describe('inscription automatique des tenants par withTenant', () => {
  it('enregistre un nouveau tenant au premier passage (lecture)', async () => {
    const t = randomUUID();
    expect(await registered(t)).toBe(0);
    expect(await withTenant(pg.appDb, t, async () => 'ok')).toBe('ok');
    expect(await registered(t)).toBe(1);
  });

  it("l'enregistre aussi sur le chemin d'écriture ({ write: true })", async () => {
    const t = randomUUID();
    expect(await withTenant(pg.appDb, t, async () => 'ok', { write: true })).toBe('ok');
    expect(await registered(t)).toBe(1);
  });

  it("ne réinsère pas un tenant déjà enregistré par ce processus (cache)", async () => {
    const t = randomUUID();
    await withTenant(pg.appDb, t, async () => 'ok');
    expect(await registered(t)).toBe(1);

    // On efface la ligne dans le dos du processus : si le cache fonctionne,
    // le deuxième passage ne tente pas de la recréer.
    await pg.pool.query('DELETE FROM tenants WHERE id = $1', [t]);
    await withTenant(pg.appDb, t, async () => 'ok');
    expect(await registered(t)).toBe(0);
  });

  it("annule l'inscription si la requête échoue, puis réessaie au passage suivant", async () => {
    const t = randomUUID();
    await expect(
      withTenant(pg.appDb, t, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    expect(await registered(t)).toBe(0);

    await withTenant(pg.appDb, t, async () => 'ok');
    expect(await registered(t)).toBe(1);
  });

  it("un échec d'inscription ne fait pas échouer la requête métier", async () => {
    const t = randomUUID();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await pg.pool.query('REVOKE INSERT ON tenants FROM sync_app');
    try {
      // Si l'inscription faisait échouer le savepoint sans l'isoler, la transaction
      // serait avortée et fn() échouerait à son tour.
      const out = await withTenant(pg.appDb, t, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'ok';
      });
      expect(out).toBe('ok');
      expect(await registered(t)).toBe(0);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[tenants]'), expect.anything());
    } finally {
      await pg.pool.query('GRANT INSERT ON tenants TO sync_app');
      errSpy.mockRestore();
    }

    // Le tenant n'a pas été mis en cache : il est enregistré dès que le droit revient.
    await withTenant(pg.appDb, t, async () => 'ok');
    expect(await registered(t)).toBe(1);
  });

  it('dix appels simultanés (lecture et écriture) : une seule ligne, aucun interblocage', async () => {
    const t = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => withTenant(pg.appDb, t, async () => i, { write: i % 2 === 0 })),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await registered(t)).toBe(1);
  });

  it("n'enregistre pas un identifiant mal formé, sans bruit dans les logs", async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = (await pg.pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
    try {
      await withTenant(pg.appDb, 'not-a-uuid', async () => 'ok');
      const after = (await pg.pool.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
      expect(after).toBe(before);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
