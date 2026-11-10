import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device enrollment atomic proof-of-possession', () => {
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

  async function createCode(code: string, codeTenantId = tenantId) {
    const codeHash = createHash('sha256').update(code).digest('hex');
    await pg.pool.query(
      \`INSERT INTO device_pairing_codes
       (tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')\`,
      [codeTenantId, storeId, codeHash, randomUUID()],
    );
  }

  function dto(activationCode: string, fingerprint: string, deviceName = 'Caisse test') {
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({
      jti: randomUUID(),
      htm: 'POST',
      htu: '/api/v1/devices/enroll',
      iat: Math.floor(Date.now() / 1000),
      code_hash: createHash('sha256').update(activationCode).digest('base64url'),
      fingerprint,
    })).toString('base64url');
    const signingInput = headerB64 + '.' + payloadB64;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      activationCode,
      deviceName,
      fingerprint,
      hardwareInfo: { hostname: 'pos-01', platform: 'win32', arch: 'x64', osRelease: '10.0' },
      publicKeyPem: pair.publicKey,
      initialProof: signingInput + '.' + signature.toString('base64url'),
    };
  }

  it('allows exactly one concurrent enrollment and persists one credential plus one request event', async () => {
    const code = 'ED26-89AB';
    await createCode(code);

    const results = await Promise.allSettled([
      service.enrollDevice(dto(code, 'hardware-a'), 'hardware-a', tenantId),
      service.enrollDevice(dto(code, 'hardware-b'), 'hardware-b', tenantId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    const codeState = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(code).digest('hex')],
    );
    const devices = await pg.pool.query(
      'SELECT count(*)::int AS count FROM devices WHERE tenant_id = $1',
      [tenantId],
    );
    const credentials = await pg.pool.query(
      'SELECT count(*)::int AS count FROM device_credentials WHERE tenant_id = $1 AND status = $2',
      [tenantId, 'active'],
    );
    const audit = await pg.pool.query(
      \`SELECT count(*)::int AS count
       FROM device_approval_events
       WHERE tenant_id = $1 AND event_type = 'requested'
         AND to_status = 'pending_approval' AND from_status IS NULL\`,
      [tenantId],
    );

    expect(codeState.rows[0].used_at).not.toBeNull();
    expect(devices.rows[0].count).toBe(1);
    expect(credentials.rows[0].count).toBe(1);
    expect(audit.rows[0].count).toBe(1);
  }, 120_000);

  it('does not consume the pairing code when proof of possession is invalid', async () => {
    const code = 'ED26-89AC';
    await createCode(code);
    const request = dto(code, 'hardware-invalid');
    request.initialProof = request.initialProof.slice(0, -2) + 'aa';

    await expect(service.enrollDevice(request, 'hardware-invalid', tenantId))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const state = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(code).digest('hex')],
    );
    expect(state.rows[0].used_at).toBeNull();
  }, 120_000);

  it('rolls back code consumption when device creation fails on duplicate fingerprint', async () => {
    const firstCode = 'ED26-89AD';
    await createCode(firstCode);
    await service.enrollDevice(dto(firstCode, 'same-hardware'), 'same-hardware', tenantId);

    const secondCode = 'ED26-89AE';
    await createCode(secondCode);
    await expect(service.enrollDevice(dto(secondCode, 'same-hardware'), 'same-hardware', tenantId))
      .rejects.toBeInstanceOf(ConflictException);

    const state = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(secondCode).digest('hex')],
    );
    expect(state.rows[0].used_at).toBeNull();
  }, 120_000);

  it('rejects a valid proof when the pairing code belongs to another tenant', async () => {
    const otherTenant = randomUUID();
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2)',
      [otherTenant, Date.now()],
    );
    const code = 'ED26-89AF';
    await createCode(code, otherTenant);

    await expect(service.enrollDevice(dto(code, 'cross-tenant-hardware'), 'cross-tenant-hardware', tenantId))
      .rejects.toBeInstanceOf(BadRequestException);

    const state = await pg.pool.query(
      'SELECT used_at FROM device_pairing_codes WHERE code_hash = $1',
      [createHash('sha256').update(code).digest('hex')],
    );
    expect(state.rows[0].used_at).toBeNull();
  }, 120_000);

  it('does not grant sync_app direct credential or approval-event writes', async () => {
    const credentialPrivilege = await pg.pool.query(
      \`SELECT has_table_privilege('sync_app', 'public.device_credentials', 'INSERT') AS allowed\`,
    );
    const eventPrivilege = await pg.pool.query(
      \`SELECT has_table_privilege('sync_app', 'public.device_approval_events', 'INSERT') AS allowed\`,
    );
    expect(credentialPrivilege.rows[0].allowed).toBe(false);
    expect(eventPrivilege.rows[0].allowed).toBe(false);
  });
});
