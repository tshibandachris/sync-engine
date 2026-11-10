import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device security hardening — migration 032', () => {
  let pg: TestPostgres;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  const revokedCredentialId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, Date.now()],
    );
    await pg.pool.query(
      `INSERT INTO devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active)
       VALUES ($1, $2, $4, 'Terminal A', 'hardening-A', '{}'::jsonb, true),
              ($3, $5, $4, 'Terminal B', 'hardening-B', '{}'::jsonb, true)`,
      [deviceA, tenantA, deviceB, randomUUID(), tenantB],
    );
    await pg.pool.query(
      `INSERT INTO device_approval_events
        (tenant_id, device_id, event_type, from_status, to_status, reason)
       VALUES ($1, $2, 'requested', NULL, 'pending_approval', 'fixture'),
              ($3, $4, 'requested', NULL, 'pending_approval', 'fixture')`,
      [tenantA, deviceA, tenantB, deviceB],
    );
    await pg.pool.query(
      `INSERT INTO device_credentials
        (id, tenant_id, device_id, public_key_pem, key_thumbprint, status, revoked_at)
       VALUES ($1, $2, $3, 'revoked-key', 'revoked-thumbprint', 'revoked', now()),
              ($4, $5, $6, 'active-key', 'active-thumbprint', 'active', NULL)`,
      [revokedCredentialId, tenantA, deviceA, randomUUID(), tenantB, deviceB],
    );
  }, 180_000);

  afterAll(async () => {
    if (pg) await pg.stop();
  });

  async function asTenant<T>(
    tenantId: string,
    action: (client: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('T1: sync_app cannot update device approval fields', async () => {
    await expect(asTenant(tenantA, (client) =>
      client.query(
        "UPDATE devices SET approval_status = 'approved', approved_at = now(), approved_by = $1 WHERE id = $2",
        [randomUUID(), deviceA],
      ),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('T2: sync_app cannot insert arbitrary device credentials', async () => {
    await expect(asTenant(tenantA, (client) =>
      client.query(
        `INSERT INTO device_credentials
          (tenant_id, device_id, public_key_pem, key_thumbprint)
         VALUES ($1, $2, 'unverified-key', 'unverified-thumbprint')`,
        [tenantA, deviceA],
      ),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('T3: sync_app cannot delete devices', async () => {
    await expect(asTenant(tenantA, (client) =>
      client.query('DELETE FROM devices WHERE id = $1', [deviceA]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('T4: RLS hides credentials and approval events belonging to another tenant', async () => {
    await asTenant(tenantA, async (client) => {
      const credentials = await client.query(
        'SELECT id FROM device_credentials WHERE tenant_id = $1',
        [tenantB],
      );
      const events = await client.query(
        'SELECT id FROM device_approval_events WHERE tenant_id = $1',
        [tenantB],
      );
      expect(credentials.rows).toHaveLength(0);
      expect(events.rows).toHaveLength(0);
    });
  });

  it('T5: sync_app cannot forge approval audit events', async () => {
    await expect(asTenant(tenantA, (client) =>
      client.query(
        `INSERT INTO device_approval_events
          (tenant_id, device_id, event_type, from_status, to_status, reason)
         VALUES ($1, $2, 'approved', 'pending_approval', 'approved', 'forged approval')`,
        [tenantA, deviceA],
      ),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('T6: a revoked credential cannot be reactivated, even by the owner', async () => {
    await expect(pg.pool.query(
      "UPDATE device_credentials SET status = 'active', revoked_at = NULL WHERE id = $1",
      [revokedCredentialId],
    )).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('IMMUTABLE_RECORD'),
    });
  });

  it('T7: a revoked credential is immutable history', async () => {
    await expect(pg.pool.query(
      "UPDATE device_credentials SET public_key_pem = 'tampered-key' WHERE id = $1",
      [revokedCredentialId],
    )).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('IMMUTABLE_RECORD'),
    });
  });

  it('T8: event type and status transitions must be coherent', async () => {
    const invalidTransitions = [
      ['approved', 'pending_approval', 'revoked'],
      ['rejected', 'approved', 'rejected'],
      ['revoked', 'pending_approval', 'revoked'],
      ['reactivated', 'approved', 'approved'],
      ['requested', 'pending_approval', 'pending_approval'],
    ];
    for (const [eventType, fromStatus, toStatus] of invalidTransitions) {
      await expect(pg.pool.query(
        `INSERT INTO device_approval_events
          (tenant_id, device_id, event_type, from_status, to_status, reason)
         VALUES ($1, $2, $3, $4, $5, 'invalid transition')`,
        [tenantA, deviceA, eventType, fromStatus, toStatus],
      )).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('T9: audit history prevents deletion of its device', async () => {
    await expect(pg.pool.query(
      'DELETE FROM devices WHERE id = $1',
      [deviceA],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('T10: the database trigger rejects a forged approved state even if INSERT is temporarily granted', async () => {
    await pg.pool.query('GRANT INSERT ON public.devices TO sync_app');
    try {
      await expect(asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO devices
            (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active,
             approval_status, approved_at, approved_by)
           VALUES ($1, $2, $3, 'Forged terminal', 'forged-fingerprint',
                   '{}'::jsonb, true, 'approved', now(), $4)`,
          [randomUUID(), tenantA, randomUUID(), randomUUID()],
        ),
      )).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('SECURITY_VIOLATION'),
      });
    } finally {
      await pg.pool.query('REVOKE INSERT ON public.devices FROM sync_app');
    }
  });

  it('T12: the database trigger rejects approval metadata even if INSERT is temporarily granted', async () => {
    await pg.pool.query('GRANT INSERT ON public.devices TO sync_app');
    try {
      await expect(asTenant(tenantA, (client) =>
        client.query(
          `INSERT INTO devices
            (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active,
             approval_status, approved_at)
           VALUES ($1, $2, $3, 'Forged metadata terminal', 'forged-metadata',
                   '{}'::jsonb, true, 'pending_approval', now())`,
          [randomUUID(), tenantA, randomUUID()],
        ),
      )).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('SECURITY_VIOLATION'),
      });
    } finally {
      await pg.pool.query('REVOKE INSERT ON public.devices FROM sync_app');
    }
  });

  it('T11: an active terminal remains pending, not approved', async () => {
    const result = await pg.pool.query(
      'SELECT is_active, approval_status, approved_at, approved_by FROM devices WHERE id = $1',
      [deviceA],
    );
    expect(result.rows[0]).toMatchObject({
      is_active: true,
      approval_status: 'pending_approval',
      approved_at: null,
      approved_by: null,
    });
  });
});
