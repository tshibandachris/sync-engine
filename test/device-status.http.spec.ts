import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { startTestPostgres, type TestPostgres } from './helpers/testcontainers-pg.js';
import { DeviceStatusController } from '../src/device-status.controller.js';
import { DeviceStatusService } from '../src/device-status.service.js';
import { DeviceProofGuard } from '../src/auth/device-proof.guard.js';
import { JwtAuthGuard } from '../src/jwt.guard.js';
import { TEST_JWT_SECRET, createTestJwtService, signAgentToken } from './helpers/jwt.js';

describe('GET /api/v1/devices/status — proof of possession', () => {
  let pg: TestPostgres;
  let app: INestApplication;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentA = randomUUID();
  const pendingId = randomUUID();
  const approvedId = randomUUID();
  const rejectedId = randomUUID();
  const revokedId = randomUUID();
  const inactiveId = randomUUID();
  const foreignId = randomUUID();
  const jwt = createTestJwtService();
  const tokenA = signAgentToken(agentA, jwt, tenantA);
  const keys = new Map<string, { privateKey: string; publicKey: string }>();

  function keyPair() {
    return generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }

  function makeProof(deviceId: string, privateKey: string, token = tokenA) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      jti: randomUUID(),
      htm: 'GET',
      htu: '/api/v1/devices/status',
      iat: Math.floor(Date.now() / 1000),
      ath: createHash('sha256').update(token, 'utf8').digest('base64url'),
    })).toString('base64url');
    const signingInput = header + '.' + payload;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return signingInput + '.' + signature.toString('base64url');
  }

  function headers(deviceId: string, token = tokenA, privateKey = keys.get(deviceId)!.privateKey) {
    return {
      Authorization: 'Bearer ' + token,
      'X-Device-Id': deviceId,
      'X-Device-Proof': makeProof(deviceId, privateKey, token),
    };
  }

  beforeAll(async () => {
    pg = await startTestPostgres();
    for (const id of [pendingId, approvedId, rejectedId, revokedId, inactiveId, foreignId]) {
      keys.set(id, keyPair());
    }

    await pg.pool.query(
      'INSERT INTO tenants (id, first_seen_at) VALUES ($1, $3), ($2, $3) ON CONFLICT (id) DO NOTHING',
      [tenantA, tenantB, Date.now()],
    );
    await pg.pool.query(
      `INSERT INTO devices
        (id, tenant_id, store_id, name, fingerprint, hardware_info, is_active, approval_status, approved_at, approved_by)
       VALUES
        ($1, $2, $7, 'Pending', $8, '{}', true, 'pending_approval', NULL, NULL),
        ($3, $2, $7, 'Approved', $9, '{}', true, 'approved', now(), $10),
        ($4, $2, $7, 'Rejected', $11, '{}', true, 'rejected', NULL, NULL),
        ($5, $2, $7, 'Revoked', $12, '{}', true, 'revoked', now(), $10),
        ($6, $2, $7, 'Inactive', $13, '{}', false, 'approved', now(), $10),
        ($14, $15, $7, 'Foreign', $16, '{}', true, 'approved', now(), $10)`,
      [
        pendingId, tenantA, approvedId, rejectedId, revokedId, inactiveId,
        randomUUID(), 'fingerprint-' + pendingId, 'fingerprint-' + approvedId,
        agentA, 'fingerprint-' + rejectedId, 'fingerprint-' + revokedId,
        'fingerprint-' + inactiveId, foreignId, tenantB, 'fingerprint-' + foreignId,
      ],
    );

    for (const id of [pendingId, approvedId, rejectedId, revokedId, inactiveId, foreignId]) {
      const isRevoked = id === revokedId;
      const tenantId = id === foreignId ? tenantB : tenantA;
      const pair = keys.get(id)!;
      await pg.pool.query(
        `INSERT INTO device_credentials
          (tenant_id, device_id, public_key_pem, key_thumbprint, status, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          id,
          pair.publicKey,
          'thumbprint-' + id,
          isRevoked ? 'revoked' : 'active',
          isRevoked ? new Date() : null,
        ],
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({
        secret: TEST_JWT_SECRET,
        signOptions: { expiresIn: '30d' },
      })],
      controllers: [DeviceStatusController],
      providers: [
        { provide: 'DRIZZLE_DB', useValue: pg.appDb },
        { provide: DeviceStatusService, useFactory: (d: any) => new DeviceStatusService(d), inject: ['DRIZZLE_DB'] },
        JwtAuthGuard,
        DeviceProofGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pg) await pg.stop();
  });

  it('returns pending approval only to the terminal possessing its enrolled key', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(pendingId));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      deviceId: pendingId,
      tenantId: tenantA,
      approvalStatus: 'pending_approval',
      isActive: true,
      hasActiveCredential: true,
    });
  });

  it('rejects a status lookup signed by another device key', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(pendingId, tokenA, keys.get(approvedId)!.privateKey));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_DEVICE_SIGNATURE');
  });

  it('returns approved state and reports active credential readiness separately', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(approvedId));

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('approved');
    expect(response.body.isActive).toBe(true);
    expect(response.body.hasActiveCredential).toBe(true);
  });

  it.each([
    [rejectedId, 'rejected'],
    [revokedId, 'revoked'],
  ])('returns the explicit %s state with a proof from that terminal', async (deviceId, approvalStatus) => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(deviceId));

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe(approvalStatus);
  });

  it('reports inactive devices separately from their approval status', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(inactiveId));

    expect(response.status).toBe(200);
    expect(response.body.approvalStatus).toBe('approved');
    expect(response.body.isActive).toBe(false);
  });

  it('does not reveal a device belonging to another tenant', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set(headers(foreignId));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('requires an authenticated agent, device identity and proof of possession', async () => {
    const noToken = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('X-Device-Id', pendingId);
    expect(noToken.status).toBe(401);

    const noDevice = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA);
    expect(noDevice.status).toBe(401);
    expect(noDevice.body.code).toBe('DEVICE_IDENTITY_MISSING');

    const noProof = await request(app.getHttpServer())
      .get('/api/v1/devices/status')
      .set('Authorization', 'Bearer ' + tokenA)
      .set('X-Device-Id', pendingId);
    expect(noProof.status).toBe(401);
    expect(noProof.body.code).toBe('DEVICE_PROOF_MISSING');
  });
});
