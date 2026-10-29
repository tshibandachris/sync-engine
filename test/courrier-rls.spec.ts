import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Courrier RLS — tenant isolation', () => {
  let pg: TestPostgres;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentId = randomUUID();
  const courrierA = randomUUID();
  const courrierB = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();

    const now = Date.now();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, now],
    );
    await pg.pool.query(
      `INSERT INTO courriers
        (id, tenant_id, agent_id, subject, body, confidentiality, status,
         created_at, updated_at, sync_seq, first_sync_seq)
       VALUES
        ($1, $2, $3, 'Courrier A', '', 'interne', 'enregistre', $4, $4, 0, 0),
        ($5, $6, $3, 'Courrier B', '', 'interne', 'enregistre', $4, $4, 0, 0)`,
      [courrierA, tenantA, agentId, now, courrierB, tenantB],
    );
  });

  afterAll(async () => {
    if (pg) await pg.stop();
  });

  it('fails closed when no tenant context is set', async () => {
    const result = await pg.appPool.query('SELECT id FROM courriers');
    expect(result.rows).toEqual([]);
  });

  it('only exposes rows belonging to the transaction tenant', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      const result = await client.query('SELECT id FROM courriers ORDER BY id');
      expect(result.rows.map((row: { id: string }) => row.id)).toEqual([courrierA]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('rejects writes that claim another tenant', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await expect(client.query(
        `INSERT INTO courriers
          (id, tenant_id, agent_id, subject, created_at, updated_at, sync_seq, first_sync_seq)
         VALUES ($1, $2, $3, 'Cross-tenant attempt', $4, $4, 0, 0)`,
        [randomUUID(), tenantB, agentId, Date.now()],
      )).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
