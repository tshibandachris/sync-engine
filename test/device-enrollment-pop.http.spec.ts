import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { assertRunsAsAppRole } from './helpers/assert-app-role.js';
import { DeviceEnrollmentController } from '../src/device-enrollment.controller.js';
import { DeviceEnrollmentService } from '../src/device-enrollment.service.js';
import { createDeviceEnrollmentThrottleModule } from '../src/device-enrollment.throttle.js';

describe('Initial ES256 proof enrollment (PostgreSQL HTTP integration)', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const actorId = randomUUID();
  const code = 'ABCD-1234';
  const codeHash = createHash('sha256').update(code).digest('hex');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreignPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const foreignPrivateKeyPem = foreignPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function buildProof(options: {
    activationCode?: string;
    fingerprint?: string;
    privateKeyPem?: string;
    jti?: string;
  } = {}) {
    const activationCode = options.activationCode ?? code;
    const fingerprint = options.fingerprint ?? 'fingerprint-integration-1';
    const header = { alg: 'ES256', typ: 'dpop+jwt' };
    const payload = {
      jti: options.jti ?? randomUUID(),
      htm: 'POST',
      htu: '/api/v1/devices/enroll',
      iat: Math.floor(Date.now() / 1000),
      code_hash: createHash('sha256').update(activationCode).digest('base64url'),
      fingerprint,
    };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${h}.${p}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: options.privateKeyPem ?? privateKeyPem,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  async function createPairingCode(value: string) {
    const hash = createHash('sha256').update(value).digest('hex');
    await pg.pool.query(
      `INSERT INTO public.device_pairing_codes
        (id, tenant_id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [randomUUID(), tenantId, storeId, hash, actorId],
    );
    return hash;
  }

  function enroll(options: {
    activationCode?: string;
    fingerprint?: string;
    proof?: string;
    keyPem?: string;
    deviceName?: string;
  } = {}) {
    const activationCode = options.activationCode ?? code;
    const fingerprint = options.fingerprint ?? 'fingerprint-integration-1';
    return request(app.getHttpServer())
      .post('/api/v1/devices/enroll')
      .set('X-Device-Fingerprint', fingerprint)
      .send({
        activationCode,
        deviceName: options.deviceName ?? 'Caisse intégration',
        hardwareInfo: { hostname: 'pos-integration', platform: 'win32', arch: 'x64' },
        publicKeyPem: options.keyPem ?? publicKeyPem,
        initialProof: options.proof ?? buildProof({ activationCode, fingerprint }),
      });
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    await pg.pool.query(
      'INSERT INTO public.tenants (id, first_seen_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, Date.now()],
    );
    await createPairingCode(code);

    const moduleRef = await Test.createTestingModule({
      imports: [createDeviceEnrollmentThrottleModule(null)],
      controllers: [DeviceEnrollmentController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: DeviceEnrollmentService, useFactory: (db: any) => new DeviceEnrollmentService(db), inject: ['DRIZZLE_DB'] },
      ],
    }).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }).compile();

    app = moduleRef.createNestApplication();
    await assertRunsAsAppRole(moduleRef.get('DRIZZLE_DB'));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('rejects a signature forged by a different private key without consuming the pairing code', async () => {
    const proof = buildProof({ privateKeyPem: foreignPrivateKeyPem });
    const response = await enroll({ proof });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_INITIAL_PROOF_SIGNATURE');

    const codeRow = await pg.pool.query(
      'SELECT used_at FROM public.device_pairing_codes WHERE code_hash = $1',
      [codeHash],
    );
    expect(codeRow.rows[0].used_at).toBeNull();
    const devices = await pg.pool.query('SELECT id FROM public.devices WHERE tenant_id = $1', [tenantId]);
    expect(devices.rows).toHaveLength(0);
  });

  it('rejects an altered code_hash binding before touching the database', async () => {
    const proof = buildProof({ activationCode: 'WXYZ-9876' });
    const response = await enroll({ proof });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('PROOF_BINDING_MISMATCH');

    const codeRow = await pg.pool.query(
      'SELECT used_at FROM public.device_pairing_codes WHERE code_hash = $1',
      [codeHash],
    );
    expect(codeRow.rows[0].used_at).toBeNull();
  });

  it('atomically creates a pending device, active credential, requested event and consumes the code', async () => {
    const response = await enroll();
    expect(response.status).toBe(201);
    expect(response.body.data.approvalStatus).toBe('pending_approval');
    expect(response.body.data.deviceId).toBeTruthy();
    expect(response.body.data.credentialId).toBeTruthy();

    const deviceId = response.body.data.deviceId as string;
    const state = await pg.pool.query(
      `SELECT
        (SELECT count(*)::int FROM public.devices WHERE tenant_id = $1 AND id = $2) AS devices,
        (SELECT count(*)::int FROM public.device_credentials WHERE tenant_id = $1 AND device_id = $2 AND status = 'active') AS credentials,
        (SELECT count(*)::int FROM public.device_approval_events WHERE tenant_id = $1 AND device_id = $2 AND event_type = 'requested') AS events,
        (SELECT count(*)::int FROM public.device_proof_nonces WHERE tenant_id = $1 AND device_id = $2) AS nonces`,
      [tenantId, deviceId],
    );
    expect(state.rows[0]).toEqual({ devices: 1, credentials: 1, events: 1, nonces: 1 });

    const device = await pg.pool.query(
      'SELECT approval_status, is_active FROM public.devices WHERE tenant_id = $1 AND id = $2',
      [tenantId, deviceId],
    );
    expect(device.rows[0]).toEqual({ approval_status: 'pending_approval', is_active: true });

    const credential = await pg.pool.query(
      'SELECT algorithm, status, public_key_pem FROM public.device_credentials WHERE tenant_id = $1 AND device_id = $2',
      [tenantId, deviceId],
    );
    expect(credential.rows[0]).toEqual({ algorithm: 'ES256', status: 'active', public_key_pem: publicKeyPem.trim() });

    const pairing = await pg.pool.query(
      'SELECT used_at FROM public.device_pairing_codes WHERE code_hash = $1',
      [codeHash],
    );
    expect(pairing.rows[0].used_at).toBeInstanceOf(Date);
  });

  it('rolls back pairing-code consumption when credential persistence fails', async () => {
    const rollbackCode = 'JKLM-2468';
    const rollbackHash = await createPairingCode(rollbackCode);
    const fingerprint = 'fingerprint-credential-conflict';
    const response = await enroll({ activationCode: rollbackCode, fingerprint });
    expect(response.status).toBe(409);

    const pairing = await pg.pool.query(
      'SELECT used_at FROM public.device_pairing_codes WHERE code_hash = $1',
      [rollbackHash],
    );
    expect(pairing.rows[0].used_at).toBeNull();

    const device = await pg.pool.query(
      'SELECT id FROM public.devices WHERE tenant_id = $1 AND fingerprint = $2',
      [tenantId, fingerprint],
    );
    expect(device.rows).toHaveLength(0);
  });

  it('returns the same device and credential when the exact signed enrollment request is retried', async () => {
    const retryCode = 'MNOP-1357';
    const retryHash = await createPairingCode(retryCode);
    const fingerprint = 'fingerprint-exact-retry';
    const retryPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const retryPublicKeyPem = retryPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const retryPrivateKeyPem = retryPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const proof = buildProof({ activationCode: retryCode, fingerprint, privateKeyPem: retryPrivateKeyPem });
    const first = await enroll({ activationCode: retryCode, fingerprint, proof, keyPem: retryPublicKeyPem });
    const second = await enroll({ activationCode: retryCode, fingerprint, proof, keyPem: retryPublicKeyPem });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.deviceId).toBe(first.body.data.deviceId);
    expect(second.body.data.credentialId).toBe(first.body.data.credentialId);

    const state = await pg.pool.query(
      `SELECT
        (SELECT count(*)::int FROM public.devices WHERE tenant_id = $1 AND fingerprint = $2) AS devices,
        (SELECT count(*)::int FROM public.device_credentials WHERE tenant_id = $1 AND device_id = $3) AS credentials,
        (SELECT count(*)::int FROM public.device_approval_events WHERE tenant_id = $1 AND device_id = $3 AND event_type = 'requested') AS events,
        (SELECT count(*)::int FROM public.device_proof_nonces WHERE tenant_id = $1 AND device_id = $3) AS nonces,
        (SELECT count(*)::int FROM public.device_enrollment_attempts WHERE code_hash = $4) AS receipts`,
      [tenantId, fingerprint, first.body.data.deviceId, retryHash],
    );
    expect(state.rows[0]).toEqual({ devices: 1, credentials: 1, events: 1, nonces: 1, receipts: 1 });
  });

  it('rejects immediate reuse of the consumed activation code', async () => {
    const response = await enroll();
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('CODE_ALREADY_CONSUMED');
  });

  it('rejects an initial proof bound to another method or path', async () => {
    const otherCode = 'EFGH-5678';
    await createPairingCode(otherCode);
    const fingerprint = 'fingerprint-wrong-path';
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      jti: randomUUID(), htm: 'GET', htu: '/wrong/path',
      iat: Math.floor(Date.now() / 1000),
      code_hash: createHash('sha256').update(otherCode).digest('base64url'),
      fingerprint,
    })).toString('base64url');
    const input = `${header}.${payload}`;
    const signature = sign('sha256', Buffer.from(input), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
    const response = await enroll({
      activationCode: otherCode,
      fingerprint,
      proof: `${input}.${signature.toString('base64url')}`,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INITIAL_PROOF_HTM_HTU_MISMATCH');
  });
});
