import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestPostgres } from './helpers/testcontainers-pg.js';
import { startTestPostgres } from './helpers/testcontainers-pg.js';
import { DeviceProofNonceRepository } from '../src/auth/device-proof-nonce.repository.js';
import { SyncMaintenanceService } from '../src/sync-maintenance.service.js';

describe('Device proof replay registry (PostgreSQL / RLS)', () => {
  let pg: TestPostgres;
  let repository: DeviceProofNonceRepository;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const deviceA = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    repository = new DeviceProofNonceRepository(pg.appDb);

    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3)',
      [tenantA, tenantB, Date.now()],
    );
    await pg.pool.query(
      `INSERT INTO devices (
         id, tenant_id, store_id, name, fingerprint, hardware_info,
         is_active, approval_status
       ) VALUES ($1, $2, $3, 'Replay test terminal', $4, '{}'::jsonb, true, 'pending_approval')`,
      [deviceA, tenantA, randomUUID(), `replay-test-${deviceA}`],
    );
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('records a nonce once for its tenant and device', async () => {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + 120_000);

    await expect(
      repository.recordNonceIfUnseen(tenantA, deviceA, jti, expiresAt),
    ).resolves.toBe(true);
  });

  it('rejects a duplicate jti without changing the original row', async () => {
    const jti = randomUUID();
    const firstExpiry = new Date(Date.now() + 120_000);
    const laterExpiry = new Date(Date.now() + 240_000);

    expect(await repository.recordNonceIfUnseen(tenantA, deviceA, jti, firstExpiry)).toBe(true);
    expect(await repository.recordNonceIfUnseen(tenantA, deviceA, jti, laterExpiry)).toBe(false);

    const row = await pg.pool.query(
      'SELECT expires_at FROM public.device_proof_nonces WHERE tenant_id = $1 AND device_id = $2 AND jti = $3',
      [tenantA, deviceA, jti],
    );
    expect(new Date(row.rows[0].expires_at).getTime()).toBe(firstExpiry.getTime());
  });

  it('allows exactly one winner for concurrent submissions of the same jti', async () => {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + 120_000);

    const results = await Promise.all([
      repository.recordNonceIfUnseen(tenantA, deviceA, jti, expiresAt),
      repository.recordNonceIfUnseen(tenantA, deviceA, jti, expiresAt),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps nonce rows invisible to another tenant under FORCE RLS', async () => {
    const jti = randomUUID();
    expect(await repository.recordNonceIfUnseen(
      tenantA,
      deviceA,
      jti,
      new Date(Date.now() + 120_000),
    )).toBe(true);

    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantB],
      );
      const result = await client.query(
        'SELECT jti FROM public.device_proof_nonces WHERE jti = $1',
        [jti],
      );
      expect(result.rows).toHaveLength(0);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('blocks cross-tenant inserts through the RLS WITH CHECK policy', async () => {
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantB],
      );
      await expect(client.query(
        `INSERT INTO public.device_proof_nonces (tenant_id, device_id, jti, expires_at)
         VALUES ($1, $2, $3, now() + interval '2 minutes')`,
        [tenantA, deviceA, randomUUID()],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it('denies UPDATE and DELETE to sync_app', async () => {
    const jti = randomUUID();
    expect(await repository.recordNonceIfUnseen(
      tenantA,
      deviceA,
      jti,
      new Date(Date.now() + 120_000),
    )).toBe(true);

    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantA],
      );
      await expect(client.query(
        'UPDATE public.device_proof_nonces SET expires_at = now() WHERE jti = $1',
        [jti],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantA],
      );
      await expect(client.query(
        'DELETE FROM public.device_proof_nonces WHERE jti = $1',
        [jti],
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it('purges only expired nonces for the requested tenant in bounded batches', async () => {
    const maintenance = new SyncMaintenanceService(pg.maintenanceDb);
    const owner = await pg.pool.query(`
      SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             pg_catalog.has_table_privilege(r.oid, 'public.device_proof_nonces', 'SELECT') AS can_select,
             pg_catalog.has_table_privilege(r.oid, 'public.device_proof_nonces', 'DELETE') AS can_delete,
             pg_catalog.has_table_privilege(r.oid, 'public.device_proof_nonces', 'UPDATE') AS can_update,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_class c
               WHERE c.relowner = r.oid AND c.relname = 'device_proof_nonces'
             ) AS owns_nonce_table,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid
             ) AS has_memberships
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'public.purge_expired_device_proof_nonces(uuid,integer)'::regprocedure
    `);
    expect(owner.rows[0]).toMatchObject({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      can_select: true,
      can_delete: true,
      can_update: false,
      owns_nonce_table: false,
      has_memberships: false,
    });
    const expired = randomUUID();
    const live = randomUUID();
    const otherTenantExpired = randomUUID();

    await repository.recordNonceIfUnseen(tenantA, deviceA, expired, new Date(Date.now() - 60_000));
    await repository.recordNonceIfUnseen(tenantA, deviceA, live, new Date(Date.now() + 120_000));

    const otherDevice = randomUUID();
    await pg.pool.query(
      `INSERT INTO devices (
         id, tenant_id, store_id, name, fingerprint, hardware_info,
         is_active, approval_status
       ) VALUES ($1, $2, $3, 'Other tenant replay test', $4, '{}'::jsonb, true, 'pending_approval')`,
      [otherDevice, tenantB, randomUUID(), `replay-test-${otherDevice}`],
    );
    await repository.recordNonceIfUnseen(tenantB, otherDevice, otherTenantExpired, new Date(Date.now() - 60_000));

    const appClient = await pg.appPool.connect();
    try {
      await appClient.query('BEGIN');
      await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await expect(appClient.query(
        'DELETE FROM public.device_proof_nonces WHERE tenant_id = $1',
        [tenantA],
      )).rejects.toMatchObject({ code: '42501' });
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    const mismatchedContext = await pg.maintenancePool.connect();
    try {
      await mismatchedContext.query('BEGIN');
      await mismatchedContext.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await expect(mismatchedContext.query(
        'SELECT public.purge_expired_device_proof_nonces($1::uuid, 1)',
        [tenantB],
      )).rejects.toMatchObject({ code: '42501' });
      await mismatchedContext.query('ROLLBACK');
    } finally {
      mismatchedContext.release();
    }

    await expect(maintenance.purgeExpiredDeviceProofNonces(tenantA, 1)).resolves.toEqual({ deleted: 1 });
    const remaining = await pg.pool.query(
      'SELECT tenant_id, jti FROM public.device_proof_nonces WHERE jti = ANY($1::uuid[]) ORDER BY jti',
      [[expired, live, otherTenantExpired]],
    );
    expect(remaining.rows).toHaveLength(2);
    expect(remaining.rows.map((row) => row.jti)).toContain(live);
    expect(remaining.rows.map((row) => row.jti)).toContain(otherTenantExpired);
  });

  it('rejects unsafe nonce purge batch sizes', async () => {
    const maintenance = new SyncMaintenanceService(pg.maintenanceDb);
    await expect(maintenance.purgeExpiredDeviceProofNonces(tenantA, 0)).rejects.toThrow(/batchSize/);
    await expect(maintenance.purgeExpiredDeviceProofNonces(tenantA, 10001)).rejects.toThrow(/batchSize/);
  });

  it('rejects malformed UUID inputs before reaching PostgreSQL', async () => {
    await expect(
      repository.recordNonceIfUnseen(tenantA, deviceA, 'not-a-uuid', new Date()),
    ).rejects.toThrow(/valid UUIDs/);
  });
});
