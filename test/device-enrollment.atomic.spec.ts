import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { assertEnrollmentDatabaseIdentity } from '../src/device-enrollment-db-guard.js';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';

describe('Device enrollment atomic proof-of-possession', () => {
  let pg: TestPostgres;
  let service: DeviceEnrollmentService;
  const tenantId = randomUUID();
  const storeId = randomUUID();

  beforeAll(async () => {
    pg = await startTestPostgres();
    service = new DeviceEnrollmentService(pg.appDb as any, pg.enrollmentDb as any);
    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
  }, 120_000);

  afterAll(async () => { await pg?.stop(); });

  async function createCode(code: string, codeTenantId = tenantId) {
    const codeHash = createHash('sha256').update(code).digest('hex');
    await pg.pool.query(
      `INSERT INTO device_pairing_codes
       (tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [codeTenantId, storeId, codeHash, randomUUID()],
    );
  }

  function dto(activationCode: string, fingerprint: string, deviceName = 'Caisse test') {
    const deviceId = randomUUID();
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
      device_id: deviceId,
    })).toString('base64url');
    const signingInput = headerB64 + '.' + payloadB64;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      deviceId,
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
      `SELECT count(*)::int AS count
       FROM device_approval_events
       WHERE tenant_id = $1 AND event_type = 'requested'
         AND to_status = 'pending_approval' AND from_status IS NULL`,
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
    const segments = request.initialProof.split('.');
    const signature = Buffer.from(segments[2], 'base64url');
    signature[0] ^= 0x01;
    segments[2] = signature.toString('base64url');
    request.initialProof = segments.join('.');

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

  it('rejects a direct privileged enrollment call from sync_app with SQLSTATE 42501', async () => {
    const maliciousCall = pg.appPool.query(
      `SELECT * FROM public.register_device_enrollment_with_credential(
        $1::text, $2::uuid, $3::uuid, $4::varchar, $5::varchar,
        $6::jsonb, $7::text, $8::varchar
      )`,
      [
        'a'.repeat(64),
        tenantId,
        randomUUID(),
        'Attacker POS',
        'fp-bad',
        JSON.stringify({}),
        'fake-pem',
        'b'.repeat(43),
      ],
    );

    await expect(maliciousCall).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/permission denied for function register_device_enrollment_with_credential/i),
    });
  });

  it('fails bootstrap identity validation when the enrollment pool connects as sync_app', async () => {
    await expect(assertEnrollmentDatabaseIdentity(pg.appPool)).rejects.toThrow(
      /BOOTSTRAP_SECURITY_ERROR: Device enrollment pool must use a non-superuser login that inherits device_enrollment_executor and is not a member of sync_app/i,
    );
  });

  it('isolates the SECURITY DEFINER enrollment capability from sync_app', async () => {
    const syncExecute = await pg.pool.query(
      `SELECT has_function_privilege('sync_app', 'public.register_device_enrollment_with_credential(text,uuid,uuid,character varying,character varying,jsonb,text,character varying)', 'EXECUTE') AS allowed`,
    );
    const enrollmentExecute = await pg.pool.query(
      `SELECT has_function_privilege('device_enrollment_test', 'public.register_device_enrollment_with_credential(text,uuid,uuid,character varying,character varying,jsonb,text,character varying)', 'EXECUTE') AS allowed`,
    );
    const membership = await pg.pool.query(
      `SELECT pg_has_role('device_enrollment_test', 'sync_app', 'MEMBER') AS is_sync_app_member`,
    );
    expect(syncExecute.rows[0].allowed).toBe(false);
    expect(enrollmentExecute.rows[0].allowed).toBe(true);
    expect(membership.rows[0].is_sync_app_member).toBe(false);
  });

  it('does not grant sync_app direct credential or approval-event writes', async () => {
    const credentialPrivilege = await pg.pool.query(
      `SELECT has_table_privilege('sync_app', 'public.device_credentials', 'INSERT') AS allowed`,
    );
    const deviceInsertPrivilege = await pg.pool.query(
      `SELECT has_table_privilege('sync_app', 'public.devices', 'INSERT') AS allowed`,
    );
    const eventPrivilege = await pg.pool.query(
      `SELECT has_table_privilege('sync_app', 'public.device_approval_events', 'INSERT') AS allowed`,
    );
    expect(credentialPrivilege.rows[0].allowed).toBe(false);
    expect(deviceInsertPrivilege.rows[0].allowed).toBe(false);
    expect(eventPrivilege.rows[0].allowed).toBe(false);
  });
});
