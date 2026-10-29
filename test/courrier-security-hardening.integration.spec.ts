import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { CourrierService } from '../src/courrier.service.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const AGENT_ID = '20000000-0000-4000-8000-000000000002';
const SERVICE_ID = '30000000-0000-4000-8000-000000000001';

let pg: TestPostgres;
let courrierId: string;

async function seedCourrier(pool: Pool, status = 'enregistre'): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO courriers
       (id, tenant_id, agent_id, subject, body, confidentiality, status,
        created_at, updated_at, sync_seq, first_sync_seq)
     VALUES ($1, $2, $3, 'Security test', '', 'interne', $4,
             $5, $5, 1, 1)`,
    [id, TENANT_ID, ACTOR_ID, status, Date.now()],
  );
  return id;
}


async function asTenant<T>(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [TENANT_ID],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pg = await startTestPostgres();
  await pg.pool.query(
    'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [TENANT_ID, Date.now()],
  );
  courrierId = await seedCourrier(pg.pool);
});

afterAll(async () => {
  if (pg) await pg.stop();
});

describe('Courrier security hardening (PostgreSQL integration)', () => {
  it('serializes competing stale transitions and accepts exactly one winner', async () => {
    const id = await seedCourrier(pg.pool, 'affecte');
    await pg.pool.query(
      `INSERT INTO courrier_assignments
         (tenant_id, courrier_id, agent_id, service_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, NULL, $4, $5)`,
      [TENANT_ID, id, AGENT_ID, ACTOR_ID, Date.now()],
    );
    const service = new CourrierService(pg.appDb, {
      delete: async () => undefined,
      listByPrefix: async () => [],
      presignPut: async () => ({ url: 'https://example.invalid/upload', expiresIn: 900 }),
      presignGet: async () => ({ url: 'https://example.invalid/download', expiresIn: 3600 }),
      head: async () => ({ exists: false }),
    } as any);
    const actor = {
      tenantId: TENANT_ID,
      agentId: ACTOR_ID,
      permissions: ['courrier:read', 'courrier:manage'],
    };
    const results = await Promise.allSettled([
      service.transition(actor, id, 'en_cours'),
      service.transition(actor, id, 'en_cours'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const final = await pg.pool.query(
      'SELECT status FROM courriers WHERE tenant_id = $1 AND id = $2',
      [TENANT_ID, id],
    );
    expect(final.rows[0].status).toBe('en_cours');
  });

  it('rejects UPDATE and DELETE against the audit log for the runtime role', async () => {
    await asTenant(pg.appPool, async (client) => {
      await client.query(
        `INSERT INTO courrier_audit_logs
           (tenant_id, courrier_id, actor_id, action, metadata, created_at)
         VALUES ($1, $2, $3, 'security.test', '{}'::jsonb, $4)`,
        [TENANT_ID, courrierId, ACTOR_ID, Date.now()],
      );
    });

    const inserted = await pg.pool.query(
      `SELECT id FROM courrier_audit_logs
       WHERE tenant_id = $1 AND courrier_id = $2 AND action = 'security.test'
       ORDER BY created_at DESC LIMIT 1`,
      [TENANT_ID, courrierId],
    );
    expect(inserted.rows).toHaveLength(1);
    const auditId = inserted.rows[0].id;

    await expect(asTenant(pg.appPool, (client) =>
      client.query(
        'UPDATE courrier_audit_logs SET action = $3 WHERE tenant_id = $1 AND id = $2',
        [TENANT_ID, auditId, 'tampered'],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    await expect(asTenant(pg.appPool, (client) =>
      client.query(
        'DELETE FROM courrier_audit_logs WHERE tenant_id = $1 AND id = $2',
        [TENANT_ID, auditId],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    const unchanged = await pg.pool.query(
      'SELECT action FROM courrier_audit_logs WHERE tenant_id = $1 AND id = $2',
      [TENANT_ID, auditId],
    );
    expect(unchanged.rows[0].action).toBe('security.test');
  });

  it('rejects an assignment that supplies both agent_id and service_id via CHECK', async () => {
    await expect(pg.pool.query(
      `INSERT INTO courrier_assignments
         (tenant_id, courrier_id, agent_id, service_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_ID, courrierId, AGENT_ID, SERVICE_ID, ACTOR_ID, Date.now()],
    )).rejects.toMatchObject({ code: '23514', constraint: 'courrier_assignments_exactly_one_target' });
  });

  it('rejects an assignment that supplies neither agent_id nor service_id via CHECK', async () => {
    await expect(pg.pool.query(
      `INSERT INTO courrier_assignments
         (tenant_id, courrier_id, agent_id, service_id, assigned_by, assigned_at)
       VALUES ($1, $2, NULL, NULL, $3, $4)`,
      [TENANT_ID, courrierId, ACTOR_ID, Date.now()],
    )).rejects.toMatchObject({ code: '23514', constraint: 'courrier_assignments_exactly_one_target' });
  });
});
