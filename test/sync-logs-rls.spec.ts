// test/sync-logs-rls.spec.ts
//
// sync_logs est append-only et isolée par tenant (migration 014) :
// FORCE ROW LEVEL SECURITY, policy USING + WITH CHECK, et sync_app n'a que
// SELECT et INSERT. Tout passe par pg.appPool (rôle sync_app, soumis à la RLS) ;
// le seed passe par pg.pool (superuser).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('sync_logs RLS', () => {
  let pg: TestPostgres;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const logA = randomUUID();
  const logB = randomUUID();

  const insertSql = `
    INSERT INTO sync_logs (id, request_id, tenant_id, operation, status_code, started_at, duration_ms)
    VALUES ($1, $2, $3, 'pull', 201, 1700000000000, 12)`;

  const insertLog = (client: PoolClient, tenantId: string, id: string = randomUUID()) =>
    client.query(insertSql, [id, randomUUID(), tenantId]);

  // Une transaction par cas, toujours annulée : aucun nettoyage nécessaire.
  // tenantId = null : aucun contexte tenant (fail-closed attendu).
  async function inTx<T>(tenantId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      }
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    // Seed via le superuser (contourne la RLS)
    for (const [id, tenant] of [[logA, tenantA], [logB, tenantB]] as const) {
      await pg.pool.query(insertSql, [id, randomUUID(), tenant]);
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it('fail-closed : sans contexte tenant, sync_app ne voit aucune ligne', async () => {
    const res = await pg.appPool.query('SELECT id FROM sync_logs');
    expect(res.rows).toHaveLength(0);
  });

  it('sync_app ne voit que les logs de son tenant', async () => {
    const ids = await inTx(tenantA, async (c) => (await c.query('SELECT id FROM sync_logs')).rows.map((r) => r.id));
    expect(ids).toEqual([logA]);
  });

  it("sync_app ne lit pas le log d'un autre tenant, même avec un WHERE explicite", async () => {
    const rows = await inTx(tenantA, async (c) => (await c.query('SELECT id FROM sync_logs WHERE id = $1', [logB])).rows);
    expect(rows).toHaveLength(0);
  });

  it('INSERT sans contexte tenant refusé (WITH CHECK)', async () => {
    await expect(inTx(null, (c) => insertLog(c, tenantA))).rejects.toThrow(/row-level security/);
  });

  it("INSERT avec le tenant_id d'un autre tenant refusé (WITH CHECK)", async () => {
    await expect(inTx(tenantA, (c) => insertLog(c, tenantB))).rejects.toThrow(/row-level security/);
  });

  it('INSERT de son propre tenant accepté, puis visible dans la même transaction', async () => {
    const id = randomUUID();
    const rows = await inTx(tenantA, async (c) => {
      await insertLog(c, tenantA, id);
      return (await c.query('SELECT id FROM sync_logs WHERE id = $1', [id])).rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('UPDATE et DELETE refusés à sync_app (append-only)', async () => {
    await expect(
      inTx(tenantA, (c) => c.query(`UPDATE sync_logs SET status_code = 500 WHERE id = $1`, [logA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTx(tenantA, (c) => c.query(`DELETE FROM sync_logs WHERE id = $1`, [logA])),
    ).rejects.toThrow(/permission denied/);
  });

  it('sync_app a exactement SELECT et INSERT sur sync_logs, aucun autre privilège', async () => {
    const res = await pg.pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'sync_app' AND table_schema = 'public' AND table_name = 'sync_logs'
       ORDER BY privilege_type`,
    );
    expect(res.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });});
