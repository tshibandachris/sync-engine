import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe('purge_tenant_sync_logs', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeEach(async () => {
    await pg.pool.query('DELETE FROM sync_logs WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
  });

  async function seedLog(tenantId: string, startedAt: number): Promise<string> {
    const id = randomUUID();
    await pg.pool.query(
      `INSERT INTO sync_logs
         (id, request_id, tenant_id, operation, status_code, started_at, duration_ms,
          records_in, records_out, conflicts, errors)
       VALUES ($1, $2, $3, 'pull', 201, $4, 10, 0, 0, 0, 0)`,
      [id, randomUUID(), tenantId, startedAt],
    );
    return id;
  }

  async function listLogIds(tenantId: string): Promise<Set<string>> {
    const r = await pg.pool.query('SELECT id FROM sync_logs WHERE tenant_id = $1', [tenantId]);
    return new Set(r.rows.map((row: { id: string }) => String(row.id)));
  }

  // Appel en tant que sync_app. context = tenant du contexte posé avant l'appel (null = aucun,
  // la fonction est autonome). COMMIT si l'appel réussit, ROLLBACK sinon.
  async function purge(tenantId: string, ttlDays: number, context: string | null = null): Promise<number> {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      if (context) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [context]);
      }
      const res = await client.query('SELECT purge_tenant_sync_logs($1::uuid, $2::int) AS result', [tenantId, ttlDays]);
      await client.query('COMMIT');
      return Number(res.rows[0].result.logs_deleted);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  it('supprime uniquement les logs plus vieux que le seuil', async () => {
    const now = Date.now();
    const old40 = await seedLog(tenantA, now - 40 * DAY_MS);
    const recent10 = await seedLog(tenantA, now - 10 * DAY_MS);
    const old90 = await seedLog(tenantA, now - 90 * DAY_MS);

    expect(await purge(tenantA, 30)).toBe(2);

    const remaining = await listLogIds(tenantA);
    expect(remaining.size).toBe(1);
    expect(remaining.has(recent10)).toBe(true);
    expect(remaining.has(old40)).toBe(false);
    expect(remaining.has(old90)).toBe(false);
  });

  it('respecte la limite : 29 jours restent, 31 jours partent', async () => {
    const now = Date.now();
    const d29 = await seedLog(tenantA, now - 29 * DAY_MS);
    const d31 = await seedLog(tenantA, now - 31 * DAY_MS);

    expect(await purge(tenantA, 30)).toBe(1);

    const remaining = await listLogIds(tenantA);
    expect(remaining.has(d29)).toBe(true);
    expect(remaining.has(d31)).toBe(false);
  });

  it("purge un tenant sans toucher l'autre", async () => {
    const now = Date.now();
    const aOld = await seedLog(tenantA, now - 60 * DAY_MS);
    const aRecent = await seedLog(tenantA, now - 5 * DAY_MS);
    const bOld = await seedLog(tenantB, now - 60 * DAY_MS);
    const bRecent = await seedLog(tenantB, now - 5 * DAY_MS);

    await purge(tenantA, 30);

    const a = await listLogIds(tenantA);
    expect(a.has(aRecent)).toBe(true);
    expect(a.has(aOld)).toBe(false);
    const b = await listLogIds(tenantB);
    expect(b.has(bRecent)).toBe(true);
    expect(b.has(bOld)).toBe(true);
  });

  it('fonctionne aussi quand le contexte du même tenant est déjà posé (appel du service)', async () => {
    const old = await seedLog(tenantA, Date.now() - 60 * DAY_MS);
    expect(await purge(tenantA, 30, tenantA)).toBe(1);
    expect((await listLogIds(tenantA)).has(old)).toBe(false);
  });

  it('sync_app ne peut pas faire DELETE directement, la fonction si', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await expect(
        client.query('DELETE FROM sync_logs WHERE tenant_id = $1', [tenantA]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const old = await seedLog(tenantA, Date.now() - 40 * DAY_MS);
    expect(await purge(tenantA, 30)).toBe(1);
    expect((await listLogIds(tenantA)).has(old)).toBe(false);
  });

  it('sync_app peut toujours INSERT après une purge (append-only intact)', async () => {
    await purge(tenantA, 30);

    const newId = randomUUID();
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO sync_logs
           (id, request_id, tenant_id, operation, status_code, started_at, duration_ms,
            records_in, records_out, conflicts, errors)
         VALUES ($1, $2, $3, 'pull', 201, $4, 5, 0, 0, 0, 0)`,
        [newId, randomUUID(), tenantA, Date.now()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    expect((await listLogIds(tenantA)).has(newId)).toBe(true);
  });

  it('refuse une rétention sous 30 jours et ne supprime rien', async () => {
    const recent = await seedLog(tenantA, Date.now() - 5 * DAY_MS);
    for (const ttl of [-1, 0, 29]) {
      await expect(purge(tenantA, ttl)).rejects.toThrow(/ttl_days/);
    }
    expect((await listLogIds(tenantA)).has(recent)).toBe(true);
  });

  it("restaure le contexte de l'appelant : purger B ne bascule pas la transaction de A", async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query('SELECT purge_tenant_sync_logs($1::uuid, 30)', [tenantB]);
      const ctx = await client.query(`SELECT current_setting('app.current_tenant_id', true) AS v`);
      expect(ctx.rows[0].v).toBe(tenantA);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it("sans contexte au départ, aucun contexte ne subsiste après la purge", async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT purge_tenant_sync_logs($1::uuid, 30)', [tenantA]);
      const ctx = await client.query(`SELECT current_setting('app.current_tenant_id', true) AS v`);
      expect(ctx.rows[0].v ?? '').toBe('');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('la fonction est SECURITY DEFINER, search_path figé, EXECUTE pour sync_app et pas pour PUBLIC', async () => {
    const r = await pg.pool.query(
      `SELECT prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE proname = 'purge_tenant_sync_logs'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].prosecdef).toBe(true);
    expect((r.rows[0].proconfig ?? []).some((c: string) => c.startsWith('search_path='))).toBe(true);
    expect(r.rows[0].acl).toMatch(/sync_app=X\//);
    expect(r.rows[0].acl).not.toMatch(/[{,]=X\//); // une entrée « =X/ » serait PUBLIC
  });
});
