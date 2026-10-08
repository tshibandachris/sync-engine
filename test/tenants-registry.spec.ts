import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('registre des tenants (migration 016)', () => {
  const register = (id: string) =>
    pg.appPool.query(
      `INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [id, Date.now()],
    );

  it("sync_app enregistre un tenant, et l'inscription est idempotente", async () => {
    const id = randomUUID();
    await register(id);
    await register(id);
    const r = await pg.appPool.query('SELECT count(*)::int AS n FROM tenants WHERE id = $1', [id]);
    expect(r.rows[0].n).toBe(1);
  });

  it('sans contexte tenant, sync_app liste tous les tenants (pas de RLS)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await register(a);
    await register(b);
    const r = await pg.appPool.query('SELECT id FROM tenants WHERE id = ANY($1::uuid[])', [[a, b]]);
    expect(r.rows.map((row: { id: string }) => String(row.id)).sort()).toEqual([a, b].sort());
  });

  it('sync_app ne peut ni modifier ni supprimer un tenant', async () => {
    const id = randomUUID();
    await register(id);
    await expect(pg.appPool.query('UPDATE tenants SET first_seen_at = 0 WHERE id = $1', [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(pg.appPool.query('DELETE FROM tenants WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
  });

  it('sync_app a exactement SELECT et INSERT sur tenants', async () => {
    const r = await pg.pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'sync_app' AND table_schema = 'public' AND table_name = 'tenants'
       ORDER BY privilege_type`,
    );
    expect(r.rows.map((row: { privilege_type: string }) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it("PUBLIC n'a aucun privilège, et la table est volontairement sans RLS", async () => {
    const r = await pg.pool.query(
      `SELECT relacl::text AS acl, relrowsecurity FROM pg_class
       WHERE relname = 'tenants' AND relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].acl).not.toMatch(/[{,]=/); // une entrée « =… » serait PUBLIC
    expect(r.rows[0].relrowsecurity).toBe(false);
  });
});
