import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestPostgres } from './helpers/testcontainers-pg.js';
import { startTestPostgres } from './helpers/testcontainers-pg.js';
import { DeviceProofNonceRepository } from '../src/auth/device-proof-nonce.repository.js';

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

  it('rejects malformed UUID inputs before reaching PostgreSQL', async () => {
    await expect(
      repository.recordNonceIfUnseen(tenantA, deviceA, 'not-a-uuid', new Date()),
    ).rejects.toThrow(/valid UUIDs/);
  });
});
