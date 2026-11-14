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

async function expectMaintenanceFunctionToReject(
  tenantId: string,
  statement: string,
  pattern: RegExp,
): Promise<void> {
  const client = await pg.maintenancePool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await expect(client.query(statement, [tenantId])).rejects.toThrow(pattern);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('database-enforced retention floors (migration 043)', () => {
  it('rejects idempotency and resolved-conflict TTLs below seven days', async () => {
    const tenantId = randomUUID();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await expectMaintenanceFunctionToReject(
      tenantId,
      'SELECT public.purge_sync_tables(0, 0)',
      /7 days/,
    );
  });

  it('rejects tombstone TTLs below thirty days', async () => {
    const tenantId = randomUUID();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await expectMaintenanceFunctionToReject(
      tenantId,
      'SELECT public.purge_tenant_tombstones($1::uuid, 29)',
      /30 days/,
    );
  });

  it('rejects pending-attachment TTLs below one day', async () => {
    const tenantId = randomUUID();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await expectMaintenanceFunctionToReject(
      tenantId,
      'SELECT public.purge_tenant_pending_attachments($1::uuid, 0)',
      /1 day/,
    );
  });
});
