import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device enrollment atomic pairing-code redemption', () => {
  let pg: TestPostgres;
  let service: DeviceEnrollmentService;
  const tenantId = randomUUID();
  const storeId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    service = new DeviceEnrollmentService(pg.appDb as any);
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
  }, 120_000);

  afterAll(async () => { await pg?.stop(); });

  async function createCode(code: string) {
    const codeHash = createHash('sha256').update(code).digest('hex');
    await pg.pool.query(
      `INSERT INTO device_pairing_codes
       (tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [tenantId, storeId, codeHash, randomUUID()],
    );
  }

  const dto = (activationCode: string, deviceName = 'Caisse test') => ({
    activationCode,
    deviceName,
    hardwareInfo: { hostname: 'pos-01', platform: 'win32', arch: 'x64', osRelease: '10.0' },
  });

  it('allows exactly one of two concurrent enrollments to consume a code', async () => {
    const code = 'ED26-89AB';
    await createCode(code);

    const results = await Promise.allSettled([
      service.enrollDevice(dto(code), 'hardware-a'),
      service.enrollDevice(dto(code), 'hardware-b'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    const codes = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(code).digest('hex')],
    );
    const devices = await pg.pool.query(
      'SELECT count(*)::int AS count FROM devices WHERE tenant_id = $1',
      [tenantId],
    );
    expect(codes.rows[0].used_at).not.toBeNull();
    expect(devices.rows[0].count).toBe(1);
  }, 120_000);

  it('rolls back code consumption when device insertion fails', async () => {
    const code = 'ED26-89AC';
    await createCode(code);
    await service.enrollDevice(dto(code), 'same-hardware');

    // A second, valid code cannot create a duplicate device fingerprint.
    const secondCode = 'ED26-89AD';
    await createCode(secondCode);
    await expect(service.enrollDevice(dto(secondCode), 'same-hardware'))
      .rejects.toBeInstanceOf(ConflictException);

    const state = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(secondCode).digest('hex')],
    );
    expect(state.rows[0].used_at).toBeNull();
  }, 120_000);
});
