import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device approval foundation — migration 031', () => {
  let pg: TestPostgres;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  const actorId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, Date.now()],
    );
    await pg.pool.query(
      `INSERT INTO devices (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active)
       VALUES ($1, $2, $4, 'Terminal A', 'fingerprint-A', '{}'::jsonb, true),
              ($3, $5, $4, 'Terminal B', 'fingerprint-B', '{}'::jsonb, true)`,
      [deviceA, tenantA, deviceB, randomUUID(), tenantB],
    );
  }, 180_000);

  afterAll(async () => {
    if (pg) await pg.stop();
  });

  it('defaults existing-style active devices to pending approval, never approved', async () => {
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

  it('enforces one active credential per device and retains revoked history', async () => {
    const firstId = randomUUID();
    await pg.pool.query(
      `INSERT INTO device_credentials
        (id, tenant_id, device_id, public_key_pem, key_thumbprint)
       VALUES ($1, $2, $3, 'test-public-key', 'thumbprint-1')`,
      [firstId, tenantA, deviceA],
    );

    await expect(pg.pool.query(
      `INSERT INTO device_credentials
        (tenant_id, device_id, public_key_pem, key_thumbprint)
       VALUES ($1, $2, 'another-public-key', 'thumbprint-2')`,
      [tenantA, deviceA],
    )).rejects.toThrow();

    await pg.pool.query(
      `UPDATE device_credentials
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1`,
      [firstId],
    );
    await pg.pool.query(
      `INSERT INTO device_credentials
        (tenant_id, device_id, public_key_pem, key_thumbprint)
       VALUES ($1, $2, 'rotated-public-key', 'thumbprint-2')`,
      [tenantA, deviceA],
    );
    const result = await pg.pool.query(
      'SELECT status FROM device_credentials WHERE tenant_id = $1 AND device_id = $2 ORDER BY created_at, id',
      [tenantA, deviceA],
    );
    expect(result.rows.map((row: { status: string }) => row.status)).toEqual(['revoked', 'active']);
  });

  it('rejects a credential whose tenant does not own the referenced device', async () => {
    await expect(pg.pool.query(
      `INSERT INTO device_credentials
        (tenant_id, device_id, public_key_pem, key_thumbprint)
       VALUES ($1, $2, 'cross-tenant-key', 'cross-tenant-thumbprint')`,
      [tenantB, deviceA],
    )).rejects.toThrow();
  });

  it('keeps approval events tenant-isolated and append-only for sync_app', async () => {
    await pg.pool.query(
      `INSERT INTO device_approval_events
        (tenant_id, device_id, actor_id, event_type, to_status, reason)
       VALUES ($1, $2, $3, 'requested', 'pending_approval', 'Initial registration')`,
      [tenantA, deviceA, actorId],
    );

    expect((await pg.appPool.query('SELECT id FROM device_approval_events')).rows).toHaveLength(0);

    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      const visible = await client.query(
        'SELECT device_id FROM device_approval_events ORDER BY created_at',
      );
      expect(visible.rows.map((row: { device_id: string }) => row.device_id)).toEqual([deviceA]);

      await expect(client.query(
        'UPDATE device_approval_events SET reason = $1 WHERE device_id = $2',
        ['tampered', deviceA],
      )).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects approval metadata that is inconsistent with the device state', async () => {
    await expect(pg.pool.query(
      `UPDATE devices SET approval_status = 'approved'
       WHERE id = $1`,
      [deviceB],
    )).rejects.toThrow();
  });
});
